'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createManualController}=require('./manual-osc-controller.cjs');
test('HTTP media readback follows Sub independently of Main, clears failures and scene races without writes',async t=>{
 let sub='ENTRY_001',mediaFails=false,sceneFails=false;
 let media={scene:sub,sources:[{name:'Movie',state:'playing',cursor:1000,duration:10000,looping:true}]};
 const server=await createManualController({httpPort:0,udpPort:0});t.after(()=>server.close());
 const runtime={mainObs:{getProgramScene:async()=> 'VRC_VENUE'},subObs:{getSceneList:async()=>({scenes:[{sceneName:sub}]}),getProgramScene:async()=>{if(sceneFails)throw Error('gone');return sub;},getMediaSources:async()=>{if(mediaFails)throw Error('gone');return media;}},ndiHealth:async()=>false};
 await server.attach(runtime);
 const state=async()=>(await fetch(server.origin+'/api/state')).json();
 const check=async()=>(await fetch(server.origin+'/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-BLMF-Local':'1',Origin:server.origin},body:JSON.stringify({action:'check'})})).json();
 assert.equal((await state()).mainScene,'VRC_VENUE');assert.deepEqual((await state()).media,media);
 mediaFails=true;await check();assert.equal((await state()).media,null);assert.equal((await state()).connected,true);
 mediaFails=false;await check();assert.deepEqual((await state()).media,media);
 sub='STANDBY';await check();assert.equal((await state()).media,null);
 media={scene:sub,sources:[]};await check();assert.deepEqual((await state()).media.sources,[]);
 sceneFails=true;assert.equal((await check()).ok,false);assert.equal((await state()).connected,false);assert.equal((await state()).media,null);
 sceneFails=false;await check();assert.equal((await state()).connected,true);
});
