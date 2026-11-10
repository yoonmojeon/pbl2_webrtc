"""Protocol and HTTP integration tests against a real aiohttp test server."""

import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from aiohttp import WSServerHandshakeError, WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from server import SERVICE_KEY, Settings, create_app, load_settings, tls_context


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = create_app(Settings(stun_urls=()))
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.origin = str(self.client.make_url("/")).rstrip("/")

    async def asyncTearDown(self):
        await self.client.close()

    async def connect(self, origin=None):
        ws = await self.client.ws_connect("/signal", origin=origin or self.origin)
        welcome = await self.receive(ws, "welcome")
        return ws, welcome["selfId"]

    async def receive(self, ws, kind):
        message = await asyncio.wait_for(ws.receive_json(), timeout=3)
        self.assertEqual(message["type"], kind, message)
        return message

    async def pair(self):
        a, aid = await self.connect()
        b, bid = await self.connect()
        await a.send_json({"type": "create", "name": "현장", "role": "field"})
        room = (await self.receive(a, "joined"))["room"]
        await b.send_json({"type": "join", "room": room, "name": "전문가", "role": "expert"})
        joined = await self.receive(b, "joined")
        self.assertEqual(joined["peers"][0]["id"], aid)
        self.assertEqual((await self.receive(a, "peer-joined"))["peer"]["id"], bid)
        return a, aid, b, bid, room

    async def test_http_assets_config_and_python_backend(self):
        for path in ("/", "/app.js", "/rtc.js", "/style.css", "/architecture.html", "/icon.svg"):
            response = await self.client.get(path)
            self.assertEqual(response.status, 200, path)
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        response = await self.client.get("/config")
        self.assertEqual(await response.json(), {"iceServers": [], "mode": "p2p", "maxPeers": 2})
        response = await self.client.get("/health")
        self.assertEqual((await response.json())["backend"], "Python + aiohttp")
        head = await self.client.head("/")
        self.assertEqual(head.status, 200)
        self.assertEqual(await head.read(), b"")

    async def test_private_files_traversal_and_wrong_methods_are_denied(self):
        for path in ("/server.py", "/requirements.txt", "/config.toml", "/.env", "/%2e%2e%2fserver.py", "/%2e%2e%5cserver.py"):
            response = await self.client.get(path)
            self.assertEqual(response.status, 404, path)
        self.assertEqual((await self.client.post("/")).status, 405)

    async def test_room_capacity_leave_and_reentry(self):
        a, _, b, _, room = await self.pair()
        self.assertRegex(room, r"^[A-Z2-9]{10}$")
        c, _ = await self.connect()
        await c.send_json({"type": "join", "room": room, "requestId": "full"})
        error = await self.receive(c, "error")
        self.assertEqual((error["code"], error["requestId"]), ("ROOM_FULL", "full"))
        await b.send_json({"type": "leave"})
        await self.receive(b, "left")
        await self.receive(a, "peer-left")
        await c.send_json({"type": "join", "room": room.lower()[:5] + "-" + room.lower()[5:]})
        self.assertEqual((await self.receive(c, "joined"))["room"], room)
        await self.receive(a, "peer-joined")

    async def test_simultaneous_joins_still_enforce_two_members(self):
        a, _ = await self.connect()
        await a.send_json({"type": "create"})
        room = (await self.receive(a, "joined"))["room"]
        b, _ = await self.connect()
        c, _ = await self.connect()
        await asyncio.gather(b.send_json({"type": "join", "room": room}), c.send_json({"type": "join", "room": room}))
        replies = await asyncio.gather(b.receive_json(), c.receive_json())
        self.assertEqual(sorted(item["type"] for item in replies), ["error", "joined"])
        self.assertEqual(next(item for item in replies if item["type"] == "error")["code"], "ROOM_FULL")
        self.assertEqual(len(self.app[SERVICE_KEY].rooms[room].members), 2)

    async def test_sdp_ice_relay_and_server_verified_sender(self):
        a, aid, b, bid, _ = await self.pair()
        description = {"type": "offer", "sdp": "v=0\r\n"}
        await a.send_json({"type": "signal", "target": bid, "from": "forged", "payload": {"description": description, "untrusted": "removed"}})
        signal = await self.receive(b, "signal")
        self.assertEqual(signal, {"type": "signal", "from": aid, "payload": {"description": description}})
        candidate = {"candidate": "candidate:test", "sdpMid": "0", "sdpMLineIndex": 0, "usernameFragment": "ufrag"}
        await b.send_json({"type": "signal", "target": aid, "payload": {"candidate": candidate}})
        self.assertEqual((await self.receive(a, "signal"))["payload"]["candidate"], candidate)

    async def test_cross_room_and_self_target_are_rejected(self):
        a, aid, _, _, _ = await self.pair()
        outsider, outsider_id = await self.connect()
        await outsider.send_json({"type": "create"})
        await self.receive(outsider, "joined")
        for target in (outsider_id, aid, {"invalid": "target"}):
            await a.send_json({"type": "signal", "target": target, "payload": {"description": {"type": "offer", "sdp": "private"}}})
            self.assertEqual((await self.receive(a, "error"))["code"], "PEER_NOT_FOUND")

    async def test_invalid_json_messages_rooms_and_application_data(self):
        a, _ = await self.connect()
        for raw in ("{broken", '{"type":NaN}'):
            await a.send_str(raw)
            self.assertEqual((await self.receive(a, "error"))["code"], "INVALID_JSON")
        for value in (None, [], "hello"):
            await a.send_json(value)
            self.assertEqual((await self.receive(a, "error"))["code"], "INVALID_MESSAGE")
        await a.send_bytes(b"binary")
        self.assertEqual((await self.receive(a, "error"))["code"], "INVALID_MESSAGE")
        for room, code in (("oops", "INVALID_ROOM"), ("AAAAAAAAAA", "ROOM_NOT_FOUND")):
            await a.send_json({"type": "join", "room": room})
            self.assertEqual((await self.receive(a, "error"))["code"], code)
        await a.send_json({"type": "chat", "text": "P2P only"})
        self.assertEqual((await self.receive(a, "error"))["code"], "UNKNOWN_TYPE")

    async def test_invalid_signal_does_not_crash_handler(self):
        a, _, b, bid, _ = await self.pair()
        for payload in (None, [], {"description": {"type": ["offer"], "sdp": "bad"}}, {"candidate": {"candidate": 12}}):
            await a.send_json({"type": "signal", "target": bid, "payload": payload})
            self.assertEqual((await self.receive(a, "error"))["code"], "INVALID_SIGNAL")
        await a.send_json({"type": "signal", "target": bid, "payload": {"description": {"type": "answer", "sdp": "v=0"}}})
        await self.receive(b, "signal")

    async def test_double_join_is_rejected_and_name_is_bounded(self):
        a, _ = await self.connect()
        await a.send_json({"type": "create", "name": "가" * 100})
        room = (await self.receive(a, "joined"))["room"]
        await a.send_json({"type": "create"})
        self.assertEqual((await self.receive(a, "error"))["code"], "ALREADY_JOINED")
        b, _ = await self.connect()
        await b.send_json({"type": "join", "room": room})
        self.assertEqual(len((await self.receive(b, "joined"))["peers"][0]["name"]), 30)

    async def test_socket_close_notifies_peer_and_allows_reentry(self):
        a, _, b, bid, room = await self.pair()
        await b.close()
        self.assertEqual((await self.receive(a, "peer-left"))["peerId"], bid)
        c, _ = await self.connect()
        await c.send_json({"type": "join", "room": room})
        await self.receive(c, "joined")

    async def test_untrusted_origin_is_rejected_and_allowlist_works(self):
        with self.assertRaises(WSServerHandshakeError) as rejected:
            await self.client.ws_connect("/signal", origin="https://untrusted.example")
        self.assertEqual(rejected.exception.status, 403)
        with self.assertRaises(WSServerHandshakeError):
            await self.client.ws_connect("/signal")
        service = self.app[SERVICE_KEY]
        service.settings = replace(service.settings, allowed_origins=frozenset({"https://allowed.example"}))
        allowed, _ = await self.connect("https://allowed.example")
        await allowed.close()

    async def test_rate_and_payload_limits(self):
        service = self.app[SERVICE_KEY]
        service.settings = replace(service.settings, messages_per_window=2)
        a, _ = await self.connect()
        for _ in range(2):
            await a.send_json({"type": "unknown"})
            await self.receive(a, "error")
        await a.send_json({"type": "unknown"})
        self.assertEqual((await a.receive()).type, WSMsgType.CLOSE)
        self.assertEqual(a.close_code, 1008)
        b, _ = await self.connect()
        await b.send_str("x" * (64 * 1024 + 1))
        self.assertEqual((await b.receive()).type, WSMsgType.CLOSE)
        self.assertEqual(b.close_code, 1009)

    async def test_empty_room_expiration_and_room_limit(self):
        service = self.app[SERVICE_KEY]
        service.settings = replace(service.settings, max_rooms=1)
        a, _ = await self.connect()
        await a.send_json({"type": "create"})
        room = (await self.receive(a, "joined"))["room"]
        b, _ = await self.connect()
        await b.send_json({"type": "create"})
        self.assertEqual((await self.receive(b, "error"))["code"], "SERVER_BUSY")
        await a.send_json({"type": "leave"})
        await self.receive(a, "left")
        service.rooms[room].updated_at = time.monotonic() - service.settings.room_ttl - 1
        service.sweep_rooms()
        self.assertNotIn(room, service.rooms)
        await b.send_json({"type": "create"})
        await self.receive(b, "joined")


