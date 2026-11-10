"""Python + aiohttp signaling server. Media and application data stay P2P."""

from __future__ import annotations

import argparse
import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
import json
import logging
import os
from pathlib import Path
import re
import secrets
import ssl
import time
import tomllib
from urllib.parse import urlsplit
from uuid import uuid4

from aiohttp import WSMsgType, WSCloseCode, web

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_PATTERN = re.compile(r"[A-Z2-9]{10}\Z")
MIME = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self)",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store",
}


@dataclass(frozen=True)
class Settings:
    host: str = "0.0.0.0"
    port: int = 3000
    stun_urls: tuple[str, ...] = ("stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302")
    allowed_origins: frozenset[str] = frozenset()
    tls_cert: str = ""
    tls_key: str = ""
    max_rooms: int = 500
    max_clients: int = 1000
    room_ttl: float = 300.0
    sweep_interval: float = 20.0
    messages_per_window: int = 400
    rate_window: float = 10.0

    def __post_init__(self):
        if not self.host or not 0 <= self.port <= 65535:
            raise ValueError("host와 port 설정을 확인해 주세요.")
        if bool(self.tls_cert) != bool(self.tls_key):
            raise ValueError("tls_cert와 tls_key는 함께 지정해야 합니다.")
        if min(self.max_rooms, self.max_clients, self.messages_per_window) < 1:
            raise ValueError("서버 자원 한도는 1 이상이어야 합니다.")
        if min(self.room_ttl, self.sweep_interval, self.rate_window) <= 0:
            raise ValueError("시간 설정은 0보다 커야 합니다.")
        if any(not isinstance(url, str) or not re.fullmatch(r"stuns?:[^\s]+", url) for url in self.stun_urls):
            raise ValueError("stun_urls에는 stun: 또는 stuns: 주소를 입력해 주세요.")


def load_settings(argv=None) -> Settings:
    parser = argparse.ArgumentParser(description="FieldLink · Python aiohttp P2P signaling server")
    parser.add_argument("--config", type=Path, default=ROOT / "config.toml")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--stun-urls", help="Comma-separated STUN URLs; an empty string disables STUN")
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    args = parser.parse_args(argv)
    raw = tomllib.loads(args.config.read_text(encoding="utf-8-sig")) if args.config.exists() else {}
    def setting(key, env, default):
        cli = getattr(args, key, None)
        return cli if cli is not None else os.environ.get(env, raw.get(key, default))
    urls = setting("stun_urls", "STUN_URLS", Settings.stun_urls)
    if isinstance(urls, str):
        urls = [item.strip() for item in urls.split(",") if item.strip()]
    origins = os.environ.get("ALLOWED_ORIGINS", raw.get("allowed_origins", []))
    if isinstance(origins, str):
        origins = [item.strip() for item in origins.split(",") if item.strip()]
    return Settings(
        host=setting("host", "HOST", "0.0.0.0"), port=int(setting("port", "PORT", 3000)),
        stun_urls=tuple(urls), allowed_origins=frozenset(origins),
        tls_cert=str(setting("tls_cert", "TLS_CERT", "")), tls_key=str(setting("tls_key", "TLS_KEY", "")),
    )


@dataclass(eq=False)
class Peer:
    ws: web.WebSocketResponse
    id: str = field(default_factory=lambda: str(uuid4()))
    name: str = "참여자"
    role: str = "field"
    room: str | None = None
    window_at: float = field(default_factory=time.monotonic)
    count: int = 0

    def metadata(self):
        return {"id": self.id, "name": self.name, "role": self.role}


@dataclass
class Room:
    members: dict[str, Peer] = field(default_factory=dict)
    updated_at: float = field(default_factory=time.monotonic)


