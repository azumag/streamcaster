'use strict';
const fs=require('fs'),path=require('path'),{randomUUID}=require('crypto');
function createLocalSubAdapter({directory=__dirname,now=()=>Date.now(),timeoutMs=2500}={}){
 let session;
 function read(){
  const s=JSON.parse(fs.readFileSync(path.join(directory,'local-sub-state.json'),'utf8'));
  const age=now()/1000-s.observedAt;
  if(s.profile!=='BLMF Windows Sub PoC'||s.collection!=='BLMF Windows Sub PoC'||typeof s.session!=='string'||!s.session||!Number.isFinite(age)||age<0||age>3||typeof s.programScene!=='string'||!Array.isArray(s.scenes)||s.scenes.some(x=>typeof x.sceneName!=='string'))throw Error('sub_state_unavailable');
  if(session&&session!==s.session)throw Error('sub_session_changed');session=s.session;return s;
 }
 return {read,getMediaSources:async()=>{
  const s=read();
  // An old observer or malformed observation is unavailable, not an empty scene.
  if(!Array.isArray(s.mediaSources)||s.mediaSources.some(m=>!m||typeof m.name!=='string'||!m.name||typeof m.state!=='string'||!Number.isFinite(m.cursor)||!Number.isFinite(m.duration)))throw Error('sub_media_unavailable');
  return {scene:s.programScene,observedAt:s.observedAt,sources:s.mediaSources.map(m=>({name:m.name,state:m.state,cursor:m.cursor,duration:m.duration,looping:m.looping===true,loopScope:m.loopScope==='playlist'?'playlist':'source'}))};
 },getSceneList:async()=>({scenes:read().scenes}),getProgramScene:async()=>read().programScene,
  setProgramScene:async scene=>{
   const s=read();if(!(scene==='STANDBY'||/^ENTRY_.+/.test(scene))||!s.scenes.some(x=>x.sceneName===scene))throw Error('scene_rejected');
   const command={id:randomUUID(),scene,session:s.session,issuedAt:Math.floor(now()/1000)};
   const dest=path.join(directory,'local-sub-command.json');fs.writeFileSync(dest+'.tmp',JSON.stringify(command));fs.renameSync(dest+'.tmp',dest);
   const started=Date.now();while(Date.now()-started<timeoutMs){await new Promise(r=>setTimeout(r,100));const state=read();if(state.commandId===command.id){if(state.programScene!==scene)throw Error('sub_scene_unconfirmed');return;}}
   throw Error('sub_scene_unconfirmed');
  }
 };
}
module.exports={createLocalSubAdapter};
