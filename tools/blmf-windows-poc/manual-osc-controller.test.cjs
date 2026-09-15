'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const dgram=require('dgram');
const {createManualController}=require('./manual-osc-controller.cjs');
const {encodeMessage}=require('../../operator-bridge/osc_udp_port');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){
 const writes=[];let main='VRC_VENUE',sub='STANDBY',ready=true,gate=null;let scenes=['STANDBY','ENTRY_001','ENTRY_002'],listFails=false,ndi=true;
 const server=await createManualController({httpPort:0,udpPort:0});
 t.after(()=>server.close());
 const runtime={mainObs:{getProgramScene:async()=>main,setProgramScene:async s=>{writes.push(['main',s]);main=s;}},
 subObs:{getSceneList:async()=>{if(listFails)throw Error('fixture');return {scenes:scenes.slice().reverse().map(sceneName=>({sceneName}))};},getProgramScene:async()=>sub,setProgramScene:async s=>{if(gate)await gate;writes.push(['sub',s]);sub=s;},getMediaStatus:async()=>({mediaState:'OBS_MEDIA_STATE_PLAYING'})},
 ndiHealth:async()=>ndi,inspectReadiness:async()=>{if(gate)await gate;return {READY:ready,observedAt:Date.now(),gates:{assetReady:true,ndiHealthy:ready}};}};
 await server.attach(runtime);
 const post=(action,entryId,headers={})=>fetch(server.origin+'/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-BLMF-Local':'1',Origin:server.origin,...headers},body:JSON.stringify({action,entryId})});
 const act=async(...args)=>(await post(...args)).json();
 const state=async()=>(await fetch(server.origin+'/api/state')).json();
 return {server,writes,post,act,state,setReady:v=>{ready=v;},setGate:v=>{gate=v;},setScenes:v=>{scenes=v;},failList:v=>{listFails=v;},setNdi:v=>{ndi=v;}};
}