class SignalingService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.rooms: dict[str, Room] = {}
        self.clients: dict[str, Peer] = {}

    @staticmethod
    async def send(peer: Peer, message: dict):
        if not peer.ws.closed:
            try:
                await asyncio.wait_for(peer.ws.send_json(message, dumps=lambda obj: json.dumps(obj, ensure_ascii=False, allow_nan=False)), timeout=5)
            except (ConnectionError, OSError, RuntimeError, TimeoutError):
                # A closing peer must not break another peer's handler.
                pass

    async def fail(self, peer, code, message, request_id=None):
        reply = {"type": "error", "code": code, "message": message}
        if request_id is not None:
            reply["requestId"] = request_id
        await self.send(peer, reply)

    async def leave(self, peer: Peer):
        room = self.rooms.get(peer.room)
        peer.room = None
        if room:
            room.members.pop(peer.id, None)
            room.updated_at = time.monotonic()
            await asyncio.gather(*(self.send(other, {"type": "peer-left", "peerId": peer.id}) for other in tuple(room.members.values())))

    async def join(self, peer: Peer, code: str, request_id=None):
        room = self.rooms.get(code)
        if room is None:
            return await self.fail(peer, "ROOM_NOT_FOUND", "방을 찾을 수 없습니다. 코드를 확인하거나 새 방을 만들어 주세요.", request_id)
        if len(room.members) >= 2:
            return await self.fail(peer, "ROOM_FULL", "이 방은 1:1 연결 중입니다. 최대 2명까지 입장할 수 있습니다.", request_id)
        if peer.room:
            return await self.fail(peer, "ALREADY_JOINED", "현재 방을 먼저 나가 주세요.", request_id)
        # Update membership before awaiting any network writes: concurrent joins
        # cannot both pass the capacity check on this single asyncio event loop.
        others = tuple(room.members.values())
        peer.room = code
        room.members[peer.id] = peer
        room.updated_at = time.monotonic()
        reply = {"type": "joined", "room": code, "selfId": peer.id, "peers": [other.metadata() for other in others]}
        if request_id is not None:
            reply["requestId"] = request_id
        await self.send(peer, reply)
        await asyncio.gather(*(self.send(other, {"type": "peer-joined", "peer": peer.metadata()}) for other in others))

    async def handle_message(self, peer: Peer, message):
        if not isinstance(message, dict):
            return await self.fail(peer, "INVALID_MESSAGE", "메시지 형식을 확인해 주세요.")
        request_id = message.get("requestId")
        request_id = request_id[:64] if isinstance(request_id, str) else None
        kind = message.get("type")
        if kind in ("create", "join"):
            if peer.room:
                return await self.fail(peer, "ALREADY_JOINED", "현재 방을 먼저 나가 주세요.", request_id)
            name = message.get("name")
            peer.name = name.strip()[:30] or "참여자" if isinstance(name, str) else "참여자"
            peer.role = "expert" if message.get("role") == "expert" else "field"
            if kind == "create":
                if len(self.rooms) >= self.settings.max_rooms:
                    return await self.fail(peer, "SERVER_BUSY", "생성 가능한 방이 가득 찼습니다. 잠시 후 시도해 주세요.", request_id)
                code = "".join(secrets.choice(ALPHABET) for _ in range(10))
                while code in self.rooms:
                    code = "".join(secrets.choice(ALPHABET) for _ in range(10))
                self.rooms[code] = Room()
            else:
                code = message.get("room")
                code = re.sub(r"[\s-]", "", code.upper()) if isinstance(code, str) else ""
                if not ROOM_PATTERN.fullmatch(code):
                    return await self.fail(peer, "INVALID_ROOM", "영문·숫자 10자리 방 코드를 입력해 주세요.", request_id)
            return await self.join(peer, code, request_id)
        if kind == "leave":
            await self.leave(peer)
            return await self.send(peer, {"type": "left"})
        if kind == "signal":
            room = self.rooms.get(peer.room)
            target_id = message.get("target")
            target = room.members.get(target_id) if room and isinstance(target_id, str) else None
            if target is None or target is peer:
                return await self.fail(peer, "PEER_NOT_FOUND", "상대방의 연결을 기다리고 있습니다.")
            clean = self.clean_signal(message.get("payload"))
            if clean is None:
                return await self.fail(peer, "INVALID_SIGNAL", "올바른 SDP 또는 ICE 정보가 필요합니다.")
            return await self.send(target, {"type": "signal", "from": peer.id, "payload": clean})
        await self.fail(peer, "UNKNOWN_TYPE", "지원하지 않는 메시지입니다.", request_id)

    @staticmethod
    def clean_signal(payload):
        if not isinstance(payload, dict):
            return None
        desc = payload.get("description")
        if isinstance(desc, dict) and desc.get("type") in ("offer", "answer") and isinstance(desc.get("sdp"), str) and len(desc["sdp"]) <= 55000:
            return {"description": {"type": desc["type"], "sdp": desc["sdp"]}}
        candidate = payload.get("candidate")
        if isinstance(candidate, dict) and isinstance(candidate.get("candidate"), str) and len(candidate["candidate"]) <= 4096:
            mid, index, fragment = (candidate.get(key) for key in ("sdpMid", "sdpMLineIndex", "usernameFragment"))
            return {"candidate": {
                "candidate": candidate["candidate"], "sdpMid": mid[:64] if isinstance(mid, str) else None,
                "sdpMLineIndex": index if type(index) is int and 0 <= index <= 65535 else None,
                "usernameFragment": fragment[:256] if isinstance(fragment, str) else None,
            }}
        return None

    def sweep_rooms(self):
        now = time.monotonic()
        for code, room in tuple(self.rooms.items()):
            if not room.members and now - room.updated_at > self.settings.room_ttl:
                del self.rooms[code]


SERVICE_KEY = web.AppKey("signaling_service", SignalingService)


async def add_headers(request, response):
    response.headers.update(SECURITY_HEADERS)


