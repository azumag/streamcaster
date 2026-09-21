import asyncio
import json
from pathlib import Path
import socket
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiohttp import ClientSession, WSServerHandshakeError, WSMsgType, web
from engine import Engine, Presets, angle_lerp
from osc_codec import encode, decode
from urllib.parse import urlsplit
from server import Config, ENGINE, Feedback, create_app, parse_message, response_headers

PUBLIC = 'https://camera.example.ts.net:8443'


class CodecTests(unittest.TestCase):
    def test_known_pose_wire_format(self):
        data = encode('/usercamera/Pose', [1,2,3,4,5,6], 'ffffff')
        self.assertEqual(data, b'/usercamera/Pose\0\0\0\0' + b',ffffff\0' + struct.pack('>6f',1,2,3,4,5,6))
        self.assertEqual(decode(data), ('/usercamera/Pose',[1,2,3,4,5,6],'ffffff'))

    def test_scalars(self):
        for value, kind in [(2,'i'),(6,'i'),(45.0,'f'),(True,'T'),(False,'F')]:
            self.assertEqual(decode(encode('/x',[value],kind)),('/x',[value],kind))

    def test_bad_packets(self):
        bad = [b'',b'abc',b'\0'*8,b'#bundle\0'+b'\0'*8,
               b'/x\0\0,f\0\0'+struct.pack('>f',float('nan')),
               b'/x\0x,T\0\0', b'/x\0\0,fff\0\0\0\0', b'/x\0\0,s\0\0abc\0',
               encode('/x',[1],'i')+b'\0'*4]
        for data in bad:
            with self.subTest(data=data), self.assertRaises(ValueError): decode(data)

    def test_bad_json(self):
        for value in ('[]','null','{"op":"set","value":NaN}','{"x":Infinity}'):
            with self.assertRaises(ValueError): parse_message(value)


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = 100.0
        self.sent = []
        self.store = Presets(Path(self.temp.name)/'presets.json')
        self.engine = Engine(lambda *args:self.sent.append(args), self.store,
                             enable_pose=True, clock=lambda:self.now)
        self.engine.receive('/usercamera/Pose',[10,2,20,0,0,0],'ffffff')
        self.engine.receive('/usercamera/Zoom',[45.0],'f')
        self.engine.dispatch('a',{'op':'claim'})
        self.engine.dispatch('a',{'op':'arm'})
    def tearDown(self): self.temp.cleanup()
    def command(self, **kwargs): self.engine.dispatch('a',kwargs)
    def step(self, dt=1/30): self.now += dt; self.engine.tick(dt)
    def idle(self, seconds, dt=0.1):
        # Hold the lease open while no camera feedback arrives at all.
        for _ in range(int(seconds/dt)):
            self.now += dt; self.command(op='heartbeat'); self.engine.tick(dt)

    def test_start_does_not_move_camera(self): self.assertEqual(self.sent,[])
    def test_mode_and_boolean_typetags(self):
        for name, value, kind in [('Mode',6,'i'),('Zoom',55.0,'f'),('Streaming',True,'T'),('Streaming',False,'F')]:
            self.command(op='set',name=name,value=value)
            self.assertEqual(self.sent[-1],('/usercamera/'+name,[value],kind))
    def test_invalid_setting_values(self):
        for name,value in [('Mode',True),('Mode',2.0),('Mode',5),('Zoom',float('inf')),('Zoom',151),('Zoom','45'),('SmoothMovement',1),('input/Vertical',1),('Pose',[0]*6)]:
            with self.subTest(name=name,value=value), self.assertRaises(ValueError): self.command(op='set',name=name,value=value)
        self.assertFalse(self.sent)
    def test_lease_is_exclusive(self):
        with self.assertRaises(ValueError): self.engine.dispatch('b',{'op':'claim'})
        with self.assertRaises(ValueError): self.engine.dispatch('b',{'op':'set','name':'Mode','value':2})
    def test_any_authenticated_operator_can_stop(self):
        self.engine.dispatch('b',{'op':'stop'})
        self.assertFalse(self.engine.armed)
    def test_expired_lease_rejects_commands_before_tick(self):
        self.now += 1.6
        with self.assertRaises(ValueError): self.command(op='set',name='Zoom',value=50)
        self.assertIsNone(self.engine.owner)
        self.assertFalse(self.sent)
    def test_new_owner_never_inherits_motion(self):
        self.command(op='motion',axes=[1,0,0,0,0])
        self.now += 1.6
        self.engine.dispatch('b',{'op':'claim'})
        self.assertFalse(self.engine.armed)
        self.assertEqual(self.engine.axes,[0]*5)
    def test_motion_is_smoothed_and_world_relative(self):
        self.engine.receive('/usercamera/Pose',[10,2,20,0,90,0],'ffffff')
        self.command(op='motion',axes=[0,1,0,0,0],speed=1)
        self.step()
        self.assertGreater(self.engine.pose[0],10)
        self.assertLess(self.engine.pose[0],10+1/30)
        self.assertAlmostEqual(self.engine.pose[2],20)
        self.assertEqual(self.sent[-1][2],'ffffff')
    def test_release_stops_without_drift(self):
        self.command(op='motion',axes=[1,0,0,0,0]); self.step()
        self.command(op='motion',axes=[0]*5); count=len(self.sent)
        self.step(); self.assertEqual(len(self.sent),count)
    def test_input_deadman(self):
        self.command(op='motion',axes=[1,0,0,0,0]); self.step()
        count=len(self.sent); self.now += 0.5; self.engine.tick(1/30)
        self.assertEqual(len(self.sent),count)
        self.assertEqual(self.engine.velocity,[0]*5)
    def test_disconnect_disarms(self):
        self.engine.release('a'); self.assertIsNone(self.engine.owner)
        self.assertFalse(self.engine.armed)
    def test_stalled_loop_disarms(self):
        self.command(op='motion',axes=[1,0,0,0,0]); self.step(0.3)
        self.assertFalse(self.engine.armed); self.assertFalse(self.sent)
    def test_stalled_loop_while_still_keeps_arm(self):
        # A hiccup cannot invalidate a position nothing was moving.
        self.step(0.3)
        self.assertTrue(self.engine.armed)
    def test_idle_does_not_overwrite_the_reason(self):
        self.engine.reason='Pose feedback stale; check VRChat'
        self.idle(1)
        self.assertEqual(self.engine.reason,'Pose feedback stale; check VRChat')
    def test_lost_contact_is_reported_to_the_operator(self):
        self.assertFalse(self.engine.state()['contactLost'])
        for _ in range(60):  # Input held while VRChat never echoes back.
            self.now += 0.1
            self.command(op='heartbeat')
            try: self.command(op='motion',axes=[0,1,0,0,0],speed=1)
            except ValueError: pass
            self.engine.tick(0.1)
        self.assertTrue(self.engine.state()['contactLost'])
        self.assertIn('stale',self.engine.reason)
        self.engine.receive('/usercamera/Pose',[10,2,20,0,0,0],'ffffff')
        self.assertFalse(self.engine.state()['contactLost'])
    def test_stale_pose_cannot_arm(self):
        self.now += 6; self.engine.dispatch('a',{'op':'claim'})
        with self.assertRaises(ValueError): self.command(op='arm')
    def test_feedback_does_not_overwrite_active_target(self):
        self.engine.receive('/usercamera/Pose',[1,1,1,0,0,0],'ffffff')
        self.assertEqual(self.engine.pose[:3],[10,2,20])
    def test_unrelated_osc_is_not_camera_health(self):
        last=self.engine.last_osc_at; self.now += 1
        self.engine.receive('/avatar/parameters/Foo',[1],'i')
        self.assertEqual(self.engine.last_osc_at,last)
    def test_requested_is_not_observed(self):
        self.command(op='set',name='Zoom',value=80)
        self.assertEqual(self.engine.observed['Zoom'],45)
        self.assertEqual(self.engine.requested['Zoom'],80)
    def test_no_pose_write_by_default(self):
        self.engine.enable_pose=False
        with self.assertRaises(ValueError): self.command(op='arm')
    def test_preset_save_and_reload(self):
        self.command(op='save',slot='1',name='ステージ')
        self.assertEqual(Presets(self.store.path).data['default']['1']['pose'],[10,2,20,0,0,0])
        self.assertEqual(self.store.data['default']['1']['zoom'],45)
    def test_preset_save_requires_observed_zoom(self):
        self.engine.observed.pop('Zoom')
        with self.assertRaises(ValueError): self.command(op='save',slot='1',name='stage')
    def test_store_limits_and_path_validation(self):
        for name in ('../x','','a/b','x'*41):
            with self.assertRaises(ValueError): self.command(op='profile',value=name)
        with self.assertRaises(ValueError): self.command(op='save',slot='../x',name='stage')
    def test_profile_switch_invalidates_old_pose(self):
        self.command(op='profile',value='venue-2')
        self.assertFalse(self.engine.armed)
        with self.assertRaises(ValueError): self.command(op='arm')
    def test_preset_interpolates_shortest_yaw(self):
        self.store.put('default','1',{'name':'stage','pose':[20,2,20,0,-179,0],'zoom':85})
        self.engine.receive('/usercamera/Pose',[10,2,20,0,179,0],'ffffff')
        self.command(op='recall',slot='1',duration=2)
        self.now += 1; self.engine.tick(1/30)
        self.assertAlmostEqual(self.engine.pose[0],15)
        self.assertAlmostEqual(abs(self.engine.pose[4]),180)
        self.assertAlmostEqual(self.engine.requested['Zoom'],65)
        self.command(op='stop'); count=len(self.sent); self.step()
        self.assertEqual(len(self.sent),count)
    def test_preset_cut(self):
        self.command(op='save',slot='1',name='stage')
        self.engine.receive('/usercamera/Pose',[99,2,20,0,0,0],'ffffff')
        self.command(op='recall',slot='1',duration=0); self.step()
        self.assertEqual(self.engine.pose[0],10)
        self.assertIsNone(self.engine.transition)
    def test_recall_starts_from_the_newer_zoom(self):
        self.store.put('default','1',{'name':'stage','pose':[10,2,20,0,0,0],'zoom':60})
        self.command(op='set',name='Zoom',value=90)      # we commanded 90
        self.now += 1
        self.engine.receive('/usercamera/Zoom',[30.0],'f')  # operator then chose 30 in VRChat
        self.command(op='recall',slot='1',duration=2); self.step()
        self.assertAlmostEqual([v for a,v,t in self.sent if a=='/usercamera/Zoom'][-1][0],30,places=1)
    def test_recall_keeps_our_zoom_when_it_is_the_newer_one(self):
        self.store.put('default','1',{'name':'stage','pose':[10,2,20,0,0,0],'zoom':60})
        self.engine.receive('/usercamera/Zoom',[30.0],'f')
        self.now += 1
        self.command(op='set',name='Zoom',value=90)
        self.command(op='recall',slot='1',duration=2); self.step()
        self.assertAlmostEqual([v for a,v,t in self.sent if a=='/usercamera/Zoom'][-1][0],90,places=1)
    def test_cut_recall_without_observed_zoom(self):
        # VRChat reports Zoom only on change, so a fresh session often lacks it.
        self.command(op='save',slot='1',name='stage')
        self.engine.observed.pop('Zoom')
        with self.assertRaises(ValueError): self.command(op='recall',slot='1',duration=2)
        self.command(op='recall',slot='1',duration=0); self.step()
        self.assertEqual(self.engine.pose[:3],[10,2,20])
        self.assertAlmostEqual(self.engine.requested['Zoom'],45)
    def test_idle_keeps_arm_and_recall_still_works(self):
        # VRChat emits Pose only on change, so a still camera always goes quiet.
        self.command(op='save',slot='1',name='stage')
        self.engine.receive('/usercamera/Pose',[99,2,20,0,0,0],'ffffff')
        self.idle(6)
        self.assertTrue(self.engine.armed)
        self.command(op='recall',slot='1',duration=0); self.step()
        self.assertEqual(self.engine.pose[:3],[10,2,20])
    def test_motion_after_idle_resyncs_to_last_reported_pose(self):
        self.engine.receive('/usercamera/Pose',[50,2,20,0,90,0],'ffffff')
        self.idle(6)
        self.command(op='motion',axes=[0,1,0,0,0],speed=1); self.step()
        self.assertGreater(self.engine.pose[0],50)
    def test_stale_feedback_stops_a_held_move_without_disarming(self):
        for _ in range(60):  # Input held down while VRChat feedback never returns.
            self.now += 0.1
            self.command(op='heartbeat')
            try: self.command(op='motion',axes=[0,1,0,0,0],speed=1)
            except ValueError: pass
            self.engine.tick(0.1)
        self.assertTrue(self.engine.armed)
        self.assertEqual(self.engine.velocity,[0]*5)
        self.assertTrue(self.engine.contact_lost)
        # Lost contact latches: no new move until VRChat reports a position again.
        with self.assertRaises(ValueError): self.command(op='motion',axes=[0,1,0,0,0],speed=1)
        self.engine.receive('/usercamera/Pose',[10,2,20,0,0,0],'ffffff')
        self.command(op='motion',axes=[0,1,0,0,0],speed=1)
    def test_camera_off_disarms(self):
        self.engine.receive('/usercamera/Mode',[0],'i')
        self.assertFalse(self.engine.armed)
    def test_camera_behavior_feedback_disarms_and_blocks_arm(self):
        for name in ('Lock', 'LookAtMe'):
            self.engine.receive('/usercamera/'+name,[True],'T')
            self.assertFalse(self.engine.armed)
            with self.assertRaises(ValueError): self.command(op='arm')
            self.engine.receive('/usercamera/'+name,[False],'F')
            self.command(op='arm')
            self.assertTrue(self.engine.armed)
    def test_mode_change_feedback_disarms(self):
        self.engine.receive('/usercamera/Mode',[2],'i')
        self.engine.receive('/usercamera/Mode',[6],'i')
        self.assertFalse(self.engine.armed)
    def test_bad_feedback_types(self):
        with self.assertRaises(ValueError): self.engine.receive('/usercamera/Pose',[1]*6,'iiiiii')
        with self.assertRaises(ValueError): self.engine.receive('/usercamera/Zoom',[45],'i')


