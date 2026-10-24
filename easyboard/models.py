"""Models in memory: faster-whisper in-process and a vision model via llama.cpp or Ollama."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from . import llama as llamamod
from . import transcribe
from . import ocr as ocrmod

DEFAULTS = {"whisper_idle": 10, "vl_idle": 10, "vl_model": "glm-ocr", "vl_engine": "llama", "llama_bin": "llama-server",
            "llama_model": "", "llama_mmproj": "", "llama_args": llamamod.DEFAULT_ARGS, "ack": {}}
IDLE_CHOICES = (-1, 0, 2, 5, 10, 30, 60)  # minutes; 0 = never unload automatically, -1 = right after each job


class Settings:
    def __init__(self, path: Path):
        self.path = path
        self.data = {**DEFAULTS, "ack": {}}
        try:
            self.data.update({k: v for k, v in json.loads(path.read_text("utf-8")).items() if k in DEFAULTS})
        except Exception:
            pass
        ack = self.data["ack"]
        self.data["ack"] = {k: True for k in ("run", "download") if isinstance(ack, dict) and ack.get(k) is True}

    def acknowledged(self, kind: str) -> bool:
        return bool(self.data["ack"].get(kind))

    def acknowledge(self, kind: str):
        """Remembers (also across restarts) that the user has seen and accepted a one-time notice."""
        if kind in ("run", "download") and not self.data["ack"].get(kind):
            self.data["ack"] = {**self.data["ack"], kind: True}
            self.path.write_text(json.dumps(self.data, ensure_ascii=False), "utf-8")

    def update(self, patch: dict):
        for k in ("whisper_idle", "vl_idle"):
            if k in patch and int(patch[k]) in IDLE_CHOICES:
                self.data[k] = int(patch[k])
        if "vl_model" in patch and ocrmod.MODEL_RE.match(str(patch["vl_model"])):
            self.data["vl_model"] = str(patch["vl_model"])
        if patch.get("vl_engine") in ("llama", "ollama"):
            self.data["vl_engine"] = patch["vl_engine"]
        for k in ("llama_bin", "llama_model", "llama_mmproj", "llama_args"):
            if k in patch and isinstance(patch[k], str) and len(patch[k]) < 1000 and "\n" not in patch[k] and "\0" not in patch[k]:
                v = patch[k].strip().strip('"')
                if k == "llama_args" and not v:
                    v = llamamod.DEFAULT_ARGS
                if k == "llama_bin" and not v:
                    v = "llama-server"
                if k == "llama_bin" and not llamamod.BIN_RE.match(Path(v).name):
                    raise ValueError("The executable must be named llama-server (llama-server.exe)")
                self.data[k] = v
        self.path.write_text(json.dumps(self.data, ensure_ascii=False), "utf-8")


class Models:
    def __init__(self, settings: Settings, whisper_backend, trans, ocr: ocrmod.OcrService, whisper_ok, llama=None):
        self.s = settings
        self.wb = whisper_backend
        self.trans = trans
        self.ocr = ocr
        self.llama = llama
        self.whisper_ok = whisper_ok
        self.w_pinned = False
        self.vl_pinned = False
        self.w_loading = False
        self.w_error = ""
        self.vl_error = ""
        threading.Thread(target=self._idle_loop, daemon=True).start()

    def engine(self) -> str:
        return self.s.data["vl_engine"] if self.llama else "ollama"

    def vl_label(self) -> str:
        return (self.llama.label() or "llama.cpp") if self.engine() == "llama" else self.s.data["vl_model"]

    def vl_keep(self):
        if self.vl_pinned or self.s.data["vl_idle"] == 0:
            return -1
        if self.s.data["vl_idle"] < 0:
            return 0
        return f"{self.s.data['vl_idle']}m"

    def status(self) -> dict:
        wst = self.wb.status() if hasattr(self.wb, "status") else {"loaded": False}
        w = {
            "available": bool(self.whisper_ok()), "loaded": bool(wst.get("loaded")), "model": wst.get("model"),
            "device": wst.get("device"), "loading": self.w_loading or bool(wst.get("loading")),
            "busy": self.trans.busy(), "pinned": self.w_pinned and bool(wst.get("loaded")),
            "idle": self.s.data["whisper_idle"], "error": self.w_error,
            "models": list(transcribe.MODELS),
        }
        if self.engine() == "llama":
            return {"whisper": w, "vl": self._llama_status(), "settings": dict(self.s.data), "idle_choices": list(IDLE_CHOICES)}
        c = self.ocr.client
        v = {"engine": "ollama", "reachable": False, "host": c.base, "model": self.s.data["vl_model"], "installed": False, "loaded": False,
             "pinned": False, "vram": 0, "size": 0, "busy": self.ocr.busy(), "idle": self.s.data["vl_idle"],
             "error": self.vl_error, "version": None, "suggested": [{"name": n, "title": t} for n, t in ocrmod.SUGGESTED],
             "installed_models": [], "pull": None}
        ver = c.version()
        if ver:
            v["reachable"], v["version"] = True, ver
            try:
                tags = c.tags()
                v["installed_models"] = [t["name"] for t in tags]
                want = ocrmod.norm(v["model"])
                v["installed"] = any(ocrmod.norm(t["name"]) == want for t in tags)
                for m in c.ps():
                    if ocrmod.norm(m["name"]) == want:
                        v["loaded"], v["vram"], v["size"] = True, m["vram"], m["size"]
            except ocrmod.OllamaError as e:
                v["error"] = str(e)
            v["pinned"] = self.vl_pinned and v["loaded"]
            if not v["loaded"]:
                self.vl_pinned = False
        pj = self.ocr.pull_job
        if pj:
            v["pull"] = {"model": pj.model, "status": pj.status, "total": pj.total, "completed": pj.completed,
                         "error": pj.error, "done": pj.done}
        return {"whisper": w, "vl": v, "settings": dict(self.s.data), "idle_choices": list(IDLE_CHOICES)}

    def _llama_status(self) -> dict:
        st = self.llama.status()
        st.update({"busy": self.ocr.busy(), "idle": self.s.data["vl_idle"], "pinned": self.vl_pinned and st["loaded"],
                   "error": st["error"] or self.vl_error})
        if not st["loaded"] and not st["loading"]:
            self.vl_pinned = False
        return st

    def whisper(self, action: str, model: str | None):
        if action == "load":
            if self.w_loading:
                return
            self.w_error = ""
            self.w_loading = True

            def run():
                try:
                    self.wb.load(model or "small")
                    self.w_pinned = True
                except Exception as e:
                    self.w_error = self.trans._explain(e)
                finally:
                    self.w_loading = False

            threading.Thread(target=run, daemon=True).start()
        elif action == "unload":
            if self.trans.busy():
                raise ValueError("Transcription in progress — wait for it to finish or cancel it")
            self.w_pinned = False
            self.wb.unload()
        else:
            raise ValueError("unknown action")

    def vl(self, action: str, model: str | None):
        if self.engine() == "llama":
            return self._vl_llama(action)
        c = self.ocr.client
        if model:
            self.s.update({"vl_model": model})
        name = self.s.data["vl_model"]
        self.vl_error = ""
        if action == "load":
            def run():
                try:
                    c.keep(name, -1)
                    self.vl_pinned = True
                except Exception as e:
                    self.vl_error = ocrmod.OcrService._explain(e)

            threading.Thread(target=run, daemon=True).start()
        elif action == "unload":
            if self.ocr.busy():
                raise ValueError("Recognition in progress — wait for it to finish or cancel it")
            self.vl_pinned = False
            try:
                for m in c.ps():
                    c.keep(m["name"], 0) if ocrmod.norm(m["name"]) == ocrmod.norm(name) else None
            except ocrmod.OllamaError as e:
                self.vl_error = str(e)
        elif action == "pull":
            self.ocr.start_pull(name)
        elif action == "cancelpull":
            self.ocr.cancel_pull()
        else:
            raise ValueError("unknown action")

    def _vl_llama(self, action: str):
        e = self.llama
        self.vl_error = ""
        if action == "load":
            try:
                e.start()
            except llamamod.LlamaError as ex:
                raise ValueError(str(ex)) from None
            self.vl_pinned = True
        elif action == "unload":
            if self.ocr.busy():
                raise ValueError("Recognition in progress — wait for it to finish or cancel it")
            self.vl_pinned = False
            e.stop()
        else:
            raise ValueError("unknown action")

    def _idle_loop(self):
        while True:
            time.sleep(2)
            try:
                idle = self.s.data["whisper_idle"]
                if (idle and not self.w_pinned and not self.w_loading and not self.trans.busy()
                        and hasattr(self.wb, "status") and self.wb.status().get("loaded")
                        and time.time() - getattr(self.wb, "last_used", time.time()) > max(idle, 0) * 60 + 1):
                    self.wb.unload()
            except Exception:
                pass
            try:
                idle = self.s.data["vl_idle"]
                e = self.llama
                if (e and idle and not self.vl_pinned and e.alive() and e.ready and not self.ocr.busy()
                        and time.time() - e.last_used > max(idle, 0) * 60 + 1):
                    e.stop()
            except Exception:
                pass
