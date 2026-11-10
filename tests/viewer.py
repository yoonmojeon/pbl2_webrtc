"""Secure desktop screen sharing to an insecure HTTP mobile-sized viewer.

Runs real Windows Chrome/Edge, with test-tab capture and synthetic microphone.
This does not emulate or claim verification of iOS Safari.
"""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright
from server import Settings, create_app


async def main():
    output = Path(__file__).resolve().parents[1] / "test-results"
    checks, errors = [], []
    report = {"backend": "Python + aiohttp", "at": datetime.now(timezone.utc).isoformat(),
              "checks": checks, "errors": errors, "actual_iPhone_tested": False}
    def mark(message):
        checks.append(message)
        print("PASS " + message, flush=True)
    args = ["--host-resolver-rules=MAP fieldlink.test 127.0.0.1", "--no-proxy-server",
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
            "--auto-accept-this-tab-capture", "--disable-features=WebRtcHideLocalIpsWithMdns"]
    try:
        async with TestServer(create_app(Settings(stun_urls=()))) as server, async_playwright() as playwright:
            secure_origin = str(server.make_url("/")).rstrip("/")
            http_origin = f"http://fieldlink.test:{server.port}"
            for sender_name, viewer_name in (("chrome", "msedge"), ("msedge", "chrome")):
                label = f"{sender_name} desktop -> {viewer_name} HTTP viewer"
                sender_browser = await playwright.chromium.launch(channel=sender_name, headless=True, args=args)
                viewer_browser = await playwright.chromium.launch(channel=viewer_name, headless=True, args=args)
                try:
                    sender_context = await sender_browser.new_context(viewport={"width": 1440, "height": 1000})
                    await sender_context.grant_permissions(["microphone"], origin=secure_origin)
                    viewer_context = await viewer_browser.new_context(viewport={"width": 390, "height": 844},
                                                                      is_mobile=True, has_touch=True)
                    sender, viewer = await sender_context.new_page(), await viewer_context.new_page()
                    for page in (sender, viewer):
                        page.on("pageerror", lambda error: errors.append(str(error)))
                    await sender.goto(secure_origin + '/?view=1')
                    await viewer.goto(http_origin + "/?view=1")
                    for page in (sender, viewer):
                        await page.evaluate("async () => { window.__session=(await import('/app.js')).session; }")
                    assert await sender.evaluate("isSecureContext")
                    assert not await viewer.evaluate("isSecureContext")
                    assert await viewer.locator("#capture-controls").is_hidden()
                    assert await viewer.locator("#viewer-controls").is_hidden()  # Session not joined yet.
                    await sender.locator("#display-name").fill("데스크톱")
                    await sender.locator("#create-room").click()
                    await sender.locator("#session").wait_for(state="visible")
                    room = await sender.locator("#room-code").get_attribute("data-code")
                    assert await sender.locator("#screen-btn").is_hidden()
                    assert await sender.locator("#switch-to-send").is_visible()
                    assert await sender.locator("#play-video").is_disabled()
                    assert "대기" in await sender.locator("#play-video").text_content()
                    await sender.locator("#switch-to-send").click()
                    assert await sender.locator("#capture-controls").is_visible()
                    assert await sender.locator("#viewer-controls").is_hidden()
                    assert 'view=1' not in sender.url
                    await sender.wait_for_function("() => window.__session.localStatus.source==='screen'")
                    mark(label + ": desktop leaves viewer mode and shares before the phone joins")
                    await viewer.locator("#display-name").fill("모바일 보기 시험")
                    await viewer.locator("#room-input").fill(room)
                    await viewer.locator("#join-room").click()
                    await asyncio.gather(*(page.wait_for_function("() => window.__session.connected && window.__session.dataReady",
                                                                  timeout=20000) for page in (sender, viewer)))
                    assert await viewer.locator("#viewer-controls").is_visible()
                    assert await viewer.locator("#camera-btn").is_hidden()
                    assert "view=1" in viewer.url
                    mark(label + ": secure sender and insecure viewer connect without capture permission")

                    recovery = urlparse(await viewer.locator("#desktop-send-link").get_attribute("href"))
                    assert recovery.hostname == 'localhost'
                    assert parse_qs(recovery.query)['room'] == [room]
                    assert 'view' not in parse_qs(recovery.query)
                    await viewer.wait_for_function("""() => {const v=document.querySelector('#main-video');
                        return window.__session.remoteStatus.source==='screen' && v.videoWidth>0 &&
                               v.readyState>=2 && !v.paused && document.querySelector('#video-empty').hidden;}""", timeout=20000)
                    await viewer.wait_for_function("""async () => [...(await window.__session.pc.getStats()).values()]
                        .some(s=>s.type==='inbound-rtp' && s.kind==='video' && s.framesDecoded>3)""")
                    mark(label + ": real captured tab frames are decoded and playing on HTTP")

                    await viewer.evaluate("() => document.querySelector('#main-video').pause()")
                    await viewer.locator("#play-video").click()
                    await viewer.wait_for_function("() => !document.querySelector('#main-video').paused")
                    await sender.locator("#mic-btn").click()
                    await viewer.wait_for_function("() => !document.querySelector('#listen-btn').disabled")
                    assert await viewer.evaluate("document.querySelector('#remote-audio').muted")
                    await viewer.locator("#listen-btn").click()
                    await viewer.wait_for_function("() => !document.querySelector('#remote-audio').muted && !document.querySelector('#remote-audio').paused")
                    await viewer.wait_for_function("""async () => [...(await window.__session.pc.getStats()).values()]
                        .some(s=>s.type==='inbound-rtp' && s.kind==='audio' && s.bytesReceived>0)""")
                    await viewer.locator("#listen-btn").click()
                    assert await viewer.evaluate("document.querySelector('#remote-audio').muted")
                    mark(label + ": manual video playback and received microphone audio toggle work")

                    await viewer.locator("#chat-input").fill("공유 화면 확인했습니다")
                    await viewer.locator("#send-chat").click()
                    await sender.get_by_text("공유 화면 확인했습니다", exact=True).wait_for()
                    await viewer.locator("#annotation-canvas").tap(position={"x": 100, "y": 80})
                    await sender.locator("#remote-pointer").wait_for(state="visible")
                    await viewer.locator('[data-tool="pen"]').click()
                    await viewer.locator("#annotation-canvas").tap(position={"x": 140, "y": 100})
                    await sender.wait_for_function("""() => {const c=document.querySelector('#annotation-canvas');
                        return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)}""", timeout=5000)
                    mark(label + ": chat, touch pointer and touch annotation reach desktop over P2P")

                    assert await viewer.evaluate("window.__session.stream.getTracks().length") == 0
                    assert await viewer.locator("#quality-select").is_disabled()
                    for width in (360, 390, 844):
                        await viewer.set_viewport_size({"width": width, "height": 844 if width < 800 else 390})
                        assert not await viewer.evaluate("document.documentElement.scrollWidth>innerWidth")
                    await viewer.set_viewport_size({"width": 390, "height": 844})
                    await viewer.screenshot(path=output / f"viewer-{viewer_name}-mobile.png", full_page=True)
                    mark(label + ": no local media tracks and no overflow in portrait or landscape")

                    await sender.locator("#screen-btn").click()
                    await viewer.locator("#video-empty").wait_for(state="visible")
                    assert "데스크톱" in await viewer.locator("#empty-title").text_content()
                    assert await viewer.locator("#play-video").is_disabled()
                    await viewer.locator("#leave-btn").click()
                    assert "view=1" in viewer.url
                    await viewer.reload()
                    await viewer.locator("#environment-alert").wait_for()
                    assert "보기 모드" in await viewer.locator("#environment-alert").text_content()
                    await sender.locator("#leave-btn").click()
                    mark(label + ": stopping share clears viewer and viewer mode survives leaving/reload")
                except Exception:
                    for name, page in ((sender_name + " sender", sender), (viewer_name + " viewer", viewer)):
                        try:
                            state = await page.evaluate("""async () => ({state:window.__session.pc?.connectionState,
                                signaling:window.__session.pc?.signalingState,ice:window.__session.pc?.iceConnectionState,
                                logs:window.__session.logs,stats:window.__session.pc ?
                                [...(await window.__session.pc.getStats()).values()].filter(s=>s.type==='candidate-pair') : []})""")
                            print(name, state, flush=True)
                            report.setdefault("diagnostics", {})[name] = state
                        except Exception:
                            pass
                    raise
                finally:
                    await sender_browser.close()
                    await viewer_browser.close()
            assert not errors, errors
            mark("No uncaught browser errors")
            report["passed"] = True
    except Exception as error:
        report.update(passed=False, failure=repr(error))
        raise
    finally:
        (output / "viewer-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
