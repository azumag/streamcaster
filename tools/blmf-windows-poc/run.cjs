'use strict';
const fs=require('fs'),path=require('path');
const OBS=require('obs-websocket-js').default;
const paths=require('./paths.cjs');
const {createLocalSubAdapter}=require('./local-sub-adapter.cjs');
const {createReconnectableRuntime}=require('./reconnectable-local-runtime.cjs');
const {createManualController}=require('./manual-osc-controller.cjs');
let manual;
const runtime=createReconnectableRuntime({createMain:()=>new OBS(),createSub:()=>createLocalSubAdapter({directory:paths.control}),readConfig:()=>JSON.parse(fs.readFileSync(path.join(paths.main,'config/obs-studio/plugin_config/obs-websocket/config.json'),'utf8'))});
(async()=>{try{
 if(!fs.existsSync(path.join(paths.home,'poc-install.json')))throw Error('setup_required');
 const configPath=path.join(paths.control,'ui.local.json');
 const config=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{};
 manual=await createManualController({publicOrigin:config.publicOrigin||null,httpPort:config.httpPort??18765,udpPort:config.udpPort??9001});
 fs.writeFileSync(path.join(paths.control,'controller-status.json'),JSON.stringify({pid:process.pid,origin:manual.origin,udpPort:manual.udpPort,startedUtc:new Date().toISOString()}));
 await manual.attach(runtime);
 process.on('SIGINT',()=>manual.close());process.on('SIGTERM',()=>manual.close());
 await manual.reconnect();console.log('BLMF controller ready at '+manual.origin+'; no scene or output commands issued.');await manual.done;
}catch{console.error('BLMF controller unavailable. Check installation and port availability; credentials are not logged.');if(manual)await manual.close();process.exitCode=1;}finally{await runtime.close();}})();
