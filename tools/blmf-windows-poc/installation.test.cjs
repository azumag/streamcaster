'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {spawn,spawnSync}=require('child_process');
test('fresh generated installation serves UI while both OBS are offline; graceful shutdown',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'blmf-reproduction-'));
 let child;
 try {
  const generated=spawnSync('python',[path.join(__dirname,'setup.py'),'--home',home,'--config-only'],{encoding:'utf8'});
  assert.equal(generated.status,0,'configuration generation failed');
  fs.writeFileSync(path.join(home,'control/ui.local.json'),JSON.stringify({httpPort:0,udpPort:0}));
  child=spawn(process.execPath,[path.join(__dirname,'run.cjs')],{env:{...process.env,BLMF_POC_HOME:home},stdio:'ignore'});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  let status;
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
   try{status=JSON.parse(fs.readFileSync(path.join(home,'control/controller-status.json'),'utf8'));break;}catch{}
   await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(status,'isolated HTTP server did not start');
  const state=await(await fetch(status.origin+'/api/state')).json();
  assert.equal(state.service,'blmf-manual-osc');assert.equal(state.connected,false);
  const html=await(await fetch(status.origin)).text();assert.match(html,/OBSに再接続/);
  const response=await fetch(status.origin+'/api/action',{method:'POST',headers:{Origin:status.origin,'Content-Type':'application/json','X-BLMF-Local':'1'},body:JSON.stringify({action:'shutdown'})});
  assert.equal((await response.json()).ok,true);
  let timer;
  try{assert.equal(await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),5000);})]),0);}finally{clearTimeout(timer);}
  assert.equal(fs.existsSync(path.join(home,'control/local-sub-command.json')),false);
 }finally{
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  fs.rmSync(home,{recursive:true,force:true});
 }
});
