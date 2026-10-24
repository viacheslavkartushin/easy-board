"""Text recognition in images via a vision model in Ollama."""
from __future__ import annotations

import base64
import json
import queue
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import llama as llamamod

ASSET_RE = re.compile(r"^[0-9a-f]{24}(\.[a-z0-9]{1,8})?$")
IMG_OK = {".png", ".jpg", ".jpeg", ".webp"}
SUGGESTED = [
    ("glm-ocr", "GLM-OCR — 0.9B, built for text recognition (Russian, English, etc.)"),
    ("qwen3-vl:2b", "Qwen3-VL 2B — 1.9 GB, general purpose, 32 OCR languages"),
    ("qwen3-vl:4b", "Qwen3-VL 4B — 3.3 GB, more accurate"),
    ("qwen3-vl:8b", "Qwen3-VL 8B — 6.1 GB, even more accurate, needs a GPU"),
]
PROMPT_GENERIC = ("Read all the text in this image and output it exactly as written, keeping line breaks and the original "
                  "languages (Russian and English). Output only the text, nothing else.")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,100}$")


class OllamaError(Exception):
    pass


def norm(name: str) -> str:
    name = (name or "").strip()
    return name if ":" in name.split("/")[-1] else name + ":latest"


class Ollama:
    def __init__(self, host: str = "http://127.0.0.1:11434"):
        self.base = host.rstrip("/")

    def _open(self, path: str, body: dict | None = None, timeout: float = 5):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"},
                                     method="GET" if body is None else "POST")
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode("utf-8", "replace")).get("error") or ""
            except Exception:
                msg = ""
            raise OllamaError(msg or f"HTTP {e.code}") from None
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
            raise OllamaError(f"Ollama is unreachable at {self.base}: start it (ollama.com)") from e

    def _json(self, path, body=None, timeout=5):
        with self._open(path, body, timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace") or "{}")

    def version(self) -> str | None:
        try:
            return str(self._json("/api/version", timeout=2).get("version"))
        except OllamaError:
            return None

    def tags(self) -> list[dict]:
        return [{"name": m.get("name"), "size": m.get("size", 0)} for m in self._json("/api/tags").get("models", [])]

    def ps(self) -> list[dict]:
        return [{"name": m.get("name"), "size": m.get("size", 0), "vram": m.get("size_vram", 0)}
                for m in self._json("/api/ps").get("models", [])]

    def keep(self, model: str, keep_alive):
        """keep_alive: 0 unloads; -1 keeps loaded; '10m' keeps for 10 minutes. An empty request only loads/unloads."""
        self._json("/api/generate", {"model": model, "keep_alive": keep_alive}, timeout=600)

    def pull(self, model: str):
        with self._open("/api/pull", {"model": model, "stream": True}, timeout=60) as r:
            for line in r:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                if d.get("error"):
                    raise OllamaError(str(d["error"]))
                yield d

    def chat(self, model: str, prompt: str, image: bytes, keep_alive, num_ctx: int = 8192):
        """Generator of text chunks. Closing the generator aborts the request, so Ollama stops generating."""
        body = {
            "model": model, "stream": True, "keep_alive": keep_alive,
            "messages": [{"role": "user", "content": prompt, "images": [base64.b64encode(image).decode()]}],
            "options": {"temperature": 0, "num_ctx": num_ctx},
        }
        r = self._open("/api/chat", body, timeout=600)
        try:
            for line in r:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                if d.get("error"):
                    raise OllamaError(str(d["error"]))
                piece = (d.get("message") or {}).get("content") or ""
                if piece:
                    yield piece
                if d.get("done"):
                    break
        finally:
            r.close()


class Cancelled(Exception):
    pass


class OcrJob:
    def __init__(self, asset: str, model: str, keep, engine: str = "ollama"):
        self.id = secrets.token_hex(6)
        self.asset, self.model, self.keep, self.engine = asset, model, keep, engine
        self.status = "queued"
        self.text = ""
        self.error = ""
        self.cancel = False
        self.created = time.time()


class PullJob:
    def __init__(self, model: str):
        self.model = model
        self.status = "starting"
        self.total = 0
        self.completed = 0
        self.error = ""
        self.done = False
        self.cancel = False


class OcrService:
    def __init__(self, assets: Path, client: Ollama, llama=None):
        self.assets = assets
        self.client = client
        self.llama = llama
        self.jobs: dict[str, OcrJob] = {}
        self.q: queue.Queue[OcrJob] = queue.Queue()
        self.lock = threading.Lock()
        self._thread = None
        self.last_used = 0.0
        self.pull_job: PullJob | None = None

    def busy(self) -> bool:
        return any(j.status in ("queued", "loading", "running") for j in list(self.jobs.values()))

    def submit(self, asset: str, model: str, keep, engine: str = "ollama") -> OcrJob:
        if not ASSET_RE.match(asset or "") or not (self.assets / asset).is_file():
            raise ValueError("file not found")
        ext = "." + asset.rsplit(".", 1)[-1].lower() if "." in asset else ""
        if ext not in IMG_OK:
            raise ValueError("Unsupported format (PNG, JPG or WebP required). Save the image in one of them.")
        if engine == "llama":
            if not self.llama:
                raise ValueError("llama.cpp is not connected")
        elif not MODEL_RE.match(model or ""):
            raise ValueError("invalid model name")
        job = OcrJob(asset, model, keep, engine)
        with self.lock:
            self.jobs[job.id] = job
            for jid in sorted(self.jobs, key=lambda j: self.jobs[j].created)[:-30]:
                if self.jobs[jid].status in ("done", "error", "cancelled"):
                    del self.jobs[jid]
            if not self._thread or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._worker, daemon=True)
                self._thread.start()
        self.q.put(job)
        return job

    def get(self, jid):
        return self.jobs.get(jid)

    def cancel(self, jid):
        j = self.jobs.get(jid)
        if j and j.status in ("queued", "loading", "running"):
            j.cancel = True
            if j.status == "queued":
                j.status = "cancelled"

    def state(self, job: OcrJob) -> dict:
        pos = 0
        if job.status == "queued":
            pos = sum(1 for j in list(self.q.queue) if j.created < job.created and j.status == "queued") + 1
        return {"id": job.id, "status": job.status, "text": job.text, "error": job.error, "model": job.model, "queue": pos}

    def _worker(self):
        while True:
            job = self.q.get()
            if job.cancel or job.status == "cancelled":
                job.status = "cancelled"
                continue
            try:
                job.status = "loading"
                data = (self.assets / job.asset).read_bytes()
                if job.engine == "llama":
                    gen = self.llama.run(job, data, job.asset.rsplit(".", 1)[-1].lower())
                else:
                    prompt = "Text Recognition:" if job.model.lower().startswith("glm-ocr") else PROMPT_GENERIC
                    gen = self.client.chat(job.model, prompt, data, job.keep)
                try:
                    for piece in gen:
                        job.status = "running"
                        if job.cancel:
                            raise Cancelled()
                        job.text += piece
                finally:
                    gen.close()
                job.text = job.text.strip()
                job.status = "done"
            except (Cancelled, llamamod.Cancelled):
                job.status = "cancelled"
            except Exception as e:
                job.status = "error"
                job.error = self._explain(e)
            finally:
                self.last_used = time.time()
                if self.llama:
                    self.llama.last_used = time.time()

    @staticmethod
    def _explain(e: Exception) -> str:
        msg = str(e) or e.__class__.__name__
        if isinstance(e, llamamod.LlamaError):
            return msg[:400]
        if re.search(r"not found|try pulling", msg, re.I):
            return "Model not downloaded: click \"Download\" in the models panel on the right."
        if re.search(r"does not support|vision|image", msg, re.I):
            return "This model cannot work with images: " + msg[:160]
        return msg[:300]

    def start_pull(self, model: str):
        if not MODEL_RE.match(model or ""):
            raise ValueError("invalid model name")
        if self.pull_job and not self.pull_job.done:
            raise ValueError("a download is already in progress")
        pj = PullJob(model)
        self.pull_job = pj

        def run():
            try:
                for d in self.client.pull(model):
                    if pj.cancel:
                        pj.error = "cancelled"
                        break
                    pj.status = str(d.get("status") or "")
                    if d.get("total"):
                        pj.total, pj.completed = int(d["total"]), int(d.get("completed") or 0)
            except Exception as e:
                pj.error = str(e)[:300]
            finally:
                pj.done = True

        threading.Thread(target=run, daemon=True).start()

    def cancel_pull(self):
        if self.pull_job and not self.pull_job.done:
            self.pull_job.cancel = True