test('manual NDI cut after standby works with failed NDI health and does not resume Sub',async t=>{
 const f=await fixture(t);await f.act('claim');f.setNdi(false);
 assert.equal((await f.act('standby')).ok,true);
 assert.equal((await f.act('ndi')).event.obsConfirmed,true);
 assert.equal((await f.state()).subScene,'STANDBY');
 assert.equal((await f.act('venue')).ok,true);
 assert.equal((await f.act('ndi')).event.obsConfirmed,true);
 assert.deepEqual(f.writes,[['sub','STANDBY'],['main','ENTRY_FULLSCREEN'],['main','VRC_VENUE'],['main','ENTRY_FULLSCREEN']]);
 await f.act('select','ENTRY_002');assert.equal((await f.act('execute')).ok,true);
 assert.equal((await f.state()).subScene,'ENTRY_002');
 await f.act('release');const count=f.writes.length;
 assert.equal((await f.act('ndi')).event.reason,'director_required');assert.equal(f.writes.length,count);
});
test('manual startup/shutdown never mutate; HTTP host and origin checks reject foreign input',async t=>{
 const f=await fixture(t);assert.deepEqual(f.writes,[]);
 assert.equal((await f.state()).isDirector,false);
 assert.equal((await f.post('claim',null,{Origin:'http://evil.example'})).status,403);
 const foreignHostStatus=await new Promise((resolve,reject)=>{require('http').get(f.server.origin+'/api/state',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
 assert.equal(foreignHostStatus,403);
 assert.equal((await f.post('claim',null,{'X-BLMF-Local':'bad'})).status,403);
 assert.deepEqual(f.writes,[]);
 await f.server.close();assert.deepEqual(f.writes,[]);
});
test('GUI sends actual OSC through Bridge lease and coordinator; readback is separately timestamped',async t=>{
 const f=await fixture(t);
 const denied=await f.act('entry','ENTRY_001');assert.equal(denied.ok,false);assert.equal(denied.event.reason,'director_required');assert.deepEqual(f.writes,[]);
 assert.equal((await f.act('claim')).ok,true);
 const result=await f.act('entry','ENTRY_001');
 assert.equal(result.sent,true);assert.equal(result.event.stage,'obs_confirmed');
 assert.ok(result.sentUtc<=result.event.receivedUtc);assert.ok(result.event.receivedUtc<=result.event.readbackUtc);
 assert.deepEqual(f.writes,[['sub','ENTRY_001'],['main','ENTRY_FULLSCREEN']]);
 assert.equal((await f.act('venue')).event.mainScene,'VRC_VENUE');
 assert.equal((await f.act('ndi')).event.mainScene,'ENTRY_FULLSCREEN');
 assert.equal(f.writes.filter(w=>w[0]==='sub').length,1);
 assert.equal((await f.act('standby')).event.subScene,'STANDBY');
 assert.equal((await f.act('entry','ENTRY_002')).event.subScene,'ENTRY_002');
 assert.equal((await f.act('release')).ok,true);
 const count=f.writes.length;await f.server.close();assert.equal(f.writes.length,count);
});
test('asset readiness is not required; unknown and overlapping commands still fail safely',async t=>{
 const f=await fixture(t);await f.act('claim');f.setReady(false);
 assert.equal((await f.act('entry','ENTRY_001')).ok,true);
 assert.equal((await f.act('entry','INVALID')).reason,'invalid_action');
 assert.equal((await f.act('take')).reason,'invalid_action');
 let release;f.setGate(new Promise(r=>{release=r;}));
 const first=f.act('entry','ENTRY_002');await pause(30);
 assert.equal((await f.post('venue')).status,409);
 release();assert.equal((await first).ok,true);assert.equal(f.writes.length,4);
});

test('external local OSC shares the same director gate, strict types and rearm decoder',async t=>{
 const f=await fixture(t);const socket=dgram.createSocket('udp4');t.after(()=>socket.close());
 const send=async(packet)=>{await new Promise((r,j)=>socket.send(packet,f.server.udpPort,'127.0.0.1',e=>e?j(e):r()));await pause(35);};
 const msg=v=>encodeMessage({address:'/avatar/parameters/BLMF_Command',args:[v]});
 await send(msg(3));assert.deepEqual(f.writes,[]);
 await send(msg(0));await send(msg(250));assert.equal((await f.state()).isDirector,true);
 await send(msg(0));await send(msg(3));assert.equal(f.writes.length,1);
 await send(msg(3));assert.equal(f.writes.length,1);
 await send(msg(0));await send(msg(2));assert.equal(f.writes.length,1);
 const floatPacket=msg(3);const at=floatPacket.indexOf(Buffer.from(',i'));floatPacket[at+1]=102;floatPacket.writeFloatBE(3,floatPacket.length-4);
 await send(floatPacket);assert.equal(f.writes.length,1);
 await send(encodeMessage({address:'/blmf/poc/entry_scene',args:['ENTRY_001']}));assert.equal(f.writes.length,1);
 const s=await f.state();assert.ok(s.events.some(e=>e.source==='local_osc'));assert.ok(s.events.some(e=>e.reason==='invalid_osc'));
});
test('ports conflict fails without replacing the existing receiver',async t=>{
 const f=await fixture(t);
 await assert.rejects(createManualController({httpPort:0,udpPort:f.server.udpPort}),/manual_ports_unavailable/);
 assert.equal((await f.act('claim')).ok,true);assert.deepEqual(f.writes,[]);
});

test('dynamic catalog follows OBS order, retains selection by name, clears deletion and fails closed',async t=>{
 const f=await fixture(t);
 f.setScenes(['STANDBY','ENTRY_Z','CAMERA','ENTRY_001','ENTRY_show finale','ENTRY_002']);
 await f.act('refresh');
 assert.deepEqual((await f.state()).catalog.entries.map(e=>e.sceneName),['ENTRY_Z','ENTRY_001','ENTRY_show finale','ENTRY_002']);
 assert.equal((await f.act('next')).ok,false);assert.deepEqual(f.writes,[]);
 await f.act('claim');await f.act('next');assert.equal((await f.state()).catalog.selected,'ENTRY_Z');
 assert.equal((await f.state()).catalog.entries[0].executionSupported,true);assert.deepEqual(f.writes,[]);
 await f.act('next');assert.equal((await f.state()).catalog.selected,'ENTRY_001');
 f.setScenes(['ENTRY_001','ENTRY_Z']);await f.act('refresh');assert.equal((await f.state()).catalog.selected,'ENTRY_001');
 assert.equal((await f.act('previous')).event.reason,'selection_boundary');
 f.setScenes(['ENTRY_Z']);await f.act('refresh');assert.equal((await f.state()).catalog.selected,null);
 assert.equal((await f.act('execute')).event.reason,'selection_required');
 f.setScenes([]);await f.act('refresh');assert.equal((await f.state()).catalog.status,'empty');
 f.failList(true);await f.act('refresh');assert.equal((await f.state()).catalog.status,'unavailable');
 assert.equal((await f.act('execute')).event.reason,'catalog_unavailable');assert.deepEqual(f.writes,[]);
});

test('selected execution captures actual name and rejects list revision changes before mutation',async t=>{
 const f=await fixture(t);await f.act('claim');await f.act('select','ENTRY_001');
 f.setScenes(['ENTRY_002','ENTRY_001']);
 assert.equal((await f.act('execute')).event.reason,'selection_changed');assert.deepEqual(f.writes,[]);
 const r=await f.act('execute');assert.equal(r.event.obsConfirmed,true);
 assert.deepEqual(f.writes,[['sub','ENTRY_001'],['main','ENTRY_FULLSCREEN']]);
 assert.equal((await f.act('execute')).event.reason,'already_active');assert.equal(f.writes.length,2);
});

test('real OSC selection shares server state and zero release during busy execution rearms next press',async t=>{
 const f=await fixture(t);await f.act('claim');
 const socket=dgram.createSocket('udp4');t.after(()=>socket.close());
 const send=async value=>{await new Promise((resolve,reject)=>socket.send(encodeMessage({address:'/avatar/parameters/BLMF_Command',args:[value]}),f.server.udpPort,'127.0.0.1',e=>e?reject(e):resolve()));await pause(25);};
 await send(7);assert.equal((await f.state()).catalog.selected,'ENTRY_001');
 await send(7);assert.equal((await f.state()).catalog.selected,'ENTRY_001');
 await send(0);let release;f.setGate(new Promise(r=>{release=r;}));
 await send(8);await send(0);release();await pause(80);
 assert.equal(f.writes.length,2);
 await send(7);assert.equal((await f.state()).catalog.selected,'ENTRY_002');
 assert.equal(f.writes.length,2);
});

test('catalog refresh works read-only while execution runtime is unavailable',async t=>{
 const server=await createManualController({httpPort:0,udpPort:0,catalogReader:async()=>({scenes:[{sceneName:'ENTRY_added'},{sceneName:'STANDBY'}]})});
 t.after(()=>server.close());server.unavailable();
 const action=async a=>(await fetch(server.origin+'/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-BLMF-Local':'1',Origin:server.origin},body:JSON.stringify({action:a})})).json();
 assert.equal((await action('refresh')).ok,true);
 const state=await (await fetch(server.origin+'/api/state')).json();
 assert.equal(state.connected,false);assert.equal(state.catalog.entries[0].sceneName,'ENTRY_added');assert.equal(state.catalog.entries[0].executionSupported,true);
 assert.equal((await action('execute')).reason,'runtime_unavailable');
});

test('arbitrary scene switches directly with no proof, generated media name or STANDBY',async t=>{
 const f=await fixture(t);f.setScenes(['ENTRY_original','ENTRY_finale renamed']);await f.act('refresh');await f.act('claim');
 f.setReady(false);
 await f.act('select','ENTRY_original');assert.equal((await f.act('execute')).ok,true);
 await f.act('select','ENTRY_finale renamed');assert.equal((await f.act('execute')).event.obsConfirmed,true);
 assert.deepEqual(f.writes,[['sub','ENTRY_original'],['main','ENTRY_FULLSCREEN'],['sub','ENTRY_finale renamed'],['main','ENTRY_FULLSCREEN']]);
 f.setScenes(['ENTRY_original']);const count=f.writes.length;
 assert.equal((await f.act('execute')).event.reason,'selection_changed');assert.equal(f.writes.length,count);
});
