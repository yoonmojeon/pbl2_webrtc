"""Regression for LAN HTTP: real insecure origins without crypto.randomUUID."""

import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright
from server import Settings, create_app


async def main():
    output = Path(__file__).resolve().parents[1] / "test-results"
    output.mkdir(exist_ok=True)
    checks, errors, browsers = [], [], []
    def mark(message):
        checks.append(message)
        print(f"PASS {message}", flush=True)
    report = {"backend": "Python + aiohttp", "at": datetime.now(timezone.utc).isoformat(), "checks": checks, "errors": errors}
    async with TestServer(create_app(Settings(stun_urls=()))) as server, async_playwright() as playwright:
        # The .test origin is not potentially trustworthy. DNS is mapped within
        # these isolated browser processes; no system hosts/settings are changed.
        origin = f"http://fieldlink.test:{server.port}"
        pages = []
        try:
            for channel in ("chrome", "msedge"):
                browser = await playwright.chromium.launch(channel=channel, headless=True,
                    args=["--host-resolver-rules=MAP fieldlink.test 127.0.0.1", "--no-proxy-server", "--disable-features=WebRtcHideLocalIpsWithMdns"])
                browsers.append(browser)
                page = await browser.new_page(viewport={"width": 390, "height": 844})
                page.on("pageerror", lambda error, name=channel: errors.append(f"{name}: {error}"))
                await page.goto(origin)
                context = await page.evaluate("() => ({secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues})")
                assert context == {"secure": False, "uuid": "undefined", "random": "function"}, context
                pages.append(page)
            mark("Both browsers use an actual insecure HTTP origin with no randomUUID")
            a, b = pages
            await a.locator("#display-name").fill("HTTP 현장")
            await a.locator("#create-room").click()
            await a.locator("#session").wait_for(state="visible")
            room = await a.locator("#room-code").get_attribute("data-code")
            assert re.fullmatch(r"[A-Z2-9]{10}", room)
            mark("Room creation displays a valid 10-character code on HTTP")
            await b.locator("#display-name").fill("HTTP 전문가")
            await b.locator("#room-input").fill(room)
            await b.locator("#join-room").click()
            await asyncio.gather(*(page.wait_for_function("() => !document.querySelector('#chat-input').disabled", timeout=20000) for page in pages))
            mark("Room join and WebRTC data channel connect on HTTP")
            await b.locator("#chat-input").fill("HTTP 입장 확인")
            await b.locator("#send-chat").click()
            await a.get_by_text("HTTP 입장 확인", exact=True).wait_for()
            mark("P2P chat is delivered without randomUUID")
            ids = await b.evaluate("async () => { const {createId}=await import('/id.js'); return Array.from({length:128},()=>createId()); }")
            assert len(set(ids)) == 128
            assert all(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value) for value in ids)
            mark("Fallback IDs have UUID v4 version and variant with no duplicates in the sample")
            assert "보기 모드" in await b.locator("#environment-alert").text_content()
            assert await b.locator("#capture-controls").is_hidden()
            assert await b.locator("#viewer-controls").is_visible()
            assert await b.locator("#empty-share").is_hidden()
            mark("HTTP automatically uses viewer mode with capture controls hidden")
            await b.screenshot(path=output / "http-compat-mobile.png", full_page=True)
            await a.locator("#leave-btn").click()
            await b.locator("#leave-btn").click()
            assert not errors, errors
            mark("No uncaught browser errors on the HTTP flow")
            report["passed"] = True
        except Exception as error:
            report.update(passed=False, failure=repr(error))
            raise
        finally:
            (output / "http-compat-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            await asyncio.gather(*(browser.close() for browser in browsers))


if __name__ == "__main__":
    asyncio.run(main())
