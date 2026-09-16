'use strict';
const $ = id => document.getElementById(id);
let ws = null, state = null, client = null, authenticated = false, wasMoving = false;
const keys = new Set(), pointers = new Map();
const mapping = {KeyA:[0,-1],KeyD:[0,1],KeyW:[1,1],KeyS:[1,-1],KeyE:[2,1],KeyQ:[2,-1],ArrowLeft:[3,-1],ArrowRight:[3,1],ArrowUp:[4,-1],ArrowDown:[4,1]};
function own() { return authenticated && state && state.owner === client; }
function send(message) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
function notify(message) { $('message').textContent = message; }
function clearInput(stop = true) {
  keys.clear(); pointers.clear(); wasMoving = false;
  if (stop && own()) send({op:'stop'});
}
function availability() {
  const owner = own(), armed = owner && state.armed;
  $('claim').disabled = !authenticated || (state && state.owner && !owner);
  $('release').disabled = !owner;
  $('arm').disabled = !owner || !state.poseWriteEnabled;
  $('stop').disabled = !authenticated;
  $('disconnect').disabled = !ws;
  $('connect').disabled = !!ws;
  document.querySelectorAll('[data-setting],#profile,#setProfile,[data-save]').forEach(e => e.disabled = !owner);
  document.querySelectorAll('[data-axis]').forEach(e => e.disabled = !armed);
  document.querySelectorAll('[data-recall]').forEach(e => e.disabled = !armed || !state.presets[e.dataset.recall]);
}
function render(s) {
  state = s;
  if (!s.armed || !own()) { keys.clear(); pointers.clear(); wasMoving = false; }
  $('owner').textContent = own() ? 'あなたが操作中'
    : s.owner ? `${s.ownerName || '別の担当者'}が操作中` : '空き';
  $('feedback').textContent = s.oscAge === null ? '未受信' : `${s.oscAge.toFixed(1)}秒前`;
  $('armStatus').textContent = s.armed ? (s.transitioning ? 'プリセット移動中' : 'ARM済み') : '停止 / 未ARM';
  $('poseWarning').textContent = s.poseWriteEnabled ? 'Pose書き込み試験モード。OSC受信は書き込み対応の証明ではありません。映像を見ながら少量ずつ確認してください。' : '位置操作は無効です。実機リハーサル時に --enable-pose-write で起動してください。';
  $('observed').textContent = JSON.stringify(s.observed, null, 2);
  $('requested').textContent = JSON.stringify({...s.requested, Pose:s.commandedPose}, null, 2);
  $('reason').textContent = `${s.reason} / UDP送信 ${s.sent} / 非対応・不正OSC ${s.invalidOsc}${s.udpError ? ' / UDPエラー: '+s.udpError : ''}`;
  if ($('profile').dataset.activeProfile !== s.profile) {
    $('profile').value = s.profile; $('profile').dataset.activeProfile = s.profile;
  }
  for (let i = 1; i <= 8; i++) {
    const saved = s.presets[String(i)], name = $('name'+i);
    $('presetState'+i).textContent = saved ? saved.name : '未保存';
    if (document.activeElement !== name && name.dataset.profile !== s.profile) {
      name.value = saved ? saved.name : `CAM ${i}`;
      name.dataset.profile = s.profile;
    }
  }
  // Never fire change events or automatically resend controls from feedback.
  // Inputs represent operator intentions; observed values are shown separately.
  availability();
}
$('login').addEventListener('submit', event => {
  event.preventDefault();
  if (ws) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  $('connection').textContent = '接続中'; availability();
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.type === 'authenticated') {
      authenticated = true; client = data.client;
      $('connection').textContent = '認証済み'; $('operator').textContent = data.operator;
      notify('操作権を取得してください。接続しただけではカメラを動かしません。');
    } else if (data.type === 'state') render(data);
    else if (data.type === 'error') notify(data.message);
    else if (data.type === 'accepted') notify(`受付: ${data.op}（VRChatへの適用はOSC受信値・映像で確認）`);
  });
  ws.addEventListener('close', () => {
    clearInput(false); ws = null; authenticated = false; client = null; state = null;
    $('gamepad').checked = false; $('connection').textContent = '未接続'; $('owner').textContent = '未取得';
    $('operator').textContent = '未接続';
    $('armStatus').textContent = '停止 / 未ARM'; $('feedback').textContent = '接続切断（値は履歴）';
    notify('接続が終了しました。自動再開はしません。必要に応じて再接続・操作権取得・ARMしてください。'); availability();
  });
  ws.addEventListener('error', () => notify('接続失敗。Tailscale接続、grants/ACL、public-originとサーバーを確認してください。'));
});
$('disconnect').onclick = () => { clearInput(); if (ws) ws.close(); };
for (const op of ['claim','release','arm','stop']) $(op).onclick = () => { clearInput(false); send({op}); };
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
window.addEventListener('blur', () => clearInput());
window.addEventListener('pagehide', () => clearInput());
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
// Clicks on touch controls use pointer capture; focus leaving the document stops.
setInterval(() => { if (own() && !document.hidden) send({op:'heartbeat'}); }, 400);
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
  const status = document.createElement('p'); status.id = 'presetState'+i; status.textContent = '未保存'; status.className = 'muted';
  const name = document.createElement('input'); name.id = 'name'+i; name.maxLength = 48; name.value = `CAM ${i}`; name.setAttribute('aria-label',`CAM ${i} 保存名`);
  const actions = document.createElement('div'); actions.className = 'actions';
  const recall = document.createElement('button'); recall.textContent = '呼出'; recall.dataset.recall = String(i); recall.disabled = true;
  recall.onclick = () => { clearInput(false); send({op:'recall',slot:String(i),duration:Number($('duration').value)}); };
  const save = document.createElement('button'); save.textContent = '保存'; save.dataset.save = String(i); save.disabled = true;
  save.onclick = () => {
    // Non-blocking overwrite confirmation keeps the heartbeat running.
    if (state && state.presets[String(i)] && Date.now() > Number(save.dataset.confirmUntil || 0)) {
      save.dataset.confirmUntil = String(Date.now() + 5000);
      notify(`CAM ${i} を上書きするには5秒以内にもう一度「保存」を押してください。`); return;
    }
    save.dataset.confirmUntil = '0';
    send({op:'save',slot:String(i),name:name.value});
  };
  actions.append(recall,save); box.append(title,status,name,actions); $('presets').append(box);
}
availability();
