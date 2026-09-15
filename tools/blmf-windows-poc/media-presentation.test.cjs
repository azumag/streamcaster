'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mediaPresentation:p,mediaSelection:select}=require('./manual-controller/app.js');
const media=(overrides={})=>({name:'Movie',state:'playing',cursor:30000,duration:120000,looping:false,...overrides});
test('elapsed, duration, remaining and progress use the OBS sample',()=>{
 assert.deepEqual(p(media()),{state:'再生中',time:'0:30 / 2:00',remaining:'残り 1:30',ratio:.25});
 assert.equal(p(media({cursor:3600123,duration:7200000})).time,'60:00 / 120:00');
});
test('only OBS ended means ended, even at/past the duration or while looping',()=>{
 for(const state of ['playing','paused','stopped'])assert.doesNotMatch(p(media({state,cursor:120000})).state,/再生終了/);
 assert.equal(p(media({state:'ended',cursor:0})).state,'再生終了');
 assert.equal(p(media({state:'ended',cursor:0})).remaining,'素材終了（OBS確認）');
 assert.equal(p(media({state:'ended',looping:true})).state,'再生終了 · ループ');
 assert.equal(p(media({cursor:130000})).ratio,1);
});
test('loop wrap is reported without extrapolation; VLC duration is the current item',()=>{
 assert.equal(p(media({looping:true,cursor:119000})).remaining,'ループまで 0:01');
 assert.equal(p(media({looping:true,cursor:1000})).ratio,1/120);
 assert.equal(p(media({looping:true,cursor:1000})).remaining,'ループまで 1:59');
 assert.equal(p(media({looping:true,loopScope:'playlist'})).remaining,'現在項目の残り 1:30');
 assert.equal(p(media({looping:true,loopScope:'playlist'})).state,'再生中 · リストループ');
});
test('paused/stopped/error/loading states and unavailable lengths remain explicit',()=>{
 for(const [state,label] of Object.entries({paused:'一時停止',stopped:'停止',error:'再生エラー',opening:'読込中',buffering:'バッファ中',none:'待機',unknown:'状態不明'}))assert.equal(p(media({state})).state,label);
 assert.equal(p(media({state:'stopped',cursor:0})).remaining,'停止中');
 for(const duration of [0,-1,null,NaN,Infinity]){
  const v=p(media({duration}));assert.equal(v.time,'0:30 / —');assert.equal(v.remaining,'長さ不明');assert.equal(v.ratio,0);
 }
 assert.equal(p(media({cursor:-1})).remaining,'再生位置不明');
 assert.equal(p(media({cursor:-1})).time,'— / 2:00');
});
test('selection persists through reordering, changes on removal and ignores Main scene',()=>{
 const s={connected:true,mainScene:'VRC_VENUE',subScene:'ENTRY_001',media:{scene:'ENTRY_001',sources:[media(),media({name:'Music'})]}};
 assert.equal(select(s,'Music').name,'Music');s.media.sources.reverse();assert.equal(select(s,'Music').name,'Music');
 s.media.sources.pop();assert.equal(select(s,'Movie').name,'Music');
 assert.match(select(s).note,/素材終了と会場の受信終了/);
});
test('disconnect, missing observation and scene races clear stale progress, distinct from empty',()=>{
 const s={connected:true,subScene:'ENTRY_001',media:{scene:'ENTRY_001',sources:[media()]}};
 for(const unavailable of [null,{...s,connected:false},{...s,media:null},{...s,subScene:'STANDBY'}]){
  const v=select(unavailable,'Movie');assert.equal(v.state,'取得未確認');assert.equal(v.time,'— / —');assert.equal(v.ratio,0);assert.equal(v.sources.length,0);assert.match(v.note,/取得できません/);
 }
 s.media.sources=[];assert.equal(select(s).state,'メディアなし');assert.match(select(s).note,/ありません/);
});