class SettingsTests(unittest.TestCase):
    def test_default_configuration(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            settings = load_settings(["--config", str(Path(directory) / "missing.toml")])
        self.assertEqual((settings.host, settings.port), ("0.0.0.0", 3000))
        self.assertEqual(len(settings.stun_urls), 2)
        self.assertIsNone(tls_context(settings))

    def test_toml_environment_and_cli_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.toml"
            config_path.write_text('host="127.0.0.1"\nport=3001\nstun_urls=["stun:example.com:19302"]\nallowed_origins=["https://allowed.example"]\n', encoding="utf-8-sig")
            with patch.dict(os.environ, {"PORT": "3002", "STUN_URLS": ""}, clear=True):
                settings = load_settings(["--config", str(config_path)])
                self.assertEqual((settings.host, settings.port, settings.stun_urls), ("127.0.0.1", 3002, ()))
                self.assertIn("https://allowed.example", settings.allowed_origins)
                settings = load_settings(["--config", str(config_path), "--port", "3003", "--stun-urls", "stun:cli.example:19302"])
                self.assertEqual((settings.port, settings.stun_urls), (3003, ("stun:cli.example:19302",)))

    def test_invalid_port_turn_and_partial_tls_are_rejected(self):
        for parameters in ({"port": 70000}, {"stun_urls": ("turn:example.com",)}, {"tls_cert": "only-cert.pem"}):
            with self.assertRaises(ValueError):
                Settings(**parameters)


if __name__ == "__main__":
    unittest.main(verbosity=2)
