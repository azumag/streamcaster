'use strict';
// OBS 5.x GetSceneList reverses the frontend list. Restore frontend top-to-bottom.
class ObsEntryCatalog {
 constructor(read){this.read=read;this.entries=[];this.selected=null;this.revision=0;this.status='unchecked';this.updatedUtc=null;}
 async refresh(){
  try {
   const result=await this.read();
   if(!Array.isArray(result?.scenes))throw Error();
   const rows=result.scenes;
   if(rows.some(s=>typeof s.sceneName!=='string')||new Set(rows.map(s=>s.sceneName)).size!==rows.length)throw Error();
   const entries=rows.slice().reverse().filter(s=>/^ENTRY_.+/.test(s.sceneName)).map(s=>({sceneName:s.sceneName,sceneUuid:s.sceneUuid||null}));
   if(JSON.stringify(entries)!==JSON.stringify(this.entries))this.revision++;
   this.entries=entries;this.status=entries.length?'available':'empty';this.updatedUtc=new Date().toISOString();
   if(!entries.some(e=>e.sceneName===this.selected))this.selected=null;
  }catch{this.entries=[];this.selected=null;this.status='unavailable';this.revision++;this.updatedUtc=new Date().toISOString();}
  return this.snapshot();
 }
 select(name){if(this.status!=='available')return {ok:false,reason:'catalog_unavailable'};if(!this.entries.some(e=>e.sceneName===name))return {ok:false,reason:'entry_missing'};this.selected=name;return {ok:true};}
 move(delta){if(this.status!=='available')return {ok:false,reason:'catalog_unavailable'};const i=this.entries.findIndex(e=>e.sceneName===this.selected);const n=i<0?(delta>0?0:this.entries.length-1):i+delta;if(n<0||n>=this.entries.length)return {ok:false,reason:'selection_boundary'};return this.select(this.entries[n].sceneName);}
 snapshot(){return {status:this.status,revision:this.revision,updatedUtc:this.updatedUtc,selected:this.selected,entries:this.entries.map(e=>({...e})),order:'obs_frontend_top_to_bottom'};}
}
module.exports=ObsEntryCatalog;
