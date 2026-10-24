"""Easy Board: a local whiteboard. Run: uv run main.py"""
from __future__ import annotations

import argparse
import atexit
import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import transcribe as tr
from fetcher import Fetcher
from models import Models, Settings
from downloads import NeedConfirm, llama_info, ollama_info, run_info, whisper_info
from llama import LlamaEngine, LlamaError
from ocr import Ollama, OcrService
from projects import ProjectError, Projects

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
MAX_UPLOAD = 4 * 1024 ** 3
MAX_BOARD = 256 * 1024 ** 2
MAX_ZIP = 16 * 1024 ** 3

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}

# Types that are safe to serve as-is (inline). Everything else is served as a downloadable blob.
ASSET_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".html": "text/html; charset=utf-8",  # page copies only; always under sandbox CSP
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
    ".opus": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
    ".weba": "audio/webm",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
    ".mov": "video/quicktime", ".mkv": "video/x-matroska",
}

ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
LAN_KEYS = ("llama_bin", "llama_model", "llama_mmproj", "llama_args")


def is_loopback(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
        return ip.is_loopback or bool(getattr(ip, "ipv4_mapped", None) and ip.ipv4_mapped.is_loopback)
    except ValueError:
        return False


def host_allowed(header: str, bind: str) -> bool:
    """Host header check against DNS rebinding: loopback names, the bind address, IP literals and this machine's name on a LAN."""
    host = (header or "").strip().lower()
    name = host.rsplit(":", 1)[0] if not host.endswith("]") else host
    if name in ALLOWED_HOSTS:
        return True
    if is_loopback(bind):
        return False
    bare = name.strip("[]")
    try:
        ipaddress.ip_address(bare)
        return True
    except ValueError:
        pass
    mine = socket.gethostname().lower()
    return bare in (mine, mine + ".local", socket.getfqdn().lower())


def make_handler(store: Projects, trans: tr.Transcriber, fetch: Fetcher, mm: Models, ocr: OcrService, bind: str = "127.0.0.1"):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "Board/2"

        def log_message(self, fmt, *args):
            if "--verbose" in sys.argv:
                super().log_message(fmt, *args)

        def _host_ok(self) -> bool:
            return host_allowed(self.headers.get("Host") or "", bind)

        def _send(self, code, body=b"", ctype="application/json", extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj).encode())

        def _guard(self, write=False) -> bool:
            if not self._host_ok():
                self._json(403, {"error": "bad host"})
                return False
            if write and self.headers.get("X-Board") != "1":
                self._json(403, {"error": "missing X-Board header"})
                return False
            return True

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            try:
                if not self._guard():
                    return
                u = urlparse(self.path)
                path = unquote(u.path)
                try:
                    if path.startswith("/api/"):
                        return self._api_get(path, parse_qs(u.query))
                except ProjectError as e:
                    return self._json(e.code, {"error": str(e)})
                if path.startswith("/assets/"):
                    return self._serve_file(store.assets, path[len("/assets/"):], assets=True)
                if path == "/":
                    path = "/index.html"
                return self._serve_file(WEB, path.lstrip("/"), assets=False)
            except (ConnectionError, TimeoutError):
                pass

        def _api_get(self, path, query):
            if path == "/api/projects":
                return self._json(200, store.list())
            m = re.fullmatch(r"/api/projects/([^/]+)/board", path)
            if m:
                return self._send(200, store.read_board(m.group(1)))
            m = re.fullmatch(r"/api/projects/([^/]+)/export", path)
            if m:
                zpath, name = store.export_zip(m.group(1))
                try:
                    from urllib.parse import quote
                    size = zpath.stat().st_size
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(size))
                    self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(name + ".board.zip"))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    with open(zpath, "rb") as f:
                        while chunk := f.read(1024 * 1024):
                            self.wfile.write(chunk)
                finally:
                    zpath.unlink(missing_ok=True)
                return
            m = re.fullmatch(r"/api/projects/([^/]+)/history", path)
            if m:
                return self._json(200, store.history(m.group(1)))
            if path == "/api/assets/unused":
                return self._json(200, store.unused_assets())
            if path == "/api/models":
                return self._json(200, mm.status())
            m = re.fullmatch(r"/api/ocr/([0-9a-f]+)", path)
            if m:
                job = ocr.get(m.group(1))
                if not job:
                    return self._json(404, {"error": "job not found"})
                return self._json(200, ocr.state(job))
            m = re.fullmatch(r"/api/fetch/([0-9a-f]+)", path)
            if m:
                job = fetch.get(m.group(1))
                if not job:
                    return self._json(404, {"error": "job not found"})
                return self._json(200, fetch.state(job))
            if path == "/api/transcribe/info":
                return self._json(200, {"available": tr.available(), "models": list(tr.MODELS)})
            m = re.fullmatch(r"/api/transcribe/([0-9a-f]+)", path)
            if m:
                job = trans.get(m.group(1))
                if not job:
                    return self._json(404, {"error": "job not found"})
                since = int((query.get("since") or ["0"])[0] or 0)
                return self._json(200, trans.state(job, since))
            return self._json(404, {"error": "not found"})

        def _serve_file(self, base: Path, rel: str, assets: bool):
            try:
                base_r = base.resolve()
                fp = (base_r / rel).resolve()
                if base_r not in fp.parents or not fp.is_file():
                    return self._json(404, {"error": "not found"})
            except (OSError, ValueError):
                return self._json(404, {"error": "not found"})

            ext = fp.suffix.lower()
            extra = {"Accept-Ranges": "bytes"}
            if assets:
                ctype = ASSET_TYPES.get(ext)
                if ctype is None:
                    ctype = "application/octet-stream"
                    extra["Content-Disposition"] = "attachment"
                if ctype.startswith("text/html"):
                    # page copy: no scripts, no network; only embedded styles, images and fonts
                    extra["Content-Security-Policy"] = ("sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; "
                                                        "style-src 'unsafe-inline'; img-src data:; font-src data:")
                elif ctype != "application/pdf":
                    extra["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
                extra["Cache-Control"] = "private, max-age=31536000, immutable"
            else:
                ctype = STATIC_TYPES.get(ext, "application/octet-stream")

            size = fp.stat().st_size
            start, end, code = 0, size - 1, 200
            rng = self.headers.get("Range")
            if rng:
                m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        start = int(m.group(1))
                        end = int(m.group(2)) if m.group(2) else size - 1
                    else:
                        start = max(0, size - int(m.group(2)))
                    end = min(end, size - 1)
                    if start > end or start >= size:
                        return self._send(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
                    code = 206
                    extra["Content-Range"] = f"bytes {start}-{end}/{size}"
            length = end - start + 1 if size else 0

            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("X-Content-Type-Options", "nosniff")
            if "Cache-Control" not in extra:
                self.send_header("Cache-Control", "no-cache")
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            if self.command == "HEAD" or not size:
                return
            with open(fp, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)

        def _body_len(self, limit: int):
            try:
                n = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self._json(411, {"error": "length required"})
                return None
            if n < 0 or n > limit:
                self._json(413, {"error": "too large"})
                return None
            return n

        def _read_json(self, limit=1024 * 1024):
            n = self._body_len(limit)
            if n is None:
                return None
            try:
                obj = json.loads(self.rfile.read(n) or b"{}")
                assert isinstance(obj, dict)
                return obj
            except Exception:
                self._json(400, {"error": "bad json"})
                return None

        def _save_body(self, limit, prefix):
            n = self._body_len(limit)
            if n is None:
                return None
            h = hashlib.sha256()
            tmp = store.tmp / f"{prefix}-{threading.get_ident()}-{time.time_ns()}"
            left = n
            with open(tmp, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(1024 * 1024, left))
                    if not chunk:
                        break
                    h.update(chunk)
                    f.write(chunk)
                    left -= len(chunk)
            if left:
                tmp.unlink(missing_ok=True)
                self._json(400, {"error": "incomplete upload"})
                return None
            return tmp, h.hexdigest(), n

        def do_PUT(self):
            try:
                if not self._guard(write=True):
                    return
                m = re.fullmatch(r"/api/projects/([^/]+)/board", urlparse(self.path).path)
                if not m:
                    return self._json(404, {"error": "not found"})
                try:
                    store.dir_of(m.group(1))
                    n = self._body_len(MAX_BOARD)
                    if n is None:
                        return
                    raw = self.rfile.read(n)
                    try:
                        obj = json.loads(raw)
                        assert isinstance(obj, dict) and isinstance(obj.get("items"), list)
                    except Exception:
                        return self._json(400, {"error": "bad board json"})
                    store.write_board(m.group(1), raw)
                    self._json(200, {"ok": True})
                except ProjectError as e:
                    self._json(e.code, {"error": str(e)})
            except (ConnectionError, TimeoutError):
                pass

        def do_POST(self):
            try:
                if not self._guard(write=True):
                    return
                u = urlparse(self.path)
                q = parse_qs(u.query)
                try:
                    return self._api_post(u.path, q)
                except ProjectError as e:
                    return self._json(e.code, {"error": str(e)})
                except NeedConfirm as e:
                    return self._json(409, {"error": str(e), "confirm": e.info})
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
            except (ConnectionError, TimeoutError):
                pass

        def _confirm_llama(self, body):
            try:
                program, command = mm.llama.preview()
            except LlamaError:
                return  # a misconfiguration is reported by the normal error path
            self._need(run_info(program, command), body)
            self._need(llama_info(mm.s.data["llama_model"]), body)

        def _need(self, info, body):
            """One-time notices: shown until the user confirms once; the answer is stored in settings.json."""
            if not info:
                return
            kind = info.get("kind", "download")
            if mm.s.acknowledged(kind):
                return
            if (body.get("confirmed") or {}).get(kind):
                mm.s.acknowledge(kind)
                return
            raise NeedConfirm(info)

        def _api_post(self, path, q):
            if path == "/api/upload":
                name = (q.get("name") or ["file"])[0]
                ext = re.sub(r"[^a-z0-9]", "", Path(name).suffix.lower())[:8]
                ext = f".{ext}" if ext else ""
                got = self._save_body(MAX_UPLOAD, "up")
                if not got:
                    return
                tmp, digest, n = got
                fname = digest[:24] + ext
                dest = store.assets / fname
                if dest.exists():
                    tmp.unlink(missing_ok=True)
                else:
                    os.replace(tmp, dest)
                return self._json(200, {"url": f"/assets/{fname}", "name": name, "size": n})
            if path == "/api/projects":
                body = self._read_json()
                if body is not None:
                    self._json(200, store.create(body.get("name", "")))
                return
            if path == "/api/projects/import":
                got = self._save_body(MAX_ZIP, "imp")
                if not got:
                    return
                tmp = got[0]
                try:
                    res = store.import_zip(tmp, (q.get("name") or ["Import"])[0])
                finally:
                    tmp.unlink(missing_ok=True)
                return self._json(200, res)
            m = re.fullmatch(r"/api/projects/([^/]+)/(rename|duplicate|delete)", path)
            if m:
                pid, act = m.groups()
                body = self._read_json()
                if body is None:
                    return
                if act == "rename":
                    store.rename(pid, body.get("name", ""))
                    return self._json(200, {"ok": True})
                if act == "duplicate":
                    return self._json(200, store.duplicate(pid, body.get("name")))
                store.delete(pid)
                return self._json(200, {"ok": True})
            m = re.fullmatch(r"/api/projects/([^/]+)/(snapshot|restore|snapshot-delete)", path)
            if m:
                pid, act = m.groups()
                body = self._read_json()
                if body is None:
                    return
                if act == "snapshot":
                    return self._json(200, {"t": store.snapshot(pid)})
                t = int(body.get("t", 0))
                if act == "restore":
                    store.restore(pid, t)
                else:
                    store.delete_snapshot(pid, t)
                return self._json(200, {"ok": True})
            if path == "/api/assets/delete":
                body = self._read_json()
                if body is None:
                    return
                n, size = store.delete_assets(list(body.get("names") or [])[:5000])
                return self._json(200, {"deleted": n, "size": size})
            if path == "/api/export/md":
                body = self._read_json(limit=64 * 1024 ** 2)
                if body is None:
                    return
                data = store.export_md_zip(str(body.get("name", "")), str(body.get("md", "")), list(body.get("assets") or []))
                from urllib.parse import quote
                fn = quote(str(body.get("name") or "board")[:60] + ".zip")
                return self._send(200, data, "application/zip", {"Content-Disposition": "attachment; filename*=UTF-8''" + fn})
            if path in ("/api/models/whisper", "/api/models/vl", "/api/models/settings"):
                body = self._read_json()
                if body is None:
                    return
                action = str(body.get("action", ""))
                if path.endswith("settings"):
                    if any(k in body for k in LAN_KEYS) and not is_loopback(self.client_address[0]):
                        return self._json(403, {"error": "Program paths can only be changed from the computer running the board (or edit data/settings.json)"})
                    mm.s.update(body)
                elif path.endswith("whisper"):
                    if action == "load":
                        self._need(whisper_info(trans.backend.models_dir, str(body.get("model") or "small")), body)
                    mm.whisper(action, body.get("model"))
                else:
                    if action == "load" and mm.engine() == "llama":
                        self._confirm_llama(body)
                    elif action == "pull":
                        self._need(ollama_info(str(body.get("model") or mm.s.data["vl_model"])), body)
                    mm.vl(action, body.get("model"))
                return self._json(200, {"ok": True})
            if path == "/api/ocr":
                body = self._read_json()
                if body is None:
                    return
                if mm.engine() == "llama":
                    self._confirm_llama(body)
                asset = str(body.get("asset", "")).removeprefix("/assets/")
                job = ocr.submit(asset, mm.vl_label(), mm.vl_keep(), mm.engine())
                return self._json(200, ocr.state(job))
            m = re.fullmatch(r"/api/ocr/([0-9a-f]+)/cancel", path)
            if m:
                ocr.cancel(m.group(1))
                return self._json(200, {"ok": True})
            if path == "/api/fetch":
                body = self._read_json()
                if body is None:
                    return
                return self._json(200, fetch.state(fetch.submit(str(body.get("url", "")))))
            m = re.fullmatch(r"/api/fetch/([0-9a-f]+)/cancel", path)
            if m:
                fetch.cancel(m.group(1))
                return self._json(200, {"ok": True})
            if path == "/api/transcribe":
                body = self._read_json()
                if body is None:
                    return
                if not tr.available():
                    return self._json(501, {"error": "faster-whisper is not installed. Run `uv sync` in the project folder."})
                if str(body.get("model", "small")) in tr.MODELS:
                    self._need(whisper_info(trans.backend.models_dir, str(body.get("model", "small"))), body)
                asset = str(body.get("asset", "")).removeprefix("/assets/")
                job = trans.submit(asset, str(body.get("model", "small")), body.get("language"))
                return self._json(200, trans.state(job))
            m = re.fullmatch(r"/api/transcribe/([0-9a-f]+)/cancel", path)
            if m:
                trans.cancel(m.group(1))
                return self._json(200, {"ok": True})
            return self._json(404, {"error": "not found"})

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class Server6(Server):
    address_family = socket.AF_INET6


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser(
        prog="main.py", formatter_class=argparse.RawDescriptionHelpFormatter, add_help=False,
        description="Easy Board: a local whiteboard. Everything is stored in the data folder.",
        usage="uv run main.py [options]",
        epilog="examples:\n  uv run main.py                        open the board on this computer\n"
               "  uv run main.py --host 0.0.0.0         also reachable from your local network (no password!)\n"
               "  uv run main.py --port 9000 --no-browser")
    g = ap.add_argument_group("options")
    g.add_argument("-h", "--help", action="help", help="show this help and exit")
    g.add_argument("--port", type=int, default=8765, metavar="N", help="port to listen on (default 8765)")
    g.add_argument("--host", default="127.0.0.1", metavar="IP", help="address to listen on (default 127.0.0.1: this computer only; 0.0.0.0: whole network)")
    g.add_argument("--data", default=str(ROOT / "data"), metavar="DIR", help="data folder (default: ./data)")
    g.add_argument("--device", choices=["auto", "cpu"], default="auto", help="transcription device: auto uses the GPU if there is one")
    g.add_argument("--ollama", default=os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434"), metavar="URL", help="Ollama address, if you use it for text in images")
    g.add_argument("--gc", action="store_true", help="delete files no project uses, then exit")
    g.add_argument("--no-browser", action="store_true", help="do not open the browser")
    g.add_argument("--verbose", action="store_true", help="log every request")
    args = ap.parse_args()
    try:
        bind_ip = ipaddress.ip_address(args.host.strip("[]"))
    except ValueError:
        sys.exit(f"--host must be an IP address (for example 127.0.0.1 or 0.0.0.0), got: {args.host}")
    bind = str(bind_ip)

    store = Projects(Path(args.data))
    if args.gc:
        n, size = store.gc_assets()
        print(f"Files deleted: {n}, freed {size / 1048576:.1f} MB")
        return
    backend = tr.FasterWhisperBackend(store.dir / "models", args.device)
    trans = tr.Transcriber(store.assets, backend)
    settings = Settings(store.dir / "settings.json")
    llama = LlamaEngine(settings, store.tmp / "llama-server.log")
    atexit.register(llama.stop)
    ocr = OcrService(store.assets, Ollama(args.ollama), llama)
    mm = Models(settings, backend, trans, ocr, lambda: tr.available(), llama)
    handler = make_handler(store, trans, Fetcher(store.assets, store.tmp), mm, ocr, bind)
    cls = Server6 if bind_ip.version == 6 else Server
    httpd = None
    for port in range(args.port, args.port + 20):
        try:
            httpd = cls((bind, port), handler)
            break
        except OSError:
            continue
    if httpd is None:
        sys.exit("Could not bind a port")
    local = f"http://localhost:{port}/"
    print(f"Easy Board: {local}\nData: {store.dir}")
    if not is_loopback(bind):
        shown = lan_ip() if bind_ip.is_unspecified else bind
        print(f"Network: http://{shown}:{port}/\n"
              "WARNING: there is no password. Anyone who can reach this address can read and change the board.\n"
              "Use it only on a network you trust.")
    print("Ctrl+C to stop")
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(local)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        llama.stop()


if __name__ == "__main__":
    main()
