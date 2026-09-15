'use strict';
function createReconnectableRuntime({createMain,readConfig,createSub,timeoutMs=1500}) {
 let main=null,sub=null;
 async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('obs_timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const call=(client,type,args)=>{if(!client)throw Error('main_disconnected');return bounded(client.call(type,args));};
 async function check(client){if((await call(client,'GetProfileList')).currentProfileName!=='BLMF_WINDOWS_LOCAL_TEST'||(await call(client,'GetSceneCollectionList')).currentSceneCollectionName!=='BLMF_WINDOWS_LOCAL_TEST')throw Error('main_identity_changed');}
 async function disconnect(client){try{await bounded(client?.disconnect());}catch{}}
 const runtime={
  mainObs:{getProgramScene:async()=>{const c=main;await check(c);return(await call(c,'GetCurrentProgramScene')).currentProgramSceneName;},setProgramScene:async scene=>{const c=main;await check(c);if(!['VRC_VENUE','ENTRY_FULLSCREEN'].includes(scene))throw Error('invalid_scene');await call(c,'SetCurrentProgramScene',{sceneName:scene});await check(c);}},
  subObs:Object.fromEntries(['getProgramScene','getSceneList','getMediaSources','setProgramScene'].map(method=>[method,async(...args)=>{if(!sub)throw Error('sub_disconnected');return sub[method](...args);} ])),
  async reconnect(){
   await Promise.all([
    (async()=>{const old=main;main=null;await disconnect(old);const candidate=createMain();candidate.on?.('ConnectionError',()=>{});try{const w=readConfig();if(!w.server_enabled||!w.auth_required||w.server_port!==4456)throw Error('main_config');await bounded(candidate.connect('ws://127.0.0.1:4456',w.server_password));await check(candidate);main=candidate;}catch{await disconnect(candidate);}})(),
    (async()=>{sub=null;try{const candidate=createSub();candidate.read();sub=candidate;}catch{}})()
   ]);
  },
  async close(){await disconnect(main);main=null;sub=null;},
  ndiMonitoring:false,ndiHealth:async()=>false,inspectReadiness:async()=>({READY:false,reason:'continuous_ndi_measurement_not_attached',observedAt:Date.now()})
 };
 return runtime;
}
module.exports={createReconnectableRuntime};
