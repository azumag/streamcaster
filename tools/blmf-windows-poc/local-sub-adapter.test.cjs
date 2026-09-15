const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createLocalSubAdapter}=require('./local-sub-adapter.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'blmf-local-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const s={profile:'BLMF Windows Sub PoC',collection:'BLMF Windows Sub PoC',session:'one',observedAt:100,programScene:'STANDBY',scenes:[{sceneName:'ENTRY_NEW'},{sceneName:'STANDBY'}]};const save=()=>fs.writeFileSync(path.join(directory,'local-sub-state.json'),JSON.stringify(s));save();return {s,save,directory,a:createLocalSubAdapter({directory,now:()=>100000,timeoutMs:200})};}
test('live catalog and ack; unknown scenes never create command',async t=>{const f=fixture(t);assert.equal((await f.a.getSceneList()).scenes[0].sceneName,'ENTRY_NEW');await assert.rejects(f.a.setProgramScene('ENTRY_UNKNOWN'));assert.equal(fs.existsSync(path.join(f.directory,'local-sub-command.json')),false);const pending=f.a.setProgramScene('ENTRY_NEW');const cmd=JSON.parse(fs.readFileSync(path.join(f.directory,'local-sub-command.json')));f.s.commandId=cmd.id;f.s.programScene='ENTRY_NEW';f.save();await pending;});
test('reject stale, malformed freshness and wrong identity',async t=>{for(const update of [{observedAt:95},{observedAt:null},{observedAt:'bad'},{profile:'Other'}]){const f=fixture(t);Object.assign(f.s,update);f.save();await assert.rejects(f.a.getProgramScene());}});
test('Sub restart requires reconnection and old session cannot execute',async t=>{const f=fixture(t);await f.a.getProgramScene();f.s.session='two';f.save();await assert.rejects(f.a.setProgramScene('ENTRY_NEW'));assert.equal(fs.existsSync(path.join(f.directory,'local-sub-command.json')),false);});
test('writing a command is not treated as success without acknowledgement',async t=>{const f=fixture(t);await assert.rejects(f.a.setProgramScene('ENTRY_NEW'),/unconfirmed/);});
test('media is allowlisted, sampled with the scene, and read-only',async t=>{
 const f=fixture(t);f.s.mediaSources=[{name:'Movie',state:'paused',cursor:12000,duration:60000,looping:true,loopScope:'source',settings:{local_file:'must-not-escape'},path:'must-not-escape'}];f.save();
 assert.deepEqual(await f.a.getMediaSources(),{scene:'STANDBY',observedAt:100,sources:[{name:'Movie',state:'paused',cursor:12000,duration:60000,looping:true,loopScope:'source'}]});
 assert.equal(fs.existsSync(path.join(f.directory,'local-sub-command.json')),false);
 f.s.mediaSources=[];f.save();assert.deepEqual((await f.a.getMediaSources()).sources,[]);
});
test('old/malformed observer is unavailable; stale/restarted media is never accepted',async t=>{
 const f=fixture(t);await assert.rejects(f.a.getMediaSources(),/sub_media_unavailable/);
 for(const rows of [{},[null],[{name:'Movie',state:'playing',cursor:'12',duration:0}]]){f.s.mediaSources=rows;f.save();await assert.rejects(f.a.getMediaSources(),/sub_media_unavailable/);}
 f.s.mediaSources=[];f.s.observedAt=90;f.save();await assert.rejects(f.a.getMediaSources(),/sub_state_unavailable/);
 f.s.observedAt=100;f.s.session='new';f.save();await assert.rejects(f.a.getMediaSources(),/sub_session_changed/);
});