async def housekeeping(app):
    async def sweep():
        while True:
            await asyncio.sleep(app[SERVICE_KEY].settings.sweep_interval)
            app[SERVICE_KEY].sweep_rooms()
    task = asyncio.create_task(sweep(), name="fieldlink-room-cleanup")
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


async def shutdown(app):
    await asyncio.gather(*(peer.ws.close(code=WSCloseCode.GOING_AWAY, message=b"Server shutdown") for peer in tuple(app[SERVICE_KEY].clients.values())))


async def health(request):
    service = request.app[SERVICE_KEY]
    return web.json_response({"status": "ok", "mode": "p2p", "backend": "Python + aiohttp", "rooms": len(service.rooms)})


async def config(request):
    urls = request.app[SERVICE_KEY].settings.stun_urls
    return web.json_response({"iceServers": [{"urls": list(urls)}] if urls else [], "mode": "p2p", "maxPeers": 2})


async def static_file(request):
    relative = request.match_info.get("path", "") or "index.html"
    try:
        target = (PUBLIC / relative).resolve()
        if not target.is_relative_to(PUBLIC) or target.suffix not in MIME or not target.is_file():
            raise web.HTTPNotFound()
        content = await asyncio.to_thread(target.read_bytes)
        return web.Response(body=content, content_type=MIME[target.suffix], charset="utf-8")
    except (OSError, ValueError):
        raise web.HTTPNotFound() from None


def reject_json_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


async def websocket(request):
    service = request.app[SERVICE_KEY]
    origin = request.headers.get("Origin", "")
    try:
        parsed = urlsplit(origin)
        same_origin = parsed.scheme in ("http", "https") and parsed.netloc.lower() == request.host.lower() and not parsed.path and not parsed.query and not parsed.fragment
    except ValueError:
        same_origin = False
    if not same_origin and origin not in service.settings.allowed_origins:
        raise web.HTTPForbidden(text="Origin is not allowed")
    if len(service.clients) >= service.settings.max_clients:
        raise web.HTTPServiceUnavailable(text="Server client limit reached")
    ws = web.WebSocketResponse(heartbeat=20, timeout=5, max_msg_size=64 * 1024, compress=False)
    if not ws.can_prepare(request).ok:
        raise web.HTTPBadRequest(text="WebSocket upgrade required")
    peer = Peer(ws=ws)
    service.clients[peer.id] = peer
    try:
        await ws.prepare(request)
        await service.send(peer, {"type": "welcome", "selfId": peer.id})
        async for item in ws:
            if item.type not in (WSMsgType.TEXT, WSMsgType.BINARY):
                continue
            now = time.monotonic()
            if now - peer.window_at > service.settings.rate_window:
                peer.window_at, peer.count = now, 0
            peer.count += 1
            if peer.count > service.settings.messages_per_window:
                await ws.close(code=WSCloseCode.POLICY_VIOLATION, message=b"Rate limit")
                break
            if item.type == WSMsgType.BINARY:
                await service.fail(peer, "INVALID_MESSAGE", "텍스트 JSON 메시지만 지원합니다.")
                continue
            try:
                message = json.loads(item.data, parse_constant=reject_json_constant)
            except (ValueError, RecursionError):
                await service.fail(peer, "INVALID_JSON", "올바른 JSON 형식이 아닙니다.")
                continue
            await service.handle_message(peer, message)
    finally:
        await service.leave(peer)
        service.clients.pop(peer.id, None)
    return ws


def create_app(settings: Settings | None = None) -> web.Application:
    app = web.Application(client_max_size=64 * 1024)
    app[SERVICE_KEY] = SignalingService(settings or Settings())
    app.on_response_prepare.append(add_headers)
    app.cleanup_ctx.append(housekeeping)
    app.on_shutdown.append(shutdown)
    app.router.add_get("/health", health)
    app.router.add_get("/config", config)
    app.router.add_get("/signal", websocket)
    app.router.add_get("/{path:.*}", static_file)
    return app


def tls_context(settings):
    if not settings.tls_cert:
        return None
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    cert, key = Path(settings.tls_cert), Path(settings.tls_key)
    context.load_cert_chain(cert if cert.is_absolute() else ROOT / cert, key if key.is_absolute() else ROOT / key)
    return context


def main():
    logging.basicConfig(level=logging.WARNING)
    settings = load_settings()
    protocol = "https" if settings.tls_cert else "http"
    web.run_app(create_app(settings), host=settings.host, port=settings.port, ssl_context=tls_context(settings), access_log=None,
                print=lambda _: print(f"\n  FieldLink · Python + aiohttp\n  Local: {protocol}://localhost:{settings.port}\n  WebSocket + WebRTC P2P · 종료: Ctrl+C\n", flush=True))


if __name__ == "__main__":
    main()
