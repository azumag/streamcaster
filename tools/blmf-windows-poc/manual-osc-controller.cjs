'use strict';
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Coordinator = require('./manual-scene-coordinator.cjs');
const ControlPlane = require('./catalog-control-plane.cjs');
const Catalog = require('./obs-entry-catalog.cjs');
const Lease = require('../../controller/blmf/director_lease');
const Ledger = require('../../controller/blmf/command_ledger');
const Bridge = require('../../operator-bridge/bridge_service');
const Decoder = require('../../operator-bridge/osc_command_decoder');
const { encodeMessage, decodeMessage } = require('../../operator-bridge/osc_udp_port');
const COMMAND = '/avatar/parameters/BLMF_Command';
const ENTRY = '/blmf/poc/entry-scene';
const CODES = { claim:250, release:251, venue:3, ndi:5, standby:4, previous:6, next:7, execute:8 };

const SELECTION='/blmf/poc/select-entry';
const utc = () => new Date().toISOString();

// One loopback receiver and one authority path for GUI datagrams and local VRChat.
// No credentials are accepted by HTTP or serialized in its responses.
async function createManualController({ httpPort=18765, udpPort=9001, record=()=>{}, catalogReader, publicOrigin=null }={}) {
    if(publicOrigin!==null && (typeof publicOrigin!=='string'||!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(publicOrigin)))throw Error('invalid_public_origin');
    let runtime, bridge, plane, catalog, coordinator, busy=false, sending=false, closing=false, pending;
    let seq=0, heartbeat, refreshTimer, readBusy=false;
    const operator={id:'local-manual-poc',canPanic:false}, bridgeId='local-manual-poc';
    const sessionId=randomUUID(), events=[];
    const state={runtime:'starting', ready:false, readinessReason:'unchecked', readinessAt:null,
        mainScene:null, subScene:null, readbackUtc:null, connected:false, isDirector:false,
        ndiHealthy:false,ndiDropped:null,verifierAvailable:null,verifierBusy:false};
    let finish;
    const done=new Promise(resolve=>{finish=resolve;});
    const receiver=dgram.createSocket('udp4'), sender=dgram.createSocket('udp4');
    const safeRecord = event => { events.unshift(event); events.splice(30); try { record(event); } catch {} };
    const getState = () => ({service:'blmf-manual-osc',...state,busy:busy||sending,ready:state.ready && Date.now()-state.readinessAt<=5000,
        readinessExpired:state.readinessAt!==null && Date.now()-state.readinessAt>5000,
        isDirector:!!plane?.state(operator,bridgeId).isDirector, events,
        udpEndpoint:`127.0.0.1:${receiver.address().port}`, httpOrigin:origin,catalog:catalog ? {...catalog.snapshot(),entries:catalog.entries.map(e=>({...e,executionSupported:true,supportReason:'scene_switch'}))}: {status:state.runtime==='unavailable'?'unavailable':'unchecked',entries:[],selected:null}});
    async function readback() {
        if (!runtime) throw Error('runtime_unavailable');
        const results=await Promise.allSettled([runtime.mainObs.getProgramScene(),runtime.subObs.getProgramScene()]);
        state.mainConnected=results[0].status==='fulfilled';state.subConnected=results[1].status==='fulfilled';
        state.mainScene=state.mainConnected?results[0].value:null;state.subScene=state.subConnected?results[1].value:null;
        if(!state.mainConnected||!state.subConnected){state.connected=false;state.media=null;state.readbackUtc=null;throw Error('obs_disconnected');}
        const [mainScene,subScene]=results.map(r=>r.value);
        const result={mainScene,subScene,readbackUtc:utc()};
        let media=null;
        if(runtime.subObs.getMediaSources){try{const m=await runtime.subObs.getMediaSources();if(m.scene===subScene)media=m;}catch{}}
        Object.assign(state,result,{connected:true,media});
        try{state.ndiHealthy=await runtime.ndiHealth()===true;}catch{state.ndiHealthy=false;}
        if(runtime.ndiStatus){try{state.ndiDropped=(await runtime.ndiStatus()).dropped;}catch{state.ndiDropped=null;}}
        if(runtime.verifierHealth){try{const h=await runtime.verifierHealth();state.verifierAvailable=h.available===true;state.verifierBusy=h.busy===true;}catch{state.verifierAvailable=false;}}
        return result;
    }
    async function inspect() {
        const r=await runtime.inspectReadiness();
        state.ready=r.READY===true; state.readinessAt=r.observedAt||Date.now();
        state.readinessReason=r.READY?'ready':r.reason==='state_or_freshness_changed'?'freshness_failed'
            :r.gates?.ndiHealthy===false?'ndi_not_ready':r.gates?.assetReady===false?'asset_not_ready':'not_ready';
        return r;
    }
    function parse(packet) {
        if(packet.length>256)throw Error('invalid_osc');
        const m=decodeMessage(packet);
        if(m.args.length!==1 || !encodeMessage(m).equals(packet))throw Error('invalid_osc');
        if(m.address===COMMAND && Number.isInteger(m.args[0]) && [0,...Object.values(CODES)].includes(m.args[0]))return m;
        if([ENTRY,SELECTION].includes(m.address) && typeof m.args[0]==='string' && /^ENTRY_.+/.test(m.args[0]))return m;
        throw Error('invalid_osc');
    }
    receiver.on('message',async(packet,peer)=>{
        if(closing||peer.address!=='127.0.0.1')return;
        const task=pending && peer.port===sender.address().port && pending.packet.equals(packet)?pending:null;
        if(task)pending=null;
        const event={id:randomUUID(),receivedUtc:utc(),source:task?'local_gui':'local_osc',stage:'udp_received'};
        try {
            const m=parse(packet); event.address=m.address; event.value=m.args[0];
            if(!bridge)throw Error('runtime_unavailable');
            if(m.address===COMMAND && m.args[0]===0){await bridge.handleOscMessage(m);task?.resolve({ok:true,rearmed:true});return;}
            if(busy)throw Error('busy');
            busy=true;
            try {
                const r=await bridge.handleOscMessage(m);
                event.accepted=r?.ok===true;
                const known=['director_required','standby_required','not_ready','stale_command','media_not_playing','program_not_confirmed','poc_entry_failed','command_failed','catalog_unavailable','entry_missing','selection_boundary','selection_required','selection_changed','proof_unsupported','already_active','ndi_not_ready'];
                event.reason=r?.ok?'accepted':r===null?'rearm_required':known.includes(r.reason)?r.reason:'command_rejected';
                if(event.reason==='not_ready' && m.address===ENTRY)event.reason=state.readinessReason;
                try {
                    Object.assign(event,await readback());
                    const expected=m.address===COMMAND && m.args[0]===8 ? event.mainScene==='ENTRY_FULLSCREEN' && event.subScene===catalog.selected : m.address===ENTRY ? event.mainScene==='ENTRY_FULLSCREEN' && event.subScene===m.args[0]
                        : m.args[0]===3 ? event.mainScene==='VRC_VENUE'
                        : m.args[0]===5 ? event.mainScene==='ENTRY_FULLSCREEN'
                        : m.args[0]===4 ? event.subScene==='STANDBY' : null;
                    event.obsConfirmed=expected===null?null:event.accepted && expected;
                    event.stage=event.obsConfirmed===true?'obs_confirmed':event.accepted?'bridge_accepted':'rejected';
                } catch {state.connected=false;event.obsConfirmed=false;event.stage='readback_failed';}
                safeRecord(event);task?.resolve({ok:event.accepted,event});
            } finally {busy=false;}
        } catch(error) {
            event.stage='rejected';event.reason=['busy','runtime_unavailable'].includes(error.message)?error.message:'invalid_osc';
            safeRecord(event);task?.resolve({ok:false,event});
        }
    });
    async function bind(socket,port) {
        await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(port,'127.0.0.1',resolve);});
        socket.on('error',()=>{state.runtime='socket_error';state.ready=false;});
    }
    async function send(message) {
        const packet=encodeMessage(message);
        let timer;
        try {return await new Promise((resolve,reject)=>{
            pending={packet,resolve,reject}; timer=setTimeout(()=>{pending=null;reject(Error('result_timeout'));},18000);
            sender.send(packet,receiver.address().port,'127.0.0.1',error=>{if(error){pending=null;reject(Error('send_failed'));}});
        });} finally {clearTimeout(timer);}
    }
    async function selectionAction(command,name,context) {
        const allowed=()=>context.authorize() && context.isFresh();
        if(!allowed())return {ok:false,reason:'director_required'};
        const selected=catalog.selected;
        const revision=catalog.revision;
        await catalog.refresh(); state.ready=false;
        if(!allowed())return {ok:false,reason:'director_required'};
        if(catalog.status!=='available')return {ok:false,reason:'catalog_unavailable'};
        if(command==='SELECT_ENTRY')return catalog.select(name);
        if(command==='SELECT_PREVIOUS')return catalog.move(-1);
        if(command==='SELECT_NEXT')return catalog.move(1);
        if(!selected)return {ok:false,reason:'selection_required'};
        if(catalog.selected!==selected || catalog.revision!==revision)return {ok:false,reason:'selection_changed'};
        return switchScene(selected,context);
    }
    async function switchScene(selected,context){
        const allowed=()=>context.authorize() && context.isFresh();
        if(!allowed())return {ok:false,reason:'director_required'};
        if(await runtime.subObs.getProgramScene()===selected)return {ok:false,reason:'already_active'};
        // Explicit user policy: scene cuts only, no asset proof, media restart or intermediate STANDBY.
        if(!allowed())return {ok:false,reason:'director_required'};
        await runtime.subObs.setProgramScene(selected);
        if(await runtime.subObs.getProgramScene()!==selected)return {ok:false,reason:'program_not_confirmed'};
        if(!allowed())return {ok:false,reason:'director_required'};
        await runtime.mainObs.setProgramScene('ENTRY_FULLSCREEN');
        if(await runtime.mainObs.getProgramScene()!=='ENTRY_FULLSCREEN')return {ok:false,reason:'program_not_confirmed'};
        return {ok:true};
    }
    async function action(action,entryId) {
        if(closing)return {ok:false,reason:'closing'};
        if(action==='shutdown'){setTimeout(()=>close(),300);return {ok:true,closing:true};}
        if(sending||busy)return {ok:false,reason:'busy'};
        if(action==='refresh'){if(!catalog)return {ok:false,reason:'catalog_unavailable'};busy=true;try{await catalog.refresh();state.ready=false;return {ok:catalog.status==='available',reason:catalog.status==='available'?null:'catalog_unavailable'};}finally{busy=false;}}
        if(!runtime)return {ok:false,reason:'runtime_unavailable'};
        if(action==='reconnect') {
            if(!runtime.reconnect)return {ok:false,reason:'reconnect_unsupported'};
            busy=true;state.ready=false;state.connected=false;state.media=null;
            try {
                while(readBusy)await new Promise(r=>setTimeout(r,20));
                await runtime.reconnect();
                // The Sub observer publishes every 500ms; tolerate a read during publication.
                for(let attempt=0;;attempt++){
                    await catalog.refresh();
                    try{await readback();break;}catch(error){if(attempt>=2)throw error;await new Promise(r=>setTimeout(r,250));}
                }
                return {ok:true};
            }catch{return {ok:false,reason:'reconnect_failed'};}
            finally{busy=false;}
        }
        if(action==='check') {
            busy=true;
            try {await catalog.refresh();await readback();return {ok:catalog.status==='available',state:getState()};}
            catch {state.ready=false;state.connected=false;return {ok:false,reason:'check_failed'};}
            finally{busy=false;}
        }
        const message=['entry','select'].includes(action) && typeof entryId==='string' && /^ENTRY_.+/.test(entryId)?{address:action==='select'?SELECTION:ENTRY,args:[entryId]}
            : Object.hasOwn(CODES,action)?{address:COMMAND,args:[CODES[action]]}:null;
        if(!message)return {ok:false,reason:'invalid_action'};
        sending=true;
        try {
            await send({address:COMMAND,args:[0]});
            const sentUtc=utc(); const result=await send(message);
            await send({address:COMMAND,args:[0]});
            return {...result,sent:true,sentUtc};
        } catch {return {ok:false,sent:null,reason:'delivery_or_result_unconfirmed'};}
        finally{sending=false;}
    }
    let origin;
    const server=http.createServer(async(req,res)=>{
        const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
            'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
            'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"};
        const reply=(code,value)=>{res.writeHead(code,headers);res.end(JSON.stringify(value));};
        const hosts=[origin?.slice(7),...(publicOrigin?[new URL(publicOrigin).host]:[])];
        if(!hosts.includes(req.headers.host) || req.socket.remoteAddress!=='127.0.0.1')return reply(403,{ok:false});
        if(req.method==='GET' && ['/','/app.js','/style.css'].includes(req.url)) {
            const name=req.url==='/'?'index.html':req.url.slice(1);
            headers['Content-Type']=name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8';
            res.writeHead(200,headers);res.end(fs.readFileSync(path.join(__dirname,'manual-controller',name)));return;
        }
        if(req.method==='GET' && req.url==='/api/state')return reply(200,getState());
        if(req.method!=='POST'||req.url!=='/api/action')return reply(404,{ok:false});
        if(![origin,...(publicOrigin?[publicOrigin]:[])].includes(req.headers.origin) || req.headers['x-blmf-local']!=='1' || req.headers['content-type']!=='application/json')return reply(403,{ok:false});
        let body='';
        try {
            for await(const part of req){body+=part;if(Buffer.byteLength(body)>256)return reply(413,{ok:false});}
            const value=JSON.parse(body);
            if(!value||typeof value.action!=='string')return reply(400,{ok:false});
            const result=await action(value.action,value.entryId);reply(result.reason==='busy'?409:200,result);
        }catch{reply(400,{ok:false,reason:'invalid_request'});}
    });
    async function close() {
        if(closing)return done;
        closing=true;clearInterval(heartbeat);clearInterval(refreshTimer);
        // Finish only the already accepted action; shutdown schedules no scene mutation.
        while(busy||sending)await new Promise(r=>setTimeout(r,50));
        try{plane?.release(operator,bridgeId);}catch{}
        for(const s of [receiver,sender]){try{s.close();}catch{}}
        server.closeAllConnections();await new Promise(r=>server.close(r));finish();
        return done;
    }
    try {
        await bind(receiver,udpPort);await bind(sender,0);
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(httpPort,'127.0.0.1',resolve);});
        origin=`http://127.0.0.1:${server.address().port}`;
    }catch {try{receiver.close();}catch{}try{sender.close();}catch{}server.close();throw Error('manual_ports_unavailable');}
    if(catalogReader){catalog=new Catalog(catalogReader);}
    return {origin,udpPort:receiver.address().port,done,close,reconnect:()=>action('reconnect'),
        unavailable(){state.runtime='unavailable';state.ready=false;state.connected=false;state.media=null;},
        async attach(options) {
            if(runtime)throw Error('already_attached'); runtime=options;
            state.ndiMonitoring=options.ndiMonitoring!==false;
            catalog=new Catalog(()=>runtime.subObs.getSceneList());
            await catalog.refresh();
            const c=coordinator=new Coordinator({mode:'scene_execution_poc',mainObs:runtime.mainObs,subObs:runtime.subObs,
                inspectReadiness:inspect,entries:[]});
            c.readinessProvider=async()=>({ndiHealthy:await runtime.ndiHealth()===true});
            plane=new ControlPlane({selectionAction,coordinator:c,lease:new Lease({ttlMs:15000}),ledger:new Ledger({maxAgeMs:15000}),logger:{info(){},warning(){}}});
            const client={claimDirector:()=>plane.claim(operator,bridgeId),releaseDirector:()=>plane.release(operator,bridgeId),
                sendCommand:(command,entryId)=>plane.command(operator,{command,entryId,bridgeId,sessionId,commandId:randomUUID(),sequence:++seq,sentAt:Date.now()})};
            bridge=new Bridge({client,pocEntrySceneEnabled:true,decoder:new Decoder(),oscPort:{},logger:{warning(){}}});
            const originalHandle=bridge.handleOscMessage.bind(bridge);
            const generic={6:'SELECT_PREVIOUS',7:'SELECT_NEXT',8:'EXECUTE_SELECTED'};
            bridge.handleOscMessage=async message=>{
                if(message.address===SELECTION)return client.sendCommand('SELECT_ENTRY',message.args[0]);
                if(message.address===ENTRY){
                    const select=await client.sendCommand('SELECT_ENTRY',message.args[0]);
                    if(!select.ok)return select;
                    return client.sendCommand('EXECUTE_SELECTED');
                }
                if(message.address===COMMAND && generic[message.args[0]]){
                    if(!bridge.decoder.armed)return null;
                    bridge.decoder.armed=false;
                    return client.sendCommand(generic[message.args[0]]);
                }
                return originalHandle(message);
            };
            state.runtime='connected';state.canReconnect=typeof runtime.reconnect==='function';try{await readback();}catch{state.connected=false;}
            heartbeat=setInterval(()=>{if(plane.state(operator,bridgeId).isDirector)plane.heartbeat(operator,bridgeId);},5000);
            refreshTimer=setInterval(async()=>{if(busy||readBusy||closing)return;readBusy=true;try{await readback();}catch{state.connected=false;}finally{readBusy=false;}},2000);
        }
    };
}
module.exports={createManualController};
