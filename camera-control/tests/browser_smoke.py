"""Real Chromium UI smoke against a mock camera, NOT a live VRChat test.

Run: python tests/browser_smoke.py
Requires playwright; uses CAMERA_TEST_BROWSER_PATH or system Chromium if present.
"""
import asyncio
from contextlib import suppress
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiohttp import web
from playwright.async_api import async_playwright, expect
from osc_codec import encode, decode
from server import Config, ENGINE, create_app


def free_port(kind):
    with socket.socket(socket.AF_INET,kind) as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


class MockCamera(asyncio.DatagramProtocol):
    def __init__(self):
        self.pose=[10.,2.,20.,0.,0.,0.]
        self.zoom=45.
        self.mode=2
        self.messages=[]
    def connection_made(self,transport): self.transport=transport
    def datagram_received(self,data,addr):
        address,values,types=decode(data)
        self.messages.append((address,values,types))
        if address=='/usercamera/Pose': self.pose=values
        elif address=='/usercamera/Zoom': self.zoom=values[0]
        elif address=='/usercamera/Mode': self.mode=values[0]
    async def feedback(self,port):
        while True:
            for name,value,types in [('Pose',self.pose,'ffffff'),('Zoom',[self.zoom],'f'),('Mode',[self.mode],'i')]:
                self.transport.sendto(encode('/usercamera/'+name,value,types),('127.0.0.1',port))
            await asyncio.sleep(0.05)


async def main():
    with tempfile.TemporaryDirectory() as temp:
        mock=MockCamera()
        transport,_=await asyncio.get_running_loop().create_datagram_endpoint(lambda:mock,local_addr=('127.0.0.1',0))
        config=Config(token='browser-smoke-test-token-'+'x'*32,port=free_port(socket.SOCK_STREAM),
                      feedback_port=free_port(socket.SOCK_DGRAM),osc_port=transport.get_extra_info('sockname')[1],
                      enable_pose=True,presets=Path(temp)/'presets.json')
        app=create_app(config); runner=web.AppRunner(app)
        await runner.setup(); await web.TCPSite(runner,'127.0.0.1',config.port).start()
        feedback=asyncio.create_task(mock.feedback(config.feedback_port))
        try:
            async with async_playwright() as playwright:
                path=os.getenv('CAMERA_TEST_BROWSER_PATH') or shutil.which('chromium')
                browser=await playwright.chromium.launch(headless=True,executable_path=path)
                context=await browser.new_context(viewport={'width':1440,'height':1100})
                page=await context.new_page(); errors=[]
                page.on('pageerror',lambda exc:errors.append(str(exc)))
                await page.goto(f'http://127.0.0.1:{config.port}')
                assert await page.locator('#arm').is_disabled()
                assert len(mock.messages)==0
                await page.locator('#token').fill(config.token)
                await page.locator('#connect').click()
                # Locator assertions, not wait_for_function: the app's own CSP
                # (script-src 'self') blocks evaluating a string as JavaScript.
                await expect(page.locator('#connection')).to_have_text('認証済み')
                await page.locator('#claim').click()
                await expect(page.locator('#owner')).to_have_text('あなたが操作中')
                await page.locator('#mode').select_option('6')
                await asyncio.sleep(0.2)
                assert mock.mode==6
                await page.locator('#arm').click()
                await expect(page.locator('#armStatus')).to_have_text('ARM済み')
                await page.keyboard.down('KeyW'); await asyncio.sleep(0.25); await page.keyboard.up('KeyW')
                await asyncio.sleep(0.15)
                assert mock.pose[2]>20, mock.pose
                count=len(mock.messages); await asyncio.sleep(0.2); assert len(mock.messages)==count
                await page.locator('#name1').fill('ステージ全景')
                await page.locator('[data-save="1"]').click()
                await expect(page.locator('#presetState1')).to_have_text('ステージ全景')
                await page.locator('[data-recall="1"]').click()
                await asyncio.sleep(0.2)
                await page.locator('#stop').click()
                await asyncio.sleep(0.15)
                assert not app[ENGINE].armed
                count=len(mock.messages); await asyncio.sleep(0.2); assert len(mock.messages)==count
                # DOM-based labels are rendered as text, never HTML.
                await page.locator('#name2').fill('<img src=x onerror=alert(1)>')
                await page.locator('[data-save="2"]').click(); await asyncio.sleep(0.15)
                assert await page.locator('#presets img').count()==0
                screenshot=os.getenv('CAMERA_TEST_SCREENSHOT')
                if screenshot: await page.screenshot(path=screenshot,full_page=True)
                await page.set_viewport_size({'width':390,'height':844})
                assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                await page.locator('#disconnect').click(); await asyncio.sleep(0.15)
                assert app[ENGINE].owner is None
                assert not errors, errors
                await browser.close()
                print('PASS: Chromium auth, claim, mode, keyboard motion, release, presets, STOP, XSS text handling, mobile width, disconnect')
        finally:
            feedback.cancel()
            with suppress(asyncio.CancelledError): await feedback
            await runner.cleanup(); transport.close()


if __name__=='__main__': asyncio.run(main())