def free_port(kind=socket.SOCK_STREAM):
    with socket.socket(socket.AF_INET,kind) as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]


class WireTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.udp=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
        self.udp.bind(('127.0.0.1',0)); self.udp.setblocking(False)
        port=free_port(); remote=free_port(); feedback=free_port(socket.SOCK_DGRAM)
        self.config=Config(port=port,feedback_port=feedback,osc_port=self.udp.getsockname()[1],
                           public_origin=PUBLIC,remote_port=remote,enable_pose=True,
                           presets=Path(self.temp.name)/'presets.json')
        self.app=create_app(self.config); self.runner=web.AppRunner(self.app)
        await self.runner.setup()
        for bind in (port,remote): await web.TCPSite(self.runner,'127.0.0.1',bind).start()
        self.url=f'http://127.0.0.1:{port}'
        self.remote_url=f'http://127.0.0.1:{remote}'  # What Tailscale Serve forwards to.
        self.session=ClientSession(); self.sockets=[]
    async def asyncTearDown(self):
        await asyncio.gather(*(ws.close() for ws in self.sockets)); await self.session.close(); await self.runner.cleanup(); self.udp.close(); self.temp.cleanup()
    async def connect(self,origin=None,login=None,url=None,host=None):
        headers={}
        if login: headers['Tailscale-User-Login']=login
        if host: headers['Host']=host
        base=url or self.url
        ws=await self.session.ws_connect(base+'/ws',origin=origin or base,headers=headers or None)
        self.sockets.append(ws)
        self.assertEqual((await ws.receive_json())['type'],'authenticated')
        return ws
    async def remote(self,**kwargs):
        # Arrives on the Serve port, so it carries the published Origin and Host.
        kwargs.setdefault('origin',PUBLIC); kwargs.setdefault('host',urlsplit(PUBLIC).netloc)
        return await self.connect(url=self.remote_url,**kwargs)
    async def until(self,ws,kind):
        async with asyncio.timeout(2):
            while True:
                data=await ws.receive_json()
                if data['type']==kind: return data
    async def test_http_static_and_no_secret(self):
        for path in ('/','/app.js','/style.css','/healthz'):
            async with self.session.get(self.url+path) as response:
                self.assertEqual(response.status,200)
                self.assertIn('frame-ancestors',response.headers['Content-Security-Policy'])
        async with self.session.get(self.url+'/.data/presets.json') as response: self.assertEqual(response.status,404)
        async with self.session.get(self.url+'/?token=abc') as response: self.assertEqual(response.status,400)
    async def test_reject_host_and_origin(self):
        async with self.session.get(self.url+'/',headers={'Host':'evil.test'}) as response: self.assertEqual(response.status,403)
        with self.assertRaises(WSServerHandshakeError): await self.connect(origin='https://evil.test')
        with self.assertRaises(WSServerHandshakeError): await self.session.ws_connect(self.url+'/ws')
    async def test_serve_port_requires_tailscale_identity(self):
        # Serve adds the header for tailnet traffic and omits it for Funnel.
        with self.assertRaises(WSServerHandshakeError):
            await self.session.ws_connect(self.remote_url+'/ws',origin=PUBLIC)
        ws=await self.remote(login='alice@example.com')
        self.assertEqual((await self.until(ws,'state'))['operator'],'alice@example.com')
    async def test_forged_origin_cannot_pose_as_local_access(self):
        # A non-browser client sets Origin freely, so it must not decide the gate.
        for origin in (self.url,f'http://localhost:{self.config.port}'):
            with self.assertRaises(WSServerHandshakeError):
                await self.session.ws_connect(self.remote_url+'/ws',origin=origin)
            with self.assertRaises(WSServerHandshakeError):
                await self.session.ws_connect(self.remote_url+'/ws',origin=origin,
                                              headers={'Host':urlsplit(PUBLIC).netloc})
    async def test_serve_port_rejects_loopback_host_and_local_port_rejects_published(self):
        with self.assertRaises(WSServerHandshakeError):
            await self.session.ws_connect(self.remote_url+'/ws',origin=PUBLIC,
                                          headers={'Host':f'127.0.0.1:{self.config.port}',
                                                   'Tailscale-User-Login':'alice@example.com'})
        with self.assertRaises(WSServerHandshakeError):
            await self.connect(origin=PUBLIC,login='alice@example.com')
    async def test_local_port_is_physical_access(self):
        ws=await self.connect()
        self.assertEqual((await self.until(ws,'state'))['operator'],'localhost')
    async def test_local_port_ignores_forged_identity_header(self):
        ws=await self.connect(login='boss@example.com')
        self.assertEqual((await self.until(ws,'state'))['operator'],'localhost')
    async def test_owner_is_named_for_other_operators(self):
        alice=await self.remote(login='alice@example.com')
        await alice.send_json({'op':'claim'}); await self.until(alice,'accepted')
        bob=await self.remote(login='bob@example.com')
        self.assertEqual((await self.until(bob,'state'))['ownerName'],'alice@example.com')
    async def test_authenticated_websocket_to_udp(self):
        ws=await self.connect(); await ws.send_json({'op':'claim'}); await self.until(ws,'accepted')
        await ws.send_json({'op':'set','name':'Mode','value':6})
        self.assertEqual((await self.until(ws,'accepted'))['op'],'set')
        data=await asyncio.wait_for(asyncio.get_running_loop().sock_recv(self.udp,4096),1)
        # Independent, literal OSC expected bytes, not encoder/decoder self-consistency.
        self.assertEqual(data,b'/usercamera/Mode\0\0\0\0'+b',i\0\0'+struct.pack('>i',6))
        await ws.close(); await asyncio.sleep(0.05)
        self.assertIsNone(self.app[ENGINE].owner)
    async def test_feedback_motion_and_deadman_wire(self):
        ws=await self.connect(); await ws.send_json({'op':'claim'}); await self.until(ws,'accepted')
        self.udp.sendto(encode('/usercamera/Pose',[10,2,20,0,0,0],'ffffff'),('127.0.0.1',self.config.feedback_port))
        await asyncio.sleep(0.05)
        await ws.send_json({'op':'arm'}); await self.until(ws,'accepted')
        await ws.send_json({'op':'motion','axes':[1,0,0,0,0]})
        data=await asyncio.wait_for(asyncio.get_running_loop().sock_recv(self.udp,4096),1)
        address,values,types=decode(data)
        self.assertEqual((address,types),('/usercamera/Pose','ffffff')); self.assertGreater(values[0],10)
        await asyncio.sleep(0.55); count=self.app[ENGINE].sent; await asyncio.sleep(0.12)
        self.assertEqual(self.app[ENGINE].sent,count)
        await ws.close(); await asyncio.sleep(0.02); self.assertFalse(self.app[ENGINE].armed)
    async def test_invalid_json_and_unknown_commands_do_not_emit(self):
        ws=await self.connect(); await ws.send_json({'op':'claim'}); await self.until(ws,'accepted')
        for raw in ['[]','{"op":"exec","command":"ignored"}','{"op":"set","name":"Zoom","value":NaN}']:
            await ws.send_str(raw); await self.until(ws,'error')
        self.assertEqual(self.app[ENGINE].sent,0)
    async def test_rate_limit_closes_client(self):
        ws=await self.connect(); await ws.send_json({'op':'claim'}); await self.until(ws,'accepted')
        for _ in range(90): await ws.send_json({'op':'heartbeat'})
        async with asyncio.timeout(2):
            while (await ws.receive()).type != WSMsgType.CLOSE: pass
        self.assertEqual(ws.close_code,1008)


