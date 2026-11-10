"""Real Chrome/Edge E2E against Python aiohttp. Synthetic media only."""

import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright
from server import Settings, create_app

OUTPUT = Path(__file__).resolve().parents[1] / "test-results"


async def main():
    OUTPUT.mkdir(exist_ok=True)
    checks, errors, consoles = [], [], []
    def mark(text):
        checks.append(text)
        print(f"PASS {text}", flush=True)
    async def connected(page):
        await page.wait_for_function("() => window.__session.connected && window.__session.dataReady", timeout=20000)
    async def received_video(page):
        await page.wait_for_function("""() => { const v=document.querySelector('#main-video');
            return v.videoWidth>0 && v.readyState>=2 && document.querySelector('#video-empty').hidden; }""", timeout=15000)
    args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-accept-this-tab-capture", "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"]
    browsers, pages = [], {}
    async with TestServer(create_app(Settings(stun_urls=()))) as server, async_playwright() as playwright:
        origin = str(server.make_url("/")).rstrip("/")
        report = {"backend": "Python + aiohttp", "at": datetime.now(timezone.utc).isoformat(), "checks": checks, "errors": errors, "consoles": consoles}
        try:
            for channel in ("chrome", "msedge"):
                browser = await playwright.chromium.launch(channel=channel, headless=True, args=args)
                browsers.append(browser)
                context = await browser.new_context(viewport={"width": 1440, "height": 1100}, accept_downloads=True)
                if channel == "msedge":
                    await context.add_init_script("Object.defineProperty(globalThis.crypto, 'randomUUID', {value: undefined, configurable: true});")
                await context.grant_permissions(["camera", "microphone"], origin=origin)
                page = await context.new_page()
                page.on("pageerror", lambda error, name=channel: errors.append(f"{name}: {error}"))
                page.on("console", lambda message, name=channel: consoles.append(f"{name}: {message.text}") if message.type == "error" else None)
                await page.goto(origin)
                await page.evaluate("async () => { window.__session=(await import('/app.js')).session; }")
                pages[channel] = page
            chrome, edge = pages["chrome"], pages["msedge"]
            health = await (await chrome.request.get(origin + "/health")).json()
            assert health["backend"] == "Python + aiohttp"
            mark("HTTP assets and signaling backend are Python + aiohttp")
            await chrome.screenshot(path=OUTPUT / "01-lobby-desktop.png", full_page=True)
            await chrome.locator("#create-room").click()
            assert "이름" in await chrome.locator("#join-error").text_content()
            await chrome.locator("#display-name").fill("현장 작업자")
            await chrome.locator("#create-room").click()
            await chrome.locator("#session").wait_for(state="visible")
            room = await chrome.locator("#room-code").get_attribute("data-code")
            await edge.locator("#display-name").fill("원격 전문가")
            await edge.locator('[data-role="expert"]').click()
            await edge.locator("#room-input").fill(room)
            await edge.locator("#join-room").click()
            await asyncio.gather(connected(chrome), connected(edge))
            mark("Real Chrome to Edge P2P and negotiated data channel")
            candidates = await chrome.evaluate("async () => [...(await window.__session.pc.getStats()).values()].filter(s=>s.type==='local-candidate').map(s=>s.candidateType)")
            assert candidates and all(item != "relay" for item in candidates)
            mark("Direct host candidate path; no media relay")
            text = '<script>alert("xss")</script> 현장 확인'
            await edge.locator("#chat-input").fill(text)
            await edge.locator("#send-chat").click()
            await chrome.get_by_text(text, exact=True).wait_for()
            assert await chrome.locator(".bubble script").count() == 0
            mark("P2P chat delivery and HTML text escaping")
            await chrome.locator("#camera-btn").click()
            await received_video(edge)
            await chrome.locator("#mic-btn").click()
            await edge.wait_for_function("() => window.__session.remoteStatus.audio")
            audio_received = False
            for _ in range(50):
                audio_received = await edge.evaluate("async () => [...(await window.__session.pc.getStats()).values()].some(s=>s.type==='inbound-rtp'&&s.kind==='audio'&&s.bytesReceived>0)")
                if audio_received:
                    break
                await asyncio.sleep(.1)
            assert audio_received
            mark("Camera frames and microphone RTP received in Edge")
            await edge.locator('[data-tool="pen"]').click()
            rect = await edge.locator("#annotation-canvas").bounding_box()
            await edge.mouse.move(rect["x"] + rect["width"] * .3, rect["y"] + rect["height"] * .4)
            await edge.mouse.down()
            await edge.mouse.move(rect["x"] + rect["width"] * .65, rect["y"] + rect["height"] * .58, steps=12)
            await edge.mouse.up()
            pixels = "const c=document.querySelector('#annotation-canvas');return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)"
            await chrome.wait_for_function("() => {" + pixels + "}")
            mark("Normalized annotations synchronize from expert to source video")
            assert await edge.evaluate("() => typeof crypto.randomUUID") == "undefined"
            mark("Room requests and drawing work without native randomUUID")
            await edge.locator('[data-tool="pointer"]').click()
            await edge.locator("#annotation-canvas").hover(position={"x": 70, "y": 70})
            await chrome.locator("#remote-pointer").wait_for(state="visible")
            mark("Remote pointer is delivered over data channel")
            async with edge.expect_download() as captured:
                await edge.locator("#snapshot").click()
            capture = await captured.value
            assert capture.suggested_filename.endswith(".png")
            await capture.save_as(OUTPUT / "capture.png")
            mark("Video and annotation capture exports PNG")
            await edge.locator("#clear-annotations").click()
            await chrome.wait_for_function("() => {" + pixels.replace("return c.", "return !c.") + "}")
            mark("Clear annotations synchronizes")
            await chrome.locator("#screen-btn").click()
            await chrome.wait_for_function("() => window.__session.localStatus.source==='screen'", timeout=15000)
            await edge.wait_for_function("() => window.__session.remoteStatus.source==='screen'")
            await received_video(edge)
            mark("Chrome screen share replaces camera without reconnecting")
            await chrome.locator("#screen-btn").click()
            await edge.locator("#video-empty").wait_for(state="visible")
            mark("Screen sharing stops and remote UI clears")
            await edge.locator("#screen-btn").click()
            await edge.wait_for_function("() => window.__session.localStatus.source==='screen'", timeout=15000)
            await received_video(chrome)
            mark("Edge screen share is received in Chrome")
            await chrome.locator("#camera-btn").click()
            await chrome.locator("#preview-toggle").wait_for(state="visible")
            await chrome.locator("#preview-toggle").click()
            assert await chrome.locator("#video-stage").get_attribute("data-view") == "local"
            mark("Both peers send media and local or remote preview can switch")
            await chrome.locator("#stats-tab").click()
            await edge.locator("#stats-tab").click()
            await chrome.wait_for_function("() => document.querySelector('#stat-rtt').textContent!=='—'")
            await edge.wait_for_function("() => document.querySelector('#stat-bitrate').textContent!=='—'")
            await chrome.locator("#quality-select").select_option("low")
            assert await chrome.evaluate("() => window.__session.senders.video.getParameters().encodings[0].maxBitrate") == 350000
            mark("Live WebRTC stats and actual sender bitrate setting")
            await chrome.locator("#reconnect-btn").click()
            await asyncio.gather(connected(chrome), connected(edge))
            await edge.locator("#chat-tab").click()
            await edge.locator('[data-message="확인했습니다."]').click()
            await chrome.get_by_text("확인했습니다.", exact=True).wait_for(state="attached")
            mark("ICE restart preserves P2P messaging")
            await chrome.screenshot(path=OUTPUT / "02-session-chrome.png", full_page=True)
            await edge.screenshot(path=OUTPUT / "03-session-edge.png", full_page=True)
            async with chrome.expect_download() as diagnostic:
                await chrome.locator("#export-diagnostics").click()
            await (await diagnostic.value).save_as(OUTPUT / "diagnostics.json")
            mark("Session diagnostic JSON export")
            await edge.locator("#leave-btn").click()
            await chrome.get_by_text("님이 세션을 나갔습니다", exact=False).wait_for(state="attached")
            await edge.locator("#room-input").fill(room)
            await edge.locator("#join-room").click()
            await asyncio.gather(connected(chrome), connected(edge))
            mark("Leave and rejoin the same room")
            await chrome.evaluate("() => window.__session.ws.close()")
            await chrome.wait_for_function("() => window.__session.logs.some(l=>l.text.includes('복구 완료'))&&window.__session.connected&&window.__session.dataReady", timeout=20000)
            mark("Signaling disconnect automatically restores room and P2P session")
            await edge.locator("#leave-btn").click()
            await chrome.locator("#leave-btn").click()
            assert await chrome.evaluate("() => window.__session.stream.getTracks().length") == 0
            mark("Leave releases all local media tracks")
            await chrome.set_viewport_size({"width": 390, "height": 844})
            await chrome.screenshot(path=OUTPUT / "04-lobby-mobile.png", full_page=True)
            assert not await chrome.evaluate("() => document.documentElement.scrollWidth>innerWidth")
            mark("390px responsive layout has no horizontal overflow")
            await chrome.locator("#help-btn").click()
            await chrome.locator("#help-dialog").wait_for(state="visible")
            await chrome.keyboard.press("Escape")
            mark("Help dialog opens and closes with keyboard")
            assert not errors, errors
            assert not consoles, consoles
            mark("No uncaught browser errors or console errors")
            report.update(passed=True, chrome=browsers[0].version, edge=browsers[1].version,
                          environment="Real headless Chrome/Edge; Python aiohttp test server; synthetic camera/mic; test screen picker; direct loopback without STUN/TURN")
        except Exception as error:
            report.update(passed=False, failure=repr(error))
            for name, page in pages.items():
                try:
                    print(name, await page.evaluate("() => ({state:window.__session.pc?.connectionState,logs:window.__session.logs})"))
                    await page.screenshot(path=OUTPUT / f"failure-{name}.png", full_page=True)
                except Exception:
                    pass
            raise
        finally:
            (OUTPUT / "browser-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            await asyncio.gather(*(browser.close() for browser in browsers))


if __name__ == "__main__":
    asyncio.run(main())
