"""Fetching material by URL: the server downloads everything itself because CORS blocks the browser."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
MAX_FILE = 4 * 1024 ** 3
MAX_HTML = 2 * 1024 ** 2
MAX_TEXT = 2 * 1024 ** 2
MAX_THUMB = 12 * 1024 ** 2
MAX_ICON = 512 * 1024

CTYPE_EXT = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
    "image/bmp": "bmp", "image/avif": "avif", "image/svg+xml": "svg", "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico", "application/pdf": "pdf",
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg",
    "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/flac": "flac", "audio/webm": "weba",
    "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogv", "video/quicktime": "mov", "video/x-matroska": "mkv",
}
IMG_EXT = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"}
AUDIO_EXT = {"mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba"}
VIDEO_EXT = {"mp4", "m4v", "webm", "ogv", "mov", "mkv"}
CODE_EXT = {
    "py": "python", "js": "javascript", "mjs": "javascript", "ts": "typescript", "tsx": "typescript", "jsx": "javascript",
    "json": "json", "css": "css", "scss": "scss", "c": "c", "h": "c", "cpp": "cpp", "hpp": "cpp", "cs": "csharp",
    "java": "java", "go": "go", "rs": "rust", "rb": "ruby", "php": "php", "sh": "bash", "bat": "shell", "ps1": "shell",
    "sql": "sql", "yaml": "yaml", "yml": "yaml", "toml": "ini", "ini": "ini", "lua": "lua", "kt": "kotlin",
    "swift": "swift", "r": "r", "gd": "python", "diff": "diff", "patch": "diff", "xml": "xml",
}

ALLOWED_EMBED_HOSTS = (
    "www.youtube-nocookie.com", "player.vimeo.com", "rutube.ru", "www.dailymotion.com", "player.twitch.tv",
    "clips.twitch.tv", "open.spotify.com", "w.soundcloud.com", "www.loom.com",
)


def embed_for(url: str):
    u = urlparse(url)
    host = (u.hostname or "").lower().removeprefix("www.")
    q = parse_qs(u.query)
    path = u.path

    if host in ("youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"):
        vid = None
        if host == "youtu.be":
            vid = path.strip("/").split("/")[0]
        elif path == "/watch":
            vid = (q.get("v") or [None])[0]
        else:
            m = re.match(r"^/(shorts|embed|live|v)/([\w-]{6,})", path)
            vid = m.group(2) if m else None
        start = 0
        t = (q.get("t") or q.get("start") or [""])[0]
        m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?", t) if t else None
        if m and any(m.groups()):
            start = int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)
        if vid and re.fullmatch(r"[\w-]{6,}", vid):
            emb = f"https://www.youtube-nocookie.com/embed/{vid}?rel=0" + (f"&start={start}" if start else "")
            canon = f"https://www.youtube.com/watch?v={vid}"
            return dict(embed=emb, oembed="https://www.youtube.com/oembed?format=json&url=" + quote(canon, safe=""),
                        provider="YouTube", mode="video", fallback_thumb=f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg")
        lst = (q.get("list") or [None])[0]
        if lst and path == "/playlist" and re.fullmatch(r"[\w-]+", lst):
            return dict(embed=f"https://www.youtube-nocookie.com/embed/videoseries?list={lst}", oembed=None, provider="YouTube", mode="video")

    if host == "vimeo.com" or host == "player.vimeo.com":
        m = re.search(r"/(\d{5,})", path)
        if m:
            return dict(embed=f"https://player.vimeo.com/video/{m.group(1)}",
                        oembed="https://vimeo.com/api/oembed.json?url=" + quote(f"https://vimeo.com/{m.group(1)}", safe=""),
                        provider="Vimeo", mode="video")

    if host == "rutube.ru":
        m = re.match(r"^/(?:video|play/embed)/([0-9a-f]{32})", path)
        if m:
            return dict(embed=f"https://rutube.ru/play/embed/{m.group(1)}",
                        oembed="https://rutube.ru/api/oembed/?format=json&url=" + quote(f"https://rutube.ru/video/{m.group(1)}/", safe=""),
                        provider="RuTube", mode="video")

    if host in ("dailymotion.com", "dai.ly"):
        m = re.match(r"^/(?:video/)?([a-z0-9]+)", path)
        if m:
            return dict(embed=f"https://www.dailymotion.com/embed/video/{m.group(1)}",
                        oembed="https://www.dailymotion.com/services/oembed?format=json&url=" + quote(f"https://www.dailymotion.com/video/{m.group(1)}", safe=""),
                        provider="Dailymotion", mode="video")

    if host == "twitch.tv" or host == "clips.twitch.tv":
        m = re.match(r"^/videos/(\d+)", path)
        if m:
            return dict(embed=f"https://player.twitch.tv/?video=v{m.group(1)}&autoplay=false", oembed=None, provider="Twitch", mode="video")
        m = re.match(r"^/[\w]+/clip/([\w-]+)", path) or (re.match(r"^/([\w-]+)$", path) if host == "clips.twitch.tv" else None)
        if m:
            return dict(embed=f"https://clips.twitch.tv/embed?clip={m.group(1)}&autoplay=false", oembed=None, provider="Twitch", mode="video")
        m = re.match(r"^/([\w]+)/?$", path)
        if m and m.group(1) not in ("directory", "videos", "downloads", "settings"):
            return dict(embed=f"https://player.twitch.tv/?channel={m.group(1)}&autoplay=false", oembed=None, provider="Twitch", mode="video")

    if host == "open.spotify.com":
        m = re.match(r"^/(?:intl-[a-z]+/)?(track|album|playlist|episode|show|artist)/(\w+)", path)
        if m:
            kind = m.group(1)
            return dict(embed=f"https://open.spotify.com/embed/{kind}/{m.group(2)}",
                        oembed="https://open.spotify.com/oembed?url=" + quote(f"https://open.spotify.com/{kind}/{m.group(2)}", safe=""),
                        provider="Spotify", mode=152 if kind in ("track", "episode") else 380)

    if host == "soundcloud.com" and len(path.strip("/").split("/")) >= 2:
        clean = f"https://soundcloud.com{path}"
        return dict(embed="https://w.soundcloud.com/player/?auto_play=false&url=" + quote(clean, safe=""),
                    oembed="https://soundcloud.com/oembed?format=json&url=" + quote(clean, safe=""),
                    provider="SoundCloud", mode=166 if "/sets/" not in path else 300)

    if host == "loom.com":
        m = re.match(r"^/(?:share|embed)/([0-9a-f]{32})", path)
        if m:
            return dict(embed=f"https://www.loom.com/embed/{m.group(1)}",
                        oembed="https://www.loom.com/v1/oembed?url=" + quote(f"https://www.loom.com/share/{m.group(1)}", safe=""),
                        provider="Loom", mode="video")
    return None


class _Meta(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.icons: list[tuple[str, str]] = []
        self.title = ""
        self._in_title = False
        self.stop = False

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"].strip()
        elif tag == "link" and a.get("href"):
            rel = a.get("rel", "").lower()
            if "icon" in rel or rel == "image_src":
                self.icons.append((rel, a["href"]))
        elif tag == "body":
            self.stop = True  # everything needed is in <head>

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and len(self.title) < 400:
            self.title += data


def _decode(body: bytes, header_charset: str | None) -> str:
    cs = header_charset
    if not cs:
        m = re.search(rb"<meta[^>]+charset=[\"']?\s*([\w-]+)", body[:4096], re.I)
        cs = m.group(1).decode("ascii", "ignore") if m else "utf-8"
    try:
        return body.decode(cs, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


class Cancelled(Exception):
    pass


class FetchJob:
    def __init__(self, url: str):
        self.id = secrets.token_hex(6)
        self.url = url
        self.status = "queued"
        self.phase = ""
        self.bytes = 0
        self.total = 0
        self.result: dict | None = None
        self.error = ""
        self.cancel = False
        self.created = time.time()


class Fetcher:
    def __init__(self, assets_dir: Path, tmp_dir: Path, workers: int = 4):
        self.assets = assets_dir
        self.tmp = tmp_dir
        self.jobs: dict[str, FetchJob] = {}
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="fetch")
        self.lock = threading.Lock()

    def submit(self, url: str) -> FetchJob:
        url = (url or "").strip()
        if not re.match(r"^https?://[^\s]+$", url, re.I):
            raise ValueError("an http(s):// link is required")
        job = FetchJob(url)
        with self.lock:
            self.jobs[job.id] = job
            for jid in sorted(self.jobs, key=lambda j: self.jobs[j].created)[:-60]:
                if self.jobs[jid].status in ("done", "error", "cancelled"):
                    del self.jobs[jid]
        self.pool.submit(self._run, job)
        return job

    def get(self, jid: str):
        return self.jobs.get(jid)

    def cancel(self, jid: str):
        j = self.jobs.get(jid)
        if j and j.status in ("queued", "running"):
            j.cancel = True

    @staticmethod
    def state(job: FetchJob) -> dict:
        return {"id": job.id, "status": job.status, "phase": job.phase, "bytes": job.bytes, "total": job.total,
                "error": job.error, "result": job.result}

    def _run(self, job: FetchJob):
        if job.cancel:
            job.status = "cancelled"
            return
        job.status = "running"
        try:
            job.result = self._process(job)
            job.status = "done"
        except Cancelled:
            job.status = "cancelled"
        except Exception as e:
            job.status = "error"
            job.error = self._explain(e)

    @staticmethod
    def _explain(e: Exception) -> str:
        if isinstance(e, urllib.error.HTTPError):
            return f"Server responded: HTTP {e.code}"
        if isinstance(e, urllib.error.URLError):
            return f"Could not connect: {e.reason}"
        if isinstance(e, TimeoutError) or "timed out" in str(e):
            return "Timed out"
        return str(e)[:300] or e.__class__.__name__

    def _open(self, url: str, accept="*/*", timeout=20):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Accept": accept, "Accept-Language": "ru,en;q=0.8", "Accept-Encoding": "identity",
        })
        return urllib.request.urlopen(req, timeout=timeout)

    def _check(self, job: FetchJob):
        if job.cancel:
            raise Cancelled()

    def _process(self, job: FetchJob) -> dict:
        url = job.url
        now = int(time.time())
        job.phase = "connect"
        emb = embed_for(url)
        if emb:
            return self._embed(job, url, emb, now)

        with self._open(url) as resp:
            final = resp.geturl()
            ctype = resp.headers.get_content_type()
            cs = resp.headers.get_content_charset()
            job.total = int(resp.headers.get("Content-Length") or 0)
            name = self._filename(resp, final)
            ext = (Path(urlparse(final).path).suffix.lower().lstrip(".") or "")
            kind = self._classify(ctype, ext)
            job.phase = "download"

            if kind == "html":
                body = self._read(resp, job, MAX_HTML, strict=False)
                return self._page(job, url, final, _decode(body, cs), now)
            if kind in ("md", "note", "code"):
                body = self._read(resp, job, MAX_TEXT, strict=True)
                text = _decode(body, cs)
                res = {"type": kind, "text": text, "name": name, "src": url}
                if kind == "code":
                    res["lang"] = CODE_EXT.get(ext, "auto")
                return res
            fext = CTYPE_EXT.get(ctype) or re.sub(r"[^a-z0-9]", "", ext)[:8]
            asset, size = self._save(resp, job, fext, MAX_FILE)
            return {"type": kind, "url": "/assets/" + asset, "name": name, "size": size, "src": url}

    @staticmethod
    def _classify(ctype: str, ext: str) -> str:
        if ctype.startswith("image/") or (ctype in ("application/octet-stream", "") and ext in IMG_EXT):
            return "image"
        if ctype.startswith("audio/") or (ctype in ("application/octet-stream", "") and ext in AUDIO_EXT):
            return "audio"
        if ctype.startswith("video/") or (ctype in ("application/octet-stream", "") and ext in VIDEO_EXT):
            return "video"
        if ctype == "application/pdf" or (ctype in ("application/octet-stream", "") and ext == "pdf"):
            return "pdf"
        if ctype in ("text/html", "application/xhtml+xml"):
            return "html"
        if ext in ("md", "markdown") or ctype == "text/markdown":
            return "md"
        if ext in CODE_EXT and (ctype.startswith("text/") or ctype in ("application/json", "application/javascript", "application/xml", "application/octet-stream", "application/x-sh", "application/toml", "application/yaml")):
            return "code"
        if ctype == "text/plain":
            return "note"
        return "file"

    @staticmethod
    def _filename(resp, final: str) -> str:
        cd = resp.headers.get("Content-Disposition") or ""
        m = re.search(r"filename\*=(?:UTF-8|utf-8)''([^;]+)", cd) or re.search(r'filename="?([^";]+)"?', cd)
        if m:
            return unquote(m.group(1))[:200]
        base = unquote(Path(urlparse(final).path).name)
        return (base or urlparse(final).hostname or "file")[:200]

    def _read(self, resp, job: FetchJob, limit: int, strict: bool) -> bytes:
        buf = bytearray()
        while True:
            self._check(job)
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            buf += chunk
            job.bytes = len(buf)
            if len(buf) > limit:
                if strict:
                    raise ValueError("file is too large")
                break
        return bytes(buf)

    def _save(self, resp, job: FetchJob, ext: str, limit: int) -> tuple[str, int]:
        h = hashlib.sha256()
        tmp = self.tmp / f"fetch-{job.id}"
        n = 0
        try:
            with open(tmp, "wb") as f:
                while True:
                    self._check(job)
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    n += len(chunk)
                    if n > limit:
                        raise ValueError("file is too large")
                    h.update(chunk)
                    f.write(chunk)
                    job.bytes = n
            name = h.hexdigest()[:24] + (("." + ext) if ext else "")
            dest = self.assets / name
            if dest.exists():
                tmp.unlink(missing_ok=True)
            else:
                os.replace(tmp, dest)
            return name, n
        finally:
            tmp.unlink(missing_ok=True)

    def _small(self, url: str | None, job: FetchJob, limit: int) -> str | None:
        if not url or not re.match(r"^https?://", url, re.I):
            return None
        try:
            with self._open(url, accept="image/*,*/*;q=0.5", timeout=12) as r:
                ct = r.headers.get_content_type()
                ext = CTYPE_EXT.get(ct)
                if not ext or not ct.startswith("image/"):
                    return None
                if int(r.headers.get("Content-Length") or 0) > limit:
                    return None
                name, _ = self._save(r, job, ext, limit)
                return "/assets/" + name
        except Cancelled:
            raise
        except Exception:
            return None

    def _page(self, job, url, final, html, now) -> dict:
        job.phase = "meta"
        p = _Meta()
        try:
            p.feed(html)
        except Exception:
            pass
        m = p.meta
        pick = lambda *keys: next((m[k] for k in keys if m.get(k)), "")
        title = pick("og:title", "twitter:title") or re.sub(r"\s+", " ", p.title).strip() or urlparse(final).hostname or url
        desc = pick("og:description", "twitter:description", "description")
        site = pick("og:site_name", "application-name") or (urlparse(final).hostname or "").removeprefix("www.")
        img = pick("og:image", "og:image:url", "twitter:image", "twitter:image:src")
        if not img:
            img = next((h for r, h in p.icons if r == "image_src"), "")
        icon = ""
        for rel, h in p.icons:
            if rel in ("icon", "shortcut icon"):
                icon = h
                break
        if not icon:
            icon = next((h for r, h in p.icons if "icon" in r), "") or "/favicon.ico"
        thumb = self._small(urljoin(final, img), job, MAX_THUMB) if img else None
        fav = self._small(urljoin(final, icon), job, MAX_ICON)
        try:
            archive = self._archive(job, final, html)
        except Cancelled:
            raise
        except Exception:
            archive = None  # the page copy is a nice extra, not a required part of the bookmark
        return {
            "type": "link", "href": url, "final": final, "title": title[:300], "desc": desc[:600], "site": site[:80],
            "thumb": thumb, "favicon": fav, "archive": archive, "fetched": now,
        }


    ARCH_BUDGET = 14 * 1024 ** 2

    def _inline(self, url: str, job, limit: int, kinds: tuple, accept: str):
        if not re.match(r"^https?://", url, re.I):
            return None
        try:
            with self._open(url, accept=accept, timeout=8) as r:
                ct = r.headers.get_content_type()
                if not ct.startswith(kinds):
                    return None
                if int(r.headers.get("Content-Length") or 0) > limit:
                    return None
                data = r.read(limit + 1)
                return (ct, data) if len(data) <= limit else None
        except Cancelled:
            raise
        except Exception:
            return None

    def _archive(self, job, final: str, html: str) -> str | None:
        from concurrent.futures import ThreadPoolExecutor as TPE
        import base64
        job.phase = "archive"
        spent = [0]
        deadline = time.time() + 45

        def can(n):
            return spent[0] + n <= self.ARCH_BUDGET and time.time() < deadline

        def data_uri(ct, data):
            spent[0] += len(data)
            return f"data:{ct};base64,{base64.b64encode(data).decode()}"

        html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
        for tag in ("script", "noscript", "iframe", "object", "embed", "applet", "template"):
            html = re.sub(rf"<{tag}\b.*?</{tag}\s*>", "", html, flags=re.S | re.I)
            html = re.sub(rf"<{tag}\b[^>]*>", "", html, flags=re.I)
        html = re.sub(r"<base\b[^>]*>", "", html, flags=re.I)
        html = re.sub(r"<meta\b[^>]*http-equiv\s*=\s*[\"']?refresh[^>]*>", "", html, flags=re.I)
        html = re.sub(r"\son[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", html, flags=re.I)
        html = re.sub(r"(href|src|action|formaction)\s*=\s*([\"'])\s*javascript:[^\"']*\2", r"\1=\2#\2", html, flags=re.I)

        def getattr_(tag, name):
            m = re.search(rf"""\b{name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", tag, re.I)
            return next((g for g in m.groups() if g), "") if m else ""

        def css_fix(css: str, base: str) -> str:
            css = re.sub(r"@import[^;]*;", "", css)
            def one(m):
                u = m.group(2).strip()
                if u.startswith("data:") or u.startswith("#"):
                    return m.group(0)
                got = self._inline(urljoin(base, u), job, 400 * 1024, ("image/", "font/", "application/font", "application/x-font", "application/vnd.ms-fontobject", "application/octet-stream"), "*/*") if can(1) else None
                return f"url({data_uri(*got)})" if got else "url()"
            return re.sub(r"""url\(\s*(["']?)([^)"']+)\1\s*\)""", one, css)

        links = list(re.finditer(r"<link\b[^>]*>", html, re.I))
        sheets = [m for m in links if "stylesheet" in getattr_(m.group(0), "rel").lower() and getattr_(m.group(0), "href")][:12]
        repl: dict[str, str] = {}
        with TPE(6) as ex:
            futs = {m.group(0): ex.submit(self._inline, urljoin(final, getattr_(m.group(0), "href")), job, 1024 * 1024, ("text/css",), "text/css,*/*;q=0.1") for m in sheets}
            for tagtxt, fu in futs.items():
                got = fu.result()
                repl[tagtxt] = f"<style>{css_fix(got[1].decode('utf-8', 'replace'), urljoin(final, getattr_(tagtxt, 'href')))}</style>" if got else ""
        for m in links:
            t = m.group(0)
            if t in repl:
                html = html.replace(t, repl[t], 1)
            else:
                html = html.replace(t, "", 1)
        html = re.sub(r"(<style\b[^>]*>)(.*?)(</style>)", lambda m: m.group(1) + css_fix(m.group(2), final) + m.group(3), html, flags=re.S | re.I)
        self._check(job)

        imgs = list(dict.fromkeys(m.group(0) for m in re.finditer(r"<img\b[^>]*>", html, re.I)))[:60]

        def pick(tag):
            src = getattr_(tag, "src")
            if not src or src.startswith("data:image/gif") or len(src) < 4:
                src = getattr_(tag, "data-src") or getattr_(tag, "data-original") or src
            if not src:
                ss = getattr_(tag, "srcset") or getattr_(tag, "data-srcset")
                if ss:
                    src = ss.split(",")[0].strip().split(" ")[0]
            return src

        todo = {t: pick(t) for t in imgs}
        with TPE(6) as ex:
            futs = {t: ex.submit(self._inline, urljoin(final, s), job, 2 * 1024 ** 2, ("image/",), "image/*") for t, s in todo.items() if s and not s.startswith("data:")}
            res = {t: fu.result() for t, fu in futs.items()}
        for t in imgs:
            s = todo[t]
            if s.startswith("data:"):
                new = re.sub(r"\s(srcset|data-srcset)\s*=\s*(\"[^\"]*\"|'[^']*')", "", t, flags=re.I)
            else:
                got = res.get(t)
                if got and can(len(got[1])):
                    stripped = re.sub(r"\s(src|srcset|data-src|data-srcset|data-original|loading)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", t, flags=re.I)
                    new = stripped[:-1].rstrip("/ ") + f' src="{data_uri(*got)}">'
                else:
                    new = "<span class='arch-noimg'></span>"
            html = html.replace(t, new, 1)
        # other images that could not be embedded (picture/source/style background) simply will not load — CSP forbids network
        html = re.sub(r"<source\b[^>]*>", "", html, flags=re.I)

        def fix_a(m):
            t = m.group(0)
            h = getattr_(t, "href")
            if h and not h.startswith(("#", "mailto:", "tel:")):
                t = re.sub(r"""(\bhref\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)""", lambda _m: f'{_m.group(1)}"{urljoin(final, h)}"', t, count=1, flags=re.I)
            return t
        html = re.sub(r"<a\b[^>]*>", fix_a, html, flags=re.I)

        banner = f"<!-- Copy of page {final} from {time.strftime('%Y-%m-%d %H:%M:%S')} (scripts removed) -->"
        head_add = "<meta charset='utf-8'><base target='_blank'>"
        if re.search(r"<head\b[^>]*>", html, re.I):
            html = re.sub(r"(<head\b[^>]*>)", lambda m: m.group(1) + head_add, html, count=1, flags=re.I)
        else:
            html = "<head>" + head_add + "</head>" + html
        data = (banner + html).encode("utf-8")
        h = hashlib.sha256(data).hexdigest()[:24]
        name = h + ".html"
        dest = self.assets / name
        if not dest.exists():
            tmp = self.tmp / f"arch-{job.id}"
            tmp.write_bytes(data)
            os.replace(tmp, dest)
        return "/assets/" + name

    def _embed(self, job, url, emb, now) -> dict:
        title = author = ""
        thumb_url = emb.get("fallback_thumb")
        if emb.get("oembed"):
            try:
                job.phase = "meta"
                with self._open(emb["oembed"], accept="application/json", timeout=10) as r:
                    d = json.loads(r.read(512 * 1024).decode("utf-8", "replace"))
                title = str(d.get("title") or "")
                author = str(d.get("author_name") or "")
                thumb_url = d.get("thumbnail_url") or thumb_url
            except Cancelled:
                raise
            except Exception:
                pass
        thumb = self._small(thumb_url, job, MAX_THUMB) if thumb_url else None
        res = {"type": "embed", "href": url, "embed": emb["embed"], "provider": emb["provider"], "title": title[:300],
               "author": author[:120], "thumb": thumb, "fetched": now}
        if emb["mode"] == "video":
            res["ar"] = 16 / 9
        else:
            res["h"] = int(emb["mode"])
        return res