class ConfigTests(unittest.TestCase):
    def test_config_guards(self):
        for args in ({'port':0},{'osc_port':9001},{'forward_port':9000},
                     {'public_origin':'http://camera.ts.net'},{'public_origin':'https://camera.ts.net/'},
                     {'public_origin':'https://user:pass@camera.ts.net'},
                     {'public_origin':PUBLIC},                      # publishing without a Serve port
                     {'remote_port':8766},                          # Serve port without publishing
                     {'public_origin':PUBLIC,'remote_port':8765}):  # Serve port equal to the local one
            with self.subTest(args=args), self.assertRaises(ValueError): Config(**args)
    def test_explicit_public_origin(self):
        config=Config(public_origin=PUBLIC,remote_port=8766)
        self.assertIn('https://camera.example.ts.net:8443',config.origins)
        self.assertIn('camera.example.ts.net:8443',config.hosts)
    def test_csp_has_exact_websocket_origins(self):
        config=Config(public_origin=PUBLIC,remote_port=8766)
        csp=response_headers(config)['Content-Security-Policy']
        self.assertIn('wss://camera.example.ts.net:8443',csp)
        self.assertIn('ws://127.0.0.1:8765',csp)
        self.assertNotIn('wss:;',csp)
    def test_forwarding_preserves_original_payload(self):
        sent=[]
        class Transport:
            def sendto(self,data,addr): sent.append((data,addr))
        class FakeEngine:
            invalid_osc=0
            def receive(self,*args): pass
        config=Config(feedback_port=9002,forward_port=9001)
        receiver=Feedback(FakeEngine(),config); receiver.connection_made(Transport())
        payload=b'/avatar/change\0\0,s\0\0avtr_example\0\0\0\0'
        receiver.datagram_received(payload,('127.0.0.1',9000))
        self.assertEqual(sent,[(payload,('127.0.0.1',9001))])
        receiver.datagram_received(payload,('192.0.2.1',9000)); self.assertEqual(len(sent),1)


if __name__=='__main__': unittest.main()
