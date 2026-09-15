'use strict';
function mediaPresentation(m){
 const fmt=ms=>{if(!Number.isFinite(ms)||ms<0)return '—';const n=Math.floor(ms/1000);return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');};
 if(!m)return {state:'メディアなし',time:'— / —',remaining:'',ratio:0};
 const durationKnown=Number.isFinite(m.duration)&&m.duration>0;
 const valid=durationKnown&&Number.isFinite(m.cursor)&&m.cursor>=0;
 const labels={playing:'再生中',paused:'一時停止',ended:'再生終了',stopped:'停止',opening:'読込中',buffering:'バッファ中',error:'再生エラー',none:'待機'};
 const playlist=m.loopScope==='playlist';
 const remaining=m.state==='ended'?'素材終了（OBS確認）':m.state==='stopped'?'停止中':valid?(m.looping&&!playlist?'ループまで ':playlist?'現在項目の残り ':'残り ')+fmt(Math.max(0,m.duration-m.cursor)):durationKnown?'再生位置不明':'長さ不明';
 return {state:(labels[m.state]||'状態不明')+(m.looping?(playlist?' · リストループ':' · ループ'):''),time:fmt(m.cursor)+' / '+(durationKnown?fmt(m.duration):'—'),remaining,ratio:valid?Math.max(0,Math.min(1,m.cursor/m.duration)):0};
}
function mediaSelection(s,name){
 const available=!!s?.connected&&s.media?.scene===s.subScene&&Array.isArray(s.media?.sources);
 const sources=available?s.media.sources:[];
 const selected=sources.find(m=>m.name===name)||sources[0];
 const view=mediaPresentation(selected);
 return {sources,name:selected?.name||null,...view,state:available?view.state:'取得未確認',note:!available?'進行を取得できません。接続とSub OBSを確認してください。':sources.length?'Sub OBS上の進行です。素材終了と会場の受信終了は配信遅延により一致しません。':'現在シーンに表示中の動画・音声メディアはありません。'};
}
if(typeof module!=='undefined')module.exports={mediaPresentation,mediaSelection};
if(typeof document!=='undefined'){
const $=id=>document.getElementById(id);
let state,posting=false,pollTask;
let mediaName=null;
function renderMedia(s){
 const view=mediaSelection(s,mediaName),sources=view.sources;
 mediaName=view.name;
 const target=$('media-target');
 const names=sources.map(m=>m.name);
 if(JSON.stringify([...target.options].map(o=>o.value))!==JSON.stringify(names))target.replaceChildren(...names.map(n=>new Option(n,n)));
 target.value=mediaName||'';target.disabled=sources.length<2;
 $('media-state').textContent=view.state;
 $('media-time').textContent=view.time;$('media-remaining').textContent=view.remaining;$('media-progress').value=view.ratio;
 $('media-note').textContent=view.note;
}
$('media-target').addEventListener('change',()=>{mediaName=$('media-target').value;renderMedia(state);});
const catalogReasons={catalog_unavailable:'Subの一覧を取得できません。',entry_missing:'シーンがありません。',selection_required:'選択してください。',selection_changed:'一覧が変わりました。再選択してください。',selection_boundary:'一覧の端です。',proof_unsupported:'現在のPoC素材検証はこのシーンに未対応です。',already_active:'この動画は再生中です。'};
const reasons={reconnect_failed:'接続できないOBSがあります。Main/Subの起動と専用プロファイルを確認して、再接続してください。',reconnect_unsupported:'この接続モードは再接続に未対応です。',busy:'処理中です。完了後に操作してください。',runtime_unavailable:'OBS接続の準備ができていません。',check_failed:'検査できませんでした。接続とSub検証窓口を確認してください。',delivery_or_result_unconfirmed:'送信または結果を確認できませんでした。再操作前にOBSの現在シーンを確認してください。',invalid_action:'無効な操作です。'};
const stages={obs_confirmed:'OBS反映確認',bridge_accepted:'Bridge受付',rejected:'拒否',readback_failed:'OBS反映未確認'};
const rejection={director_required:'操作権がありません。',standby_required:'SubをSTANDBYに戻してください。',ndi_not_ready:'NDI検証条件が不成立です。累積ドロップ表示を確認してください。',asset_not_ready:'Sub素材の検証条件が不成立です。',freshness_failed:'検証の鮮度条件が不成立です。',not_ready:'実行条件が不成立です。',rearm_required:'OSCを0に戻して再受付してください。'};
function buttons(){
 const connected=state?.connected && state?.runtime==='connected',held=state?.isDirector,locked=posting||state?.busy;
 const catalog=state?.catalog,chosen=catalog?.entries?.find(e=>e.sceneName===catalog.selected);
 for(const b of document.querySelectorAll('[data-action]')){
  const a=b.dataset.action;
  b.disabled=locked||(a!=='refresh'&&!connected)||(a==='refresh'?false:a==='claim'?held:a==='release'?!held:a==='check'?false:!held);
  if(a==='reconnect'){b.hidden=!state?.canReconnect;b.disabled=locked||!state?.canReconnect;}
  if(['previous','next','execute'].includes(a))b.disabled ||= catalog?.status!=='available';
  if(a==='execute')b.disabled ||= !chosen?.executionSupported || state?.subScene===chosen?.sceneName;
 }
 const same=!!chosen && state?.subScene===chosen.sceneName;
 const reason=!connected?'OBSとの接続を確認してください。':!held?'「操作を開始」を押してください。':locked?'操作の反映を確認しています。':!chosen?'上の一覧で切替先を選んでください。':same?'Subはこのシーンです。Mainだけ変える場合は「Subを映す」を使います。':'';
 $('execute').textContent=same?'Subはこのシーンを出力中':chosen?chosen.sceneName+' に切り替える':'シーンを選んでください';
 $('execute-reason').textContent=reason || '実行するとSubが切り替わり、MainもSubの映像を表示します。';
 const index=catalog?.entries?.findIndex(e=>e.sceneName===catalog.selected)??-1;
 for(const b of document.querySelectorAll('[data-action="previous"],[data-action="next"]')){
  b.disabled ||= index>=0 && (b.dataset.action==='previous'?index===0:index===catalog.entries.length-1);
 }
 $('claim').hidden=!!held;$('release').hidden=!held;
 $('entry').disabled=locked||!connected||!held||catalog?.status!=='available';
}
function render(s){state=s;$('offline').hidden=true;renderMedia(s);
 const c=s.catalog||{entries:[],status:'unchecked'};
 const options=[new Option('— 選択してください —',''),...c.entries.map(e=>new Option(e.sceneName+(e.executionSupported?'':'（実行未対応）'),e.sceneName))];
 if(JSON.stringify([...$('entry').options].map(o=>[o.value,o.textContent]))!==JSON.stringify(options.map(o=>[o.value,o.textContent])))$('entry').replaceChildren(...options);
 $('entry').value=c.selected||'';
 $('catalog-status').textContent=c.status==='available'?c.entries.length+'件 · Sub OBS表示順（上→下）':c.status==='empty'?'ENTRY_シーンがありません。実行できません。':c.status==='unavailable'?'一覧取得失敗。実行できません。':'一覧未取得';
 const chosen=c.entries.find(e=>e.sceneName===c.selected);
 $('selected-name').textContent=chosen?.sceneName||'未選択';
 $('entry-support').textContent=chosen?'Sub → '+chosen.sceneName+'　／　Main → Subの映像':'切替先を選んでください。';
 $('main-label').textContent=!s.connected?'接続未確認':s.mainScene==='VRC_VENUE'?'会場':s.mainScene==='ENTRY_FULLSCREEN'?'Subの映像':'その他のシーン';
 $('venue').setAttribute('aria-pressed',String(s.connected && s.mainScene==='VRC_VENUE'));
 $('show-ndi').setAttribute('aria-pressed',String(s.connected && s.mainScene==='ENTRY_FULLSCREEN'));
 $('main-action-hint').textContent=s.mainScene==='ENTRY_FULLSCREEN'?'現在、MainはSubの映像を表示しています。':s.mainScene==='VRC_VENUE'?'現在、Mainは会場を表示しています。':'';
 $('connection').textContent=s.connected?'接続確認済み':s.runtime==='starting'?'接続準備中':`Main: ${s.mainConnected?'接続':'未接続'} / Sub: ${s.subConnected?'接続':'未接続'}`;
 $('helper').textContent=c.status==='available'?c.entries.length+'件取得済み':c.status==='empty'?'対象シーンなし':'未取得 / 取得失敗';
 const drops=s.ndiDropped&&Object.values(s.ndiDropped).every(Number.isInteger)?Object.values(s.ndiDropped).reduce((a,b)=>a+b,0):null;
 $('ndi').textContent=s.ndiMonitoring===false?'常時計測なし':drops>0?'累積ドロップ '+drops+'件':s.ndiHealthy?'受信正常 / drop 0':'未確認 / 不安定';$('director').textContent=s.isDirector?'操作できます':'表示のみ';
 for(const [id,ok] of [['connection',s.connected],['helper',c.status==='available'],['ndi',s.ndiHealthy],['director',s.isDirector]])$(id).className=ok?'good':'warning';
 $('transport').textContent='OSC '+s.udpEndpoint;$('main-scene').textContent=s.mainScene||'—';$('sub-scene').textContent=s.subScene||'—';
 $('readback-time').textContent=s.readbackUtc?'OBS確認 '+new Date(s.readbackUtc).toLocaleTimeString('ja-JP'):'OBS反映未確認';
 $('ready').textContent=s.connected?'シーン切替可能（操作権取得・選択後）':'接続未確認';
 $('busy').textContent=s.busy||posting?'処理中':'待機中';
 $('events').replaceChildren(...s.events.slice(0,8).map(e=>{const li=document.createElement('li'),time=document.createElement('time'),text=document.createElement('span');time.textContent=e.receivedUtc?.slice(11,23)+' UTC';text.textContent=(stages[e.stage]||e.stage)+' · '+(e.address?.endsWith('entry-scene')?e.value:({250:'操作権取得',251:'操作権解放',3:'会場表示',5:'NDI表示',4:'Sub STANDBY',6:'前を選択',7:'次を選択',8:'選択中を実行'}[e.value]||'OSC'))+(e.readbackUtc?' · '+e.mainScene+' / '+e.subScene:'');li.append(time,text);return li;}));buttons();
}
function poll(){
 if(pollTask)return pollTask;
 pollTask=(async()=>{const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),5000);
  try{const r=await fetch('/api/state',{cache:'no-store',signal:abort.signal});if(!r.ok)throw Error();render(await r.json());}
  catch{$('offline').hidden=false;$('connection').textContent='接続未確認';$('connection').className='warning';state=null;renderMedia(null);buttons();}
  finally{clearTimeout(timer);pollTask=null;}
 })();return pollTask;
}
$('entry').addEventListener('change',async()=>{if(posting)return;posting=true;const name=$('entry').value;buttons();try{const v=await sendAction('select',name);$('notice').textContent=v.ok?'選択を更新しました。再生は変更していません。':catalogReasons[v.reason||v.event?.reason]||'選択できませんでした。';}catch{$('notice').textContent='選択結果を確認できませんでした。';}finally{posting=false;await poll();}});
async function sendAction(action,entryId){const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-BLMF-Local':'1'},body:JSON.stringify({action,entryId})});return r.json();}
for(const b of document.querySelectorAll('[data-action]'))b.addEventListener('click',async()=>{
 if(posting)return;posting=true;buttons();$('notice').textContent='操作の反映を確認しています…';
 try{const v=await sendAction(b.dataset.action);
 const success={reconnect:'Main / Subに再接続しました。シーン・再生・配信は変更していません。',claim:'操作を開始しました。',release:'操作を終了しました。',refresh:'シーン一覧を更新しました。',check:'接続と一覧を確認しました。',previous:'前のシーンを選びました。映像は変更していません。',next:'次のシーンを選びました。映像は変更していません。',execute:'選んだシーンへ切り替え、Mainにも表示しました。',venue:'Mainを会場表示に切り替えました。',ndi:'MainをSubの映像に切り替えました。',standby:'Subを待機画面に切り替えました。配信の開始・停止は行いません。'};
 $('notice').textContent=v.event?(v.event.accepted && v.event.stage!=='readback_failed'?success[b.dataset.action]||'操作を受け付けました。':v.event.stage==='readback_failed'?'OBSへの反映を確認できません。現在の映像を確認してください。':catalogReasons[v.event.reason]||rejection[v.event.reason]||'操作できませんでした。'):v.ok?success[b.dataset.action]||'確認しました。':catalogReasons[v.reason]||reasons[v.reason]||rejection[v.reason]||'操作できませんでした。';
 }catch{$('notice').textContent='結果を取得できませんでした。再操作前にOBSの現在シーンを確認してください。';}finally{posting=false;await poll();}});
(async()=>{await poll();try{await sendAction('refresh');}catch{}await poll();})();setInterval(poll,1500);
}
