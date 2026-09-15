'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createReconnectableRuntime}=require('./reconnectable-local-runtime.cjs');
const {createManualController}=require('./manual-osc-controller.cjs');
test('offline startup and Main/Sub restarts reconnect without writes or replay',async t=>{
 let mainUp=false,subUp=false,mainGeneration=1,subGeneration=1,wrong=false;const calls=[];
 const runtime=createReconnectableRuntime({timeoutMs:100,readConfig:()=>({server_enabled:true,auth_required:true,server_port:4456}),createMain:()=>{const generation=mainGeneration;return {connect:async()=>{if(!mainUp)throw Error();},disconnect:async()=>{},call:async type=>{calls.push(type);if(!mainUp||generation!==mainGeneration)throw Error();if(type==='GetProfileList')return {currentProfileName:wrong?'production':'BLMF_WINDOWS_LOCAL_TEST'};if(type==='GetSceneCollectionList')return {currentSceneCollectionName:'BLMF_WINDOWS_LOCAL_TEST'};if(type==='GetCurrentProgramScene')return {currentProgramSceneName:'ENTRY_FULLSCREEN'};throw Error('unexpected write');}};},createSub:()=>{const generation=subGeneration;const read=()=>{if(!subUp||generation!==subGeneration)throw Error();};return {read,getProgramScene:async()=>{read();return 'ENTRY_001';},getSceneList:async()=>{read();return {scenes:[{sceneName:'ENTRY_001'},{sceneName:'STANDBY'}]};}};}});
 const server=await createManualController({httpPort:0,udpPort:0});t.after(async()=>{await server.close();await runtime.close();});await server.attach(runtime);
 const state=async()=>(await fetch(server.origin+'/api/state')).json();
 assert.equal((await state()).connected,false);assert.equal((await server.reconnect()).ok,false);
 mainUp=true;assert.equal((await server.reconnect()).ok,false);assert.equal((await state()).mainConnected,true);assert.equal((await state()).subConnected,false);
 subUp=true;assert.equal((await server.reconnect()).ok,true);
 for(const restart of [()=>mainGeneration++,()=>subGeneration++,()=>{mainGeneration++;subGeneration++;}]){restart();assert.equal((await server.reconnect()).ok,true);assert.equal((await state()).subScene,'ENTRY_001');}
 wrong=true;assert.equal((await server.reconnect()).ok,false);assert.equal((await state()).mainConnected,false);
 assert.ok(calls.every(c=>c.startsWith('Get')));
});
test('hung Main connect is bounded and does not prevent Sub recovery',async()=>{
 const runtime=createReconnectableRuntime({timeoutMs:20,readConfig:()=>({server_enabled:true,auth_required:true,server_port:4456}),createMain:()=>({connect:()=>new Promise(()=>{}),disconnect:async()=>{}}),createSub:()=>({read(){},getProgramScene:async()=>'STANDBY'})});
 await runtime.reconnect();assert.equal(await runtime.subObs.getProgramScene(),'STANDBY');await assert.rejects(runtime.mainObs.getProgramScene());await runtime.close();
});
