"""Viewport checks for the HTML/CSS/JavaScript frontend on aiohttp."""
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright
from server import Settings, create_app


async def main():
    output = Path(__file__).resolve().parents[1] / "test-results"
    output.mkdir(exist_ok=True)
    results = []
    async with TestServer(create_app(Settings(stun_urls=()))) as server, async_playwright() as playwright:
        origin = str(server.make_url("/")).rstrip("/")
        browser = await playwright.chromium.launch(channel="chrome", headless=True)
        try:
            for width in (360, 390, 768, 1024, 1440):
                page = await browser.new_page(viewport={"width": width, "height": 1000})
                await page.goto(origin)
                for screen in ("lobby", "session", "architecture"):
                    if screen == "session":
                        await page.locator("#display-name").fill("레이아웃 확인")
                        await page.locator("#create-room").click()
                        await page.locator("#session").wait_for(state="visible")
                    if screen == "architecture":
                        await page.goto(origin + "/architecture.html")
                    await page.screenshot(path=output / f"layout-{screen}-{width}.png", full_page=True)
                    measured = await page.evaluate("() => ({width:innerWidth, scroll:document.documentElement.scrollWidth})")
                    results.append({"screen": screen, **measured})
                    assert measured["scroll"] <= width, results[-1]
                await page.close()
        finally:
            await browser.close()
    (output / "layout-report.json").write_text(json.dumps({"passed": True, "backend": "Python + aiohttp", "results": results}, indent=2), encoding="utf-8")
    print(f"PASS {len(results)} viewport/page combinations", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
