"""Offline DOM smoke with a fake WebSocket; NOT a VRChat/network/browser integration test."""
import asyncio, re, os, shutil
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]/'public'
FAKE=r'''
window.cameraTest={messages:[]};
const fixture={type:'state',client:'offline',owner:null,armed:false,poseWriteEnabled:true,profile:'default',observed:{Pose:[10,2,20,0,0,0],Zoom:45,Mode:2},requested:{},commandedPose:null,transitioning:false,oscAge:0,anyOscAge:0,poseAge:0,reason:'Offline UI fixture',sent:0,invalidOsc:0,contactLost:false,captureAge:null,udpError:null,photoAt:null,presets:{}};
window.WebSocket=class extends EventTarget {
 static OPEN=1;
 constructor(){super();this.readyState=1;queueMicrotask(()=>{this.dispatchEvent(new Event('open'));
  this.event({type:'authenticated',client:'offline',operator:'localhost'});this.event(fixture);});}
 event(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
 send(raw){const m=JSON.parse(raw);cameraTest.messages.push(m);
 if(m.op==='claim')fixture.owner='offline';
 if(m.op==='release')fixture.owner=null;
 if(m.op==='arm')fixture.armed=true;
 if(m.op==='stop'){fixture.armed=false;fixture.transitioning=false;}
 if(m.op==='profile'){fixture.profile=m.value;fixture.armed=false;}
 if(m.op==='set'){fixture.requested[m.name]=m.value;fixture.sent++;}
 if(m.op==='motion'){fixture.commandedPose=[10,2,20.2,0,0,0];fixture.sent++;}
 if(m.op==='save'){
  if(cameraTest.refuseSave){this.event({type:'error',message:'Need observed Zoom; move its slider in VRChat first'});return;}
  fixture.presets[m.slot]={name:m.name,pose:fixture.observed.Pose,zoom:45};
  this.event({type:'accepted',op:'save'});
 }
 if(m.op==='capture'){fixture.photoAt=1758412345.5;this.event({type:'accepted',op:'capture'});}
 if(m.op==='recall')fixture.transitioning=true;
 this.event(fixture);
 }
 close(){this.readyState=3;this.dispatchEvent(new CloseEvent('close'));}
};
'''
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path=os.getenv('CAMERA_TEST_BROWSER_PATH') or shutil.which('chromium'))
  page=await browser.new_page(viewport={'width':1440,'height':1100}); errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  html=ROOT.joinpath('index.html').read_text(encoding='utf-8')
  html=re.sub(r'<link[^>]+>|<script[^>]+></script>','',html)
  await page.set_content(html)
  await page.add_style_tag(path=str(ROOT/'style.css'))
  await page.evaluate("() => {" + FAKE + "}")
  await page.add_script_tag(path=str(ROOT/'app.js'))
  assert await page.locator('#arm').is_disabled()
  await page.locator('#connect').click()
  await page.locator('#claim').click()
  await page.locator('#mode').select_option('6')
  await page.locator('#arm').click()
  await page.keyboard.down('KeyW');await page.wait_for_timeout(200);await page.keyboard.up('KeyW');await page.wait_for_timeout(100)
  msgs=await page.evaluate('cameraTest.messages')
  assert any(m.get('op')=='motion' and m['axes'][1]>0 for m in msgs),msgs
  assert any(m.get('op')=='motion' and not any(m['axes']) for m in msgs),msgs
  await page.locator('#name1').fill('ステージ全景');await page.locator('[data-save="1"]').click()
  assert await page.locator('#presetState1').text_content()=='ステージ全景'
  await page.locator('#name2').fill('<img src=x onerror=alert(1)>');await page.locator('[data-save="2"]').click()
  assert await page.locator('#presets img').count()==0
  # Overwriting asks once; a refused save must not consume that confirmation,
  # or the operator is stuck re-confirming forever (as they were).
  await page.evaluate('cameraTest.refuseSave=true')
  await page.locator('[data-save="1"]').click()
  assert await page.locator('#toasts .toast.notice').count()==1
  await page.locator('[data-save="1"]').click()
  assert await page.locator('#toasts .toast.error').count()==1, '拒否はトーストで出る'
  await page.locator('[data-save="1"]').click()
  assert await page.locator('#toasts .toast.notice').count()==1, '確認は消費されない'
  await page.evaluate('cameraTest.refuseSave=false')
  await page.locator('[data-save="1"]').click()
  await page.evaluate("document.querySelectorAll('#toasts .toast').forEach(t=>t.remove())")
  await page.locator('[data-save="1"]').click()
  assert await page.locator('#toasts .toast.notice').count()==1, '保存成功後は再び確認を求める'
  await page.evaluate("document.querySelectorAll('#toasts .toast').forEach(t=>t.remove())")
  # 撮影 asks VRChat for a photo; the preview is keyed on the server's timestamp.
  assert '写真なし' in await page.locator('#photoState').text_content()
  await page.locator('#capture').click()
  assert [m for m in await page.evaluate('cameraTest.messages') if m.get('op')=='capture']
  assert (await page.locator('#photo').get_attribute('src')).endswith('/photo/1758412345500')
  await page.locator('[data-recall="1"]').click();await page.locator('#stop').click()
  assert await page.locator('[data-axis]').first.is_disabled()
  # Remove the deliberate XSS fixture from the presentation screenshot.
  await page.locator('#name2').fill('演者アップ');await page.locator('[data-save="2"]').click();await page.locator('[data-save="2"]').click()
  await page.evaluate("document.querySelector('footer').textContent='UI PREVIEW / 模擬OSCデータ・実機接続ではありません'")
  if os.getenv('CAMERA_TEST_SCREENSHOT'):
   await page.screenshot(path=os.environ['CAMERA_TEST_SCREENSHOT'],full_page=True)
  await page.set_viewport_size({'width':390,'height':844})
  assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
  if os.getenv('CAMERA_TEST_MOBILE_SCREENSHOT'):
   await page.screenshot(path=os.environ['CAMERA_TEST_MOBILE_SCREENSHOT'],full_page=True)
  await page.locator('#profile').fill('rehearsal-2')
  await page.locator('#setProfile').focus()
  await page.wait_for_timeout(500)
  await page.locator('#setProfile').click()
  assert await page.locator('#profile').input_value()=='rehearsal-2'
  await page.locator('#disconnect').click()
  assert await page.locator('#claim').is_disabled()
  assert not errors,errors
  print('PASS: offline Chromium DOM / UI controls / keyboard / release / presets / XSS / capture preview / STOP / responsive width / disconnect (mock WebSocket, not real browser network)')
  await browser.close()
if __name__=='__main__': asyncio.run(main())
