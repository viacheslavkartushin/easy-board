"""Audio/video transcription via faster-whisper, one job at a time in a background thread."""
from __future__ import annotations

import gc
import importlib.util
import queue
import re
import secrets
import threading
import time
from pathlib import Path

MODELS = ("tiny", "base", "small", "medium", "large-v3", "turbo")
ASSET_RE = re.compile(r"^[0-9a-f]{24}(\.[a-z0-9]{1,8})?$")
CUDA_ERR = re.compile(r"cublas|cudnn|cuda|\.dll|libcu", re.I)


def available() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, asset: str, model: str, language: str | None):
        self.id = secrets.token_hex(6)
        self.asset, self.model, self.language = asset, model, language
        self.status = "queued"
        self.progress = 0.0
        self.segments: list[list] = []
        self.detected: str | None = None
        self.duration = 0.0
        self.error = ""
        self.cancel = False
        self.created = time.time()
        self.device = ""


class FasterWhisperBackend:

    def __init__(self, models_dir: Path, device: str = "auto"):
        self.models_dir = models_dir
        self.want = device
        self.models: dict[tuple, object] = {}
        self.force_cpu = device == "cpu"
        self.lock = threading.RLock()
        self.name: str | None = None
        self.dev: str | None = None
        self.loading = False
        self.last_used = time.time()

    def status(self) -> dict:
        return {"loaded": bool(self.models), "model": self.name, "device": self.dev, "loading": self.loading}

    def load(self, name: str):
        if name not in MODELS:
            raise ValueError("unknown model")
        self._load(name)

    def unload(self):
        with self.lock:
            self.models.clear()
            self.name = self.dev = None
        gc.collect()

    def _device(self) -> str:
        if self.force_cpu or self.want == "cpu":
            return "cpu"
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda"
        except Exception:
            pass
        return "cpu"

    def _load(self, name: str):
        from faster_whisper import WhisperModel
        with self.lock:
            dev = self._device()
            key = (name, dev)
            if key not in self.models:
                self.models.clear()
                gc.collect()
                self.loading = True
                try:
                    kw = dict(download_root=str(self.models_dir))
                    if dev == "cuda":
                        self.models[key] = WhisperModel(name, device="cuda", compute_type="float16", **kw)
                    else:
                        self.models[key] = WhisperModel(name, device="cpu", compute_type="int8", **kw)
                finally:
                    self.loading = False
            self.name, self.dev = name, dev
            self.last_used = time.time()
            return self.models[key], dev

    def run(self, job: Job, path: Path, on_status):
        """Generator of phrases (start, end, text). Raises Cancelled if the job was cancelled."""
        for attempt in (0, 1):
            on_status("loading")
            model, dev = self._load(job.model)
            job.device = dev
            on_status("running")
            try:
                segs, info = model.transcribe(
                    str(path), language=job.language, vad_filter=True, beam_size=5,
                    condition_on_previous_text=False,
                )
                job.duration = float(info.duration or 0)
                job.detected = info.language
                for s in segs:
                    if job.cancel:
                        raise Cancelled()
                    self.last_used = time.time()
                    text = s.text.strip()
                    if text:
                        yield s.start, s.end, text
                self.last_used = time.time()
                return
            except Cancelled:
                raise
            except Exception as e:
                # Common on Windows: the CUDA driver exists but cuBLAS/cuDNN do not — fall back to CPU.
                if dev == "cuda" and attempt == 0 and CUDA_ERR.search(str(e)):
                    self.force_cpu = True
                    job.segments.clear()
                    continue
                raise


class Transcriber:
    def __init__(self, assets_dir: Path, backend):
        self.assets = assets_dir
        self.backend = backend
        self.jobs: dict[str, Job] = {}
        self.q: queue.Queue[Job] = queue.Queue()
        self.lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def submit(self, asset: str, model: str, language: str | None) -> Job:
        if not ASSET_RE.match(asset or "") or not (self.assets / asset).is_file():
            raise ValueError("file not found")
        if model not in MODELS:
            raise ValueError("unknown model")
        language = (language or "").strip().lower() or None
        if language and not re.fullmatch(r"[a-z]{2,3}", language):
            raise ValueError("invalid language")
        job = Job(asset, model, language)
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

    def busy(self) -> bool:
        return any(j.status in ("queued", "loading", "running") for j in list(self.jobs.values()))

    def get(self, jid: str) -> Job | None:
        return self.jobs.get(jid)

    def cancel(self, jid: str):
        j = self.jobs.get(jid)
        if j and j.status in ("queued", "loading", "running"):
            j.cancel = True
            if j.status == "queued":
                j.status = "cancelled"

    def state(self, job: Job, since: int = 0) -> dict:
        pos = 0
        if job.status == "queued":
            pos = sum(1 for j in list(self.q.queue) if j.created < job.created and j.status == "queued") + 1
        return {
            "id": job.id, "status": job.status, "progress": round(job.progress, 4), "error": job.error,
            "language": job.detected, "duration": job.duration, "device": job.device, "queue": pos,
            "total": len(job.segments), "segments": job.segments[since:],
        }

    def _worker(self):
        while True:
            job = self.q.get()
            if job.cancel or job.status == "cancelled":
                job.status = "cancelled"
                continue
            try:
                def on_status(s, j=job):
                    j.status = s
                for s, e, t in self.backend.run(job, self.assets / job.asset, on_status):
                    job.segments.append([round(s, 2), round(e, 2), t])
                    if job.duration:
                        job.progress = min(0.99, e / job.duration)
                job.progress = 1.0
                job.status = "done"
            except Cancelled:
                job.status = "cancelled"
            except Exception as e:
                job.status = "error"
                job.error = self._explain(e)

    @staticmethod
    def _explain(e: Exception) -> str:
        msg = str(e) or e.__class__.__name__
        if isinstance(e, ImportError):
            return "faster-whisper is not installed. Run `uv sync` in the project folder."
        if re.search(r"huggingface|connection|resolve|offline|timed out|SSL", msg, re.I):
            return "Could not download the model (internet is needed the first time this model is used): " + msg[:200]
        return msg[:300]
