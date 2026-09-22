'use strict';
const $ = id => document.getElementById(id);
let ws = null, state = null, client = null, authenticated = false, wasMoving = false;
let photoAt = null, savingSlot = null, owned = false;
// The page connects and claims by itself, but only until the operator says
// otherwise: pressing 切断 means stop, not "try again in three seconds".
let wanted = true, claimed = false, retry = null;
const keys = new Set(), pointers = new Map();
const mapping = {KeyA:[0,-1],KeyD:[0,1],KeyW:[1,1],KeyS:[1,-1],KeyE:[2,1],KeyQ:[2,-1],ArrowLeft:[3,-1],ArrowRight:[3,1],ArrowUp:[4,-1],ArrowDown:[4,1]};
function own() { return authenticated && state && state.owner === client; }
function send(message) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
function notify(message) { $('message').textContent = message; }
function toast(message, kind = 'error') {
  // Errors used to land in one status line that is easy to miss mid-operation.
  const item = document.createElement('div');
  item.className = 'toast ' + kind;
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  item.textContent = message;
  item.onclick = () => item.remove();
  $('toasts').prepend(item);
  while ($('toasts').childElementCount > 4) $('toasts').lastElementChild.remove();
  setTimeout(() => item.remove(), kind === 'error' ? 8000 : 4000);
  notify(message);
}
function clearToasts(kind) {
  document.querySelectorAll('#toasts .toast.' + kind).forEach(item => item.remove());
}
function showPhoto(at) {
  const img = $('photo');
  if (at === null || at === undefined) {
    photoAt = null; img.hidden = true; img.removeAttribute('src');
    $('photoState').textContent = '写真なし（保存フォルダ未設定か、まだ撮影されていません）';
    return;
  }
  if (at === photoAt) return;
  photoAt = at;
  // The trailing number is only a cache key: the server always answers with
  // its own newest file, and the UI never names one.
  img.src = '/photo/' + Math.round(at * 1000);
  img.hidden = false;
  $('photoState').textContent = '最新の写真 ' + new Date(at * 1000).toLocaleTimeString('ja-JP');
}
function clearInput(stop = true) {
  keys.clear(); pointers.clear(); wasMoving = false;
  if (stop && own()) send({op:'stop'});
}
function leaveControls() {
  // Leaving this page drops held keys - a keyup never arrives once the window
  // is gone - but it must NOT cancel a preset move. Watching the camera means
  // looking at VRChat, and a full STOP here froze the shot mid-transition and
  // disarmed, exactly when the operator went to watch it land.
  keys.clear(); pointers.clear(); wasMoving = false;
  if (own() && state.armed) {
    send({op:'motion', axes:[0,0,0,0,0], speed:Number($('speed').value), turnSpeed:Number($('turn').value)});
  }
}
// One line answering "can I move the camera right now, and if not, what do I
// do about it?" Every blocking condition says so before an operation is tried,
// because a disabled button explains nothing to the person pressing it.
function headline(s) {
  if (!authenticated || !s) return ['wait', ws ? '接続しています…' : '切断しました。「接続」を押してください。'];
  if (!own()) return ['warn', s.owner ? `${s.ownerName || '別の担当者'}が操作中です。`
    : '操作権がありません。「操作権を取得」を押してください。'];
  if (s.contactLost) return ['warn', '接触喪失：VRChat内でカメラを動かすと復帰します。'];
  if (!s.observed.Pose) return ['warn', 'VRChat内でカメラを一度動かしてください（位置を未受信）。'];
  if (s.observed.Zoom === undefined) return ['warn', 'VRChatでZoomスライダーを一度動かしてください（Zoomを未受信）。'];
  if (!s.poseWriteEnabled) return ['warn', '位置操作は無効です。保存と撮影のみ使えます。'];
  if (!s.armed) return ['warn', '「受信した位置でARM」を押すと移動・呼出ができます。保存と撮影は今でもできます。'];
  if (s.transitioning) return ['go', 'プリセット移動中です。'];
  return ['go', '操作できます。'];
}
function availability() {
  const owner = own(), armed = owner && state.armed;
  $('claim').disabled = !authenticated || (state && state.owner && !owner);
  $('release').disabled = !owner;
  $('arm').disabled = !owner || !state.poseWriteEnabled;
  $('stop').disabled = !authenticated;
  $('disconnect').disabled = !ws;
  $('connect').disabled = !!ws;
  document.querySelectorAll('[data-setting],#profile,#setProfile,[data-save],#capture').forEach(e => e.disabled = !owner);
  document.querySelectorAll('[data-axis]').forEach(e => e.disabled = !armed);
  document.querySelectorAll('[data-recall]').forEach(e => e.disabled = !armed || !state.presets[e.dataset.recall]);
}
function showHeadline(s) {
  const [level, text] = headline(s);
  $('headline').className = 'headline ' + level;
  $('headline').textContent = text;
}
function render(s) {
  state = s;
  if (owned && !own()) toast('操作権が外れました。「操作権を取得」を押し直してください。');
  owned = own();
  showHeadline(s);
  $('owner').textContent = own() ? 'あなたが操作中'
    : s.owner ? `${s.ownerName || '別の担当者'}が操作中` : '空き';
  // Three different situations that all used to read as「未受信」.
  $('feedback').textContent = s.contactLost ? '接触喪失'
    : s.oscAge !== null ? `${s.oscAge.toFixed(1)}秒前`
    : s.anyOscAge === null ? 'VRChatから受信なし'
    : 'カメラ値のみ未受信';
  $('armStatus').textContent = s.armed ? (s.transitioning ? 'プリセット移動中' : 'ARM済み') : '停止 / 未ARM';
  $('poseWarning').textContent = s.poseWriteEnabled ? 'Pose書き込みは試験機能です。OSC受信は書き込み対応の証明ではありません。映像を見ながら少量ずつ確認してください。' : '位置操作は無効です。実機リハーサル時に --enable-pose-write で起動してください。';
  $('observed').textContent = JSON.stringify(s.observed, null, 2);
  $('requested').textContent = JSON.stringify({...s.requested, Pose:s.commandedPose}, null, 2);
  $('reason').textContent = `${s.reason} / UDP送信 ${s.sent} / 非対応・不正OSC ${s.invalidOsc}${s.udpError ? ' / UDPエラー: '+s.udpError : ''}`;
  if ($('profile').dataset.activeProfile !== s.profile) {
    $('profile').value = s.profile; $('profile').dataset.activeProfile = s.profile;
  }
  for (let i = 1; i <= 8; i++) {
    const saved = s.presets[String(i)], name = $('name'+i);
    $('presetState'+i).textContent = saved ? saved.name : '未保存';
    $('presetValue'+i).textContent = saved
      ? `Zoom ${saved.zoom.toFixed(1)} / x ${saved.pose[0].toFixed(2)} y ${saved.pose[1].toFixed(2)} z ${saved.pose[2].toFixed(2)}`
      : '';
    if (document.activeElement !== name && name.dataset.profile !== s.profile) {
      name.value = saved ? saved.name : `CAM ${i}`;
      name.dataset.profile = s.profile;
    }
  }
  showPhoto(s.photoAt);
  // Never fire change events or automatically resend controls from feedback.
  // Inputs represent operator intentions; observed values are shown separately.
  availability();
}
function connect() {
  if (ws) return;
  wanted = true; claimed = false;
  clearTimeout(retry); retry = null;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  $('connection').textContent = '接続中';
  showHeadline(null); availability();
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.type === 'authenticated') {
      authenticated = true; client = data.client;
      $('connection').textContent = '認証済み'; $('operator').textContent = data.operator;
      // Claiming moves nothing: only ARM plus a deliberate input does. So the
      // page takes control for you, and never arms for you.
      if (!claimed) { claimed = true; send({op:'claim'}); }
    } else if (data.type === 'state') render(data);
    else if (data.type === 'error') toast(data.message);
    else if (data.type === 'accepted') {
      // A refused save must not consume the overwrite confirmation, so only a
      // server-side acceptance clears it.
      if (data.op === 'save') {
        document.querySelectorAll('[data-save]').forEach(b => b.dataset.confirmUntil = '0');
        // Overwriting a preset with the same name changes nothing on screen, so
        // without this a stored save is indistinguishable from a refused one.
        clearToasts('notice');
        toast(`CAM ${savingSlot} に保存しました。`, 'ok');
      }
      if (data.op === 'capture') $('photoState').textContent = '撮影を指示しました。保存され次第更新します。';
      notify(`受付: ${data.op}（VRChatへの適用はOSC受信値・映像で確認）`);
    }
  });
  ws.addEventListener('close', () => {
    clearInput(false); ws = null; authenticated = false; client = null; state = null; owned = false;
    $('gamepad').checked = false; $('connection').textContent = '未接続'; $('owner').textContent = '未取得';
    $('operator').textContent = '未接続';
    $('armStatus').textContent = '停止 / 未ARM'; $('feedback').textContent = '切断（値は履歴）';
    // Reconnecting restores the connection and the claim, never the motion:
    // the server disarms on disconnect and only a person can arm again.
    if (wanted) {
      notify('接続が切れました。3秒後に自動で接続し直します。ARMは解除されています。');
      retry = setTimeout(connect, 3000);
    } else {
      notify('切断しました。自動再開はしません。');
    }
    showHeadline(null); availability();
  });
  ws.addEventListener('error', () => notify('接続失敗。Tailscale接続、grants/ACL、public-originとサーバーを確認してください。'));
}
$('login').addEventListener('submit', event => { event.preventDefault(); connect(); });
$('disconnect').onclick = () => {
  wanted = false; clearTimeout(retry); retry = null;
  clearInput(); if (ws) ws.close();
};
for (const op of ['claim','release','arm','stop']) $(op).onclick = () => { clearInput(false); send({op}); };
$('capture').onclick = () => send({op:'capture'});
$('photo').onerror = () => { $('photo').hidden = true; $('photoState').textContent = '写真を読み込めませんでした。'; };
$('setProfile').onclick = () => { clearInput(); send({op:'profile',value:$('profile').value}); };
document.querySelectorAll('[data-setting]').forEach(el => {
  el.addEventListener('change', () => send({op:'set',name:el.dataset.setting,value:el.type === 'checkbox' ? el.checked : Number(el.value)}));
});
for (const [input,output] of [['zoom','zoomValue'],['smoothing','smoothingValue'],['speed','speedValue'],['turn','turnValue']]) {
  $(input).oninput = () => $(output).textContent = $(input).value;
}
document.querySelectorAll('[data-axis]').forEach(el => {
  el.addEventListener('pointerdown', event => {
    if (!own() || !state.armed) return;
    event.preventDefault(); el.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, el.dataset.axis.split(':').map(Number));
  });
  for (const name of ['pointerup','pointercancel','lostpointercapture']) el.addEventListener(name, event => pointers.delete(event.pointerId));
});
const editing = el => el && ['INPUT','TEXTAREA','SELECT'].includes(el.tagName);
window.addEventListener('keydown', event => {
  if (!own() || !state.armed || editing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); clearInput(); return; }
  if (mapping[event.code]) { event.preventDefault(); keys.add(event.code); }
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => leaveControls());
window.addEventListener('pagehide', () => clearInput());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) leaveControls();
  else if (own()) send({op:'heartbeat'});  // back from VRChat: reassert at once
});
// Clicks on touch controls use pointer capture; focus leaving the document stops.
// Keep the claim alive even while hidden. Browsers throttle this to roughly
// once a minute in a background tab, which the server's lease now tolerates.
setInterval(() => { if (own()) send({op:'heartbeat'}); }, 400);
setInterval(() => {
  if (!own() || !state.armed || document.hidden || !document.hasFocus()) return;
  const axes = [0,0,0,0,0];
  for (const key of keys) { const [i,v] = mapping[key]; axes[i] += v; }
  for (const [i,v] of pointers.values()) axes[i] += v;
  if ($('gamepad').checked && navigator.getGamepads) {
    const pad = Array.from(navigator.getGamepads()).find(p => p && p.mapping === 'standard');
    const deadzone = v => Math.abs(v || 0) < 0.15 ? 0 : Math.sign(v) * (Math.abs(v)-0.15)/0.85;
    if (pad && pad.buttons[5] && pad.buttons[5].pressed) {
      axes[0] += deadzone(pad.axes[0]); axes[1] -= deadzone(pad.axes[1]);
      axes[3] += deadzone(pad.axes[2]); axes[4] += deadzone(pad.axes[3]);
      axes[2] += (pad.buttons[7]?.value || 0) - (pad.buttons[6]?.value || 0);
    }
  }
  const normalized = axes.map(v => Math.max(-1,Math.min(1,v))), moving = normalized.some(v => v !== 0);
  if (moving || wasMoving) send({op:'motion',axes:normalized,speed:Number($('speed').value),turnSpeed:Number($('turn').value)});
  wasMoving = moving;
}, 50);
for (let i = 1; i <= 8; i++) {
  const box = document.createElement('div'); box.className = 'preset';
  const title = document.createElement('strong'); title.textContent = `CAM ${i}`;
  const status = document.createElement('p'); status.id = 'presetState'+i; status.textContent = '未保存'; status.className = 'name';
  const values = document.createElement('p'); values.id = 'presetValue'+i; values.className = 'stored';
  const name = document.createElement('input'); name.id = 'name'+i; name.maxLength = 48; name.value = `CAM ${i}`; name.setAttribute('aria-label',`CAM ${i} 保存名`);
  const actions = document.createElement('div'); actions.className = 'actions';
  const recall = document.createElement('button'); recall.textContent = '呼出'; recall.dataset.recall = String(i); recall.disabled = true;
  recall.onclick = () => { clearInput(false); send({op:'recall',slot:String(i),duration:Number($('duration').value)}); };
  const save = document.createElement('button'); save.textContent = '保存'; save.dataset.save = String(i); save.disabled = true;
  save.onclick = () => {
    // Non-blocking overwrite confirmation keeps the heartbeat running.
    if (state && state.presets[String(i)] && Date.now() > Number(save.dataset.confirmUntil || 0)) {
      save.dataset.confirmUntil = String(Date.now() + 5000);
      toast(`CAM ${i} を上書きするには5秒以内にもう一度「保存」を押してください。`, 'notice'); return;
    }
    savingSlot = i;
    send({op:'save',slot:String(i),name:name.value});
  };
  actions.append(recall,save); box.append(title,status,values,name,actions); $('presets').append(box);
}
availability();
connect();
