"""Model downloads: nothing is fetched from the internet until the user confirms it."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

WHISPER_REPOS = {
    "tiny": ("Systran/faster-whisper-tiny", "75 MB"),
    "base": ("Systran/faster-whisper-base", "145 MB"),
    "small": ("Systran/faster-whisper-small", "485 MB"),
    "medium": ("Systran/faster-whisper-medium", "1.5 GB"),
    "large-v3": ("Systran/faster-whisper-large-v3", "3.1 GB"),
    "turbo": ("mobiuslabsgmbh/faster-whisper-large-v3-turbo", "1.6 GB"),
}
REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,95}/[A-Za-z0-9][\w.-]{0,95}$")


class NeedConfirm(Exception):
    def __init__(self, info: dict):
        super().__init__("Download confirmation required")
        self.info = info


def hf_url(repo: str) -> str:
    return f"https://huggingface.co/{repo}"


def whisper_info(models_dir: Path, name: str) -> dict | None:
    if name not in WHISPER_REPOS:
        return None
    repo, size = WHISPER_REPOS[name]
    cached = Path(models_dir) / ("models--" + repo.replace("/", "--"))
    if any(cached.glob("snapshots/*/model.bin")):
        return None
    return {"what": f"Whisper model “{name}” (speech to text)", "source": "Hugging Face", "url": hf_url(repo),
            "repo": repo, "size": "about " + size, "dest": str(models_dir)}


def llama_cache_dir() -> Path:
    if os.environ.get("LLAMA_CACHE"):
        return Path(os.environ["LLAMA_CACHE"])
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "llama.cpp"
    if sys.platform == "darwin":
        return Path.home() / "Library/Caches/llama.cpp"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "llama.cpp"


def hf_cached(repo: str) -> bool:
    """Best effort: llama.cpp keeps -hf downloads either in its own cache or in the Hugging Face hub cache."""
    owner, name = repo.split("/")
    try:
        if any(llama_cache_dir().glob(f"{owner}_{name}_*")):
            return True
        hub = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface")) / "hub")
        return any((hub / f"models--{owner}--{name}").glob("snapshots/*/*"))
    except OSError:
        return False


def llama_info(spec: str, confirmed: list[str]) -> dict | None:
    """Download info for a llama-server -hf argument, or None if nothing will be downloaded."""
    spec = (spec or "").strip()
    if not spec or spec.lower().endswith(".gguf") or Path(spec).exists():
        return None
    repo = spec.split(":", 1)[0]
    if not REPO_RE.match(repo) or repo in confirmed or hf_cached(repo):
        return None
    return {"what": f"Vision model “{spec}” (text in images)", "source": "Hugging Face", "url": hf_url(repo), "repo": repo,
            "size": "size depends on the files in the repository, see the page", "dest": str(llama_cache_dir())}


def ollama_info(model: str) -> dict:
    return {"what": f"Ollama model “{model}” (text in images)", "source": "ollama.com", "url": "https://ollama.com/library/" + model.split(":")[0].split("/")[-1],
            "repo": model, "size": "size is shown on the model page", "dest": "Ollama's own model folder"}


def require(info: dict | None, body: dict):
    if info and not body.get("confirm"):
        raise NeedConfirm(info)
