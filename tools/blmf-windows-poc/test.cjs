'use strict';
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const files=fs.readdirSync(__dirname).filter(n=>n.endsWith('.test.cjs')).sort().map(n=>path.join(__dirname,n));
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
process.exitCode=result.status??1;
