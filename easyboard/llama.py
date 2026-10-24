"""Recognition engine on llama.cpp: runs llama-server on demand and stops it to free memory."""
from __future__ import annotations

import base64
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path


class LlamaError(Exception):
    pass


class Cancelled(Exception):
    pass


BIN_RE = re.compile(r"^llama-server(\.exe)?$", re.I)
DEFAULT_ARGS = "-c 12000 -ngl 99 --flash-attn off"
PROMPT_GENERIC = ("Read all the text in this image and output it exactly as written, keeping line breaks and the original "
                  "languages (Russian and English). Output only the text, nothing else.")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LlamaEngine:
    name = "llama"

    def __init__(self, settings, log_path: Path):
        self.s = settings
        self.log_path = log_path
        self.lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.port = 0
        self.ready = False
        self.starting = False
        self.error = ""
        self.last_used = time.time()
        self.tail: deque[str] = deque(maxlen=25)
        self._gen = 0  # launch counter: an old wait thread must not touch the state of a new launch

    def cfg(self) -> dict:
        d = self.s.data
        return {"bin": d.get("llama_bin") or "llama-server", "model": (d.get("llama_model") or "").strip(),
                "mmproj": (d.get("llama_mmproj") or "").strip(), "args": d.get("llama_args") or DEFAULT_ARGS}

    def label(self) -> str:
        m = self.cfg()["model"]
        return Path(m).name if m and (m.lower().endswith(".gguf") or os.sep in m or "/" not in m) else m

    def _binary(self) -> str:
        b = self.cfg()["bin"]
        if not BIN_RE.match(Path(b).name):
            raise LlamaError("The executable must be named llama-server (llama-server.exe)")
        found = shutil.which(b) if os.sep not in b and "/" not in b else (b if Path(b).is_file() else None)
        if not found:
            raise LlamaError(f"llama-server not found: \"{b}\". Enter the full path to llama-server.exe in the models panel.")
        return found

    def _command(self, port=None) -> list[str]:
        c = self.cfg()
        if not c["model"]:
            raise LlamaError("No model specified: a path to a .gguf file or a Hugging Face repository (e.g. ggml-org/GLM-OCR-GGUF).")
        cmd = [self._binary()]
        if c["model"].lower().endswith(".gguf") or Path(c["model"]).exists():
            if not Path(c["model"]).is_file():
                raise LlamaError(f"Model file not found: {c['model']}")
            cmd += ["-m", c["model"]]
            if c["mmproj"]:
                if not Path(c["mmproj"]).is_file():
                    raise LlamaError(f"mmproj file not found: {c['mmproj']}")
                cmd += ["--mmproj", c["mmproj"]]
        else:
            cmd += ["-hf", c["model"]]
        try:
            cmd += shlex.split(c["args"], posix=(os.name != "nt"))
        except ValueError:
            raise LlamaError("Could not parse the extra arguments") from None
        return cmd + ["--host", "127.0.0.1", "--port", str(port or self.port)]  # our values come last and win

    def preview(self) -> tuple[str, str]:
        """(program path, full command line) as it would be started; raises LlamaError if it cannot be."""
        cmd = self._command(port="<free port>")
        return cmd[0], subprocess.list2cmdline(cmd)

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        with self.lock:
            if self.alive():
                return
            self.error = ""
            self.ready = False
            self.port = free_port()
            cmd = self._command()
            self.tail.clear()
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            try:
                self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                             creationflags=flags, text=True, encoding="utf-8", errors="replace")
            except OSError as e:
                raise LlamaError(f"Could not start llama-server: {e}") from None
            self.starting = True
            self._gen += 1
            gen = self._gen
            proc = self.proc
            threading.Thread(target=self._pump, args=(proc,), daemon=True).start()
            threading.Thread(target=self._wait_ready, args=(gen, proc), daemon=True).start()

    def _pump(self, proc):
        try:
            with open(self.log_path, "w", encoding="utf-8") as log:
                for line in proc.stdout:
                    self.tail.append(line.rstrip())
                    log.write(line)
                    log.flush()
        except Exception:
            pass

    def _health(self) -> bool:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2) as r:
                return r.status == 200
        except Exception:
            return False

    def _wait_ready(self, gen, proc):
        deadline = time.time() + 1800  # the first launch with -hf may take long downloading the model
        while time.time() < deadline and gen == self._gen:
            if proc.poll() is not None:
                if gen == self._gen:
                    self.error = "llama-server exited during startup: " + (" | ".join(list(self.tail)[-4:])[:400] or f"code {proc.returncode}")
                    self.starting = False
                return
            if self._health():
                if gen == self._gen:
                    self.ready, self.starting = True, False
                    self.last_used = time.time()
                return
            time.sleep(0.7)
        if gen == self._gen:
            self.error = "llama-server did not finish loading the model within 30 minutes"
            self.starting = False

    def stop(self):
        with self.lock:
            self._gen += 1
            p, self.proc = self.proc, None
            self.ready = self.starting = False
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(5)

    def vram(self) -> int:
        if not self.alive() or not shutil.which("nvidia-smi"):
            return 0
        try:
            out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=3).stdout
            for line in out.splitlines():
                pid, _, mem = line.partition(",")
                if pid.strip() == str(self.proc.pid):
                    return int(float(mem.strip())) * 1024 * 1024
        except Exception:
            pass
        return 0

    def status(self) -> dict:
        c = self.cfg()
        binary_ok, binary_err = True, ""
        try:
            self._binary()
        except LlamaError as e:
            binary_ok, binary_err = False, str(e)
        problem = None  # what prevents switching it on: {"field": which input, "text": message}
        if not binary_ok:
            problem = {"field": "bin", "text": binary_err}
        elif not c["model"]:
            problem = {"field": "model", "text": "Model is not set: enter a .gguf file path or a Hugging Face repository (for example ggml-org/GLM-OCR-GGUF)."}
        elif (c["model"].lower().endswith(".gguf") or Path(c["model"]).exists()) and not Path(c["model"]).is_file():
            problem = {"field": "model", "text": f"Model file not found: {c['model']}"}
        elif c["mmproj"] and not Path(c["mmproj"]).is_file():
            problem = {"field": "mmproj", "text": f"mmproj file not found: {c['mmproj']}"}
        return {"problem": problem, "engine": "llama", "binary_ok": binary_ok, "binary_error": binary_err, "model": c["model"], "mmproj": c["mmproj"],
                "args": c["args"], "bin": c["bin"], "configured": bool(c["model"]), "loaded": self.alive() and self.ready,
                "loading": self.alive() and self.starting, "pid": self.proc.pid if self.alive() else None,
                "vram": self.vram() if self.alive() and self.ready else 0, "error": self.error,
                "log": list(self.tail)[-6:] if self.error else []}

    def wait_ready(self, job):
        self.start()
        while True:
            if job.cancel:
                raise Cancelled()
            if self.ready:
                return
            if self.error and not self.starting:
                raise LlamaError(self.error)
            if not self.alive() and not self.starting:
                raise LlamaError(self.error or "llama-server is not running")
            time.sleep(0.3)

    def run(self, job, data: bytes, ext: str):
        self.wait_ready(job)
        job.status = "running"
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(ext, "image/png")
        prompt = "Text Recognition:" if "glm-ocr" in (self.cfg()["model"] or "").lower() else PROMPT_GENERIC
        body = {"stream": True, "temperature": 0, "max_tokens": 4096, "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}},
        ]}]}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            r = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            raise LlamaError(f"llama-server responded {e.code}: {msg}") from None
        except OSError as e:
            raise LlamaError(f"cannot reach llama-server: {e}") from None
        try:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                d = json.loads(payload)
                if d.get("error"):
                    raise LlamaError(str((d["error"] or {}).get("message") or d["error"])[:300])
                piece = ((d.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
                if piece:
                    yield piece
        finally:
            r.close()
            self.last_used = time.time()
