"""Projects: each has its own board; uploaded files live in the shared data/assets."""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import zipfile
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
ASSET_RE = re.compile(r"^[0-9a-f]{24}(\.[a-z0-9]{1,8})?$")
EMPTY = {"version": 1, "view": {"x": 0, "y": 0, "k": 1}, "items": []}


class ProjectError(Exception):
    def __init__(self, msg: str, code: int = 400):
        super().__init__(msg)
        self.code = code


def clean_name(name) -> str:
    name = re.sub(r"\s+", " ", str(name or "")).strip()[:80]
    return name or "Untitled"


class Projects:
    def __init__(self, data_dir: Path):
        self.dir = data_dir
        self.root = data_dir / "projects"
        self.trash = data_dir / "trash"
        self.assets = data_dir / "assets"
        self.tmp = data_dir / ".tmp"
        self.lock = threading.Lock()
        self._last_bak: dict[str, float] = {}
        for d in (self.root, self.trash, self.assets, self.tmp):
            d.mkdir(parents=True, exist_ok=True)
        self._migrate_legacy()

    def _migrate_legacy(self):
        old = self.dir / "board.json"
        if old.exists() and not any(self.root.iterdir()):
            pid = "main"
            d = self.root / pid
            d.mkdir()
            shutil.move(str(old), d / "board.json")
            bak = self.dir / "board.json.bak"
            if bak.exists():
                shutil.move(str(bak), d / "board.json.bak")
            self._write_meta(pid, {"name": "Main", "created": time.time()})

    def dir_of(self, pid: str) -> Path:
        if not ID_RE.match(pid or ""):
            raise ProjectError("bad project id", 400)
        d = self.root / pid
        if not d.is_dir():
            raise ProjectError("project not found", 404)
        return d

    def _meta(self, pid: str) -> dict:
        try:
            return json.loads((self.root / pid / "project.json").read_text("utf-8"))
        except Exception:
            return {}

    def _write_meta(self, pid: str, meta: dict):
        (self.root / pid / "project.json").write_text(json.dumps(meta, ensure_ascii=False), "utf-8")

    def _new_id(self) -> str:
        while True:
            pid = "p-" + secrets.token_hex(3)
            if not (self.root / pid).exists():
                return pid

    def list(self) -> list[dict]:
        out = []
        for d in self.root.iterdir():
            if not d.is_dir() or not ID_RE.match(d.name):
                continue
            meta = self._meta(d.name)
            b = d / "board.json"
            out.append({
                "id": d.name,
                "name": meta.get("name") or d.name,
                "created": meta.get("created", 0),
                "updated": b.stat().st_mtime if b.exists() else meta.get("created", 0),
            })
        out.sort(key=lambda p: -p["updated"])
        return out

    def create(self, name: str, board: bytes | None = None) -> dict:
        with self.lock:
            pid = self._new_id()
            d = self.root / pid
            d.mkdir()
            self._write_meta(pid, {"name": clean_name(name), "created": time.time()})
            (d / "board.json").write_bytes(board if board is not None else json.dumps(EMPTY).encode())
        return {"id": pid, "name": clean_name(name)}

    def rename(self, pid: str, name: str):
        self.dir_of(pid)
        meta = self._meta(pid)
        meta["name"] = clean_name(name)
        self._write_meta(pid, meta)

    def duplicate(self, pid: str, name: str | None = None) -> dict:
        self.dir_of(pid)
        meta = self._meta(pid)
        return self.create(name or (meta.get("name", "Project") + " (copy)"), self.read_board(pid))

    def delete(self, pid: str):
        d = self.dir_of(pid)
        with self.lock:
            shutil.move(str(d), self.trash / f"{pid}-{int(time.time())}")

    def read_board(self, pid: str) -> bytes:
        d = self.dir_of(pid)
        try:
            return (d / "board.json").read_bytes()
        except FileNotFoundError:
            return json.dumps(EMPTY).encode()

    def write_board(self, pid: str, raw: bytes):
        d = self.dir_of(pid)
        with self.lock:
            tmp = self.tmp / f"{pid}.new"
            tmp.write_bytes(raw)
            b = d / "board.json"
            if b.exists() and time.time() - self._last_bak.get(pid, 0) > 60:
                shutil.copyfile(b, d / "board.json.bak")
                self._last_bak[pid] = time.time()
            os.replace(tmp, b)
            self._auto_snapshot(pid, raw)

    ASSET_FIELDS = ("url", "thumb", "favicon", "archive")

    @classmethod
    def referenced_assets(cls, board: bytes) -> set[str]:
        try:
            items = json.loads(board).get("items", [])
        except Exception:
            return set()
        out = set()
        for it in items:
            if not isinstance(it, dict):
                continue
            for f in cls.ASSET_FIELDS:
                u = it.get(f)
                if isinstance(u, str) and u.startswith("/assets/") and ASSET_RE.match(u[8:]):
                    out.add(u[8:])
        return out

    def all_referenced(self) -> set[str]:
        used: set[str] = set()
        for p in self.list():
            used |= self.referenced_assets(self.read_board(p["id"]))
            # history snapshots hold files too: otherwise a rollback would bring back cards with "empty" links
            hd = self.root / p["id"] / "history"
            if hd.is_dir():
                for f in hd.glob("*.json"):
                    try:
                        used |= self.referenced_assets(f.read_bytes())
                    except OSError:
                        pass
        return used

    def unused_assets(self) -> dict:
        used = self.all_referenced()
        files = [f for f in self.assets.iterdir() if f.is_file()]
        total = sum(f.stat().st_size for f in files)
        unused = [{"name": f.name, "size": f.stat().st_size, "mtime": f.stat().st_mtime}
                  for f in files if f.name not in used and ASSET_RE.match(f.name)]
        unused.sort(key=lambda x: -x["size"])
        return {"files": len(files), "total": total, "unused": unused,
                "unused_size": sum(u["size"] for u in unused)}

    def delete_assets(self, names: list[str]) -> tuple[int, int]:
        used = self.all_referenced()
        n = size = 0
        for name in names:
            if not isinstance(name, str) or not ASSET_RE.match(name) or name in used:
                continue
            f = self.assets / name
            if f.is_file():
                size += f.stat().st_size
                f.unlink()
                n += 1
        return n, size

    def gc_assets(self, min_age: float = 3600) -> tuple[int, int]:
        used = self.all_referenced()
        n = size = 0
        for f in self.assets.iterdir():
            if f.is_file() and f.name not in used and time.time() - f.stat().st_mtime > min_age:
                size += f.stat().st_size
                f.unlink()
                n += 1
        return n, size

    SNAP_EVERY = 600
    _snap_cache: dict = {}

    def _hdir(self, pid: str) -> Path:
        d = self.dir_of(pid) / "history"
        d.mkdir(exist_ok=True)
        return d

    @staticmethod
    def _snap_ts(f: Path):
        m = re.fullmatch(r"(\d{9,11})(-m)?\.json", f.name)
        return (int(m.group(1)), bool(m.group(2))) if m else None

    def _auto_snapshot(self, pid: str, raw: bytes):
        hd = self._hdir(pid)
        snaps = sorted((f for f in hd.glob("*.json") if self._snap_ts(f)), key=lambda f: self._snap_ts(f)[0])
        now = int(time.time())
        last = snaps[-1] if snaps else None
        if last is not None:
            if now - self._snap_ts(last)[0] < self.SNAP_EVERY:
                return
            try:
                if last.read_bytes() == raw:
                    return
            except OSError:
                pass
        (hd / f"{now}.json").write_bytes(raw)
        self._prune(hd)

    def _prune(self, hd: Path):
        now = time.time()
        seen: set = set()
        for f in sorted(hd.glob("*.json"), key=lambda f: -(self._snap_ts(f) or (0,))[0]):
            ts = self._snap_ts(f)
            if not ts or ts[1]:
                continue
            age = now - ts[0]
            if age < 6 * 3600:
                continue
            bucket = ("h", ts[0] // 3600) if age < 7 * 86400 else ("d", ts[0] // 86400)
            if age > 90 * 86400 or bucket in seen:
                f.unlink(missing_ok=True)
            else:
                seen.add(bucket)

    def snapshot(self, pid: str, manual: bool = True) -> int:
        raw = self.read_board(pid)
        hd = self._hdir(pid)
        ts = int(time.time())
        (hd / f"{ts}{'-m' if manual else ''}.json").write_bytes(raw)
        return ts

    def history(self, pid: str) -> list[dict]:
        hd = self._hdir(pid)
        out = []
        for f in hd.glob("*.json"):
            ts = self._snap_ts(f)
            if not ts:
                continue
            cards = None
            try:
                items = json.loads(f.read_bytes()).get("items", [])
                cards = sum(1 for i in items if isinstance(i, dict) and i.get("kind") == "card")
            except Exception:
                pass
            out.append({"t": ts[0], "manual": ts[1], "size": f.stat().st_size, "cards": cards})
        out.sort(key=lambda x: -x["t"])
        return out

    def _find_snap(self, pid: str, t: int) -> Path:
        hd = self._hdir(pid)
        for name in (f"{t}.json", f"{t}-m.json"):
            if (hd / name).is_file():
                return hd / name
        raise ProjectError("snapshot not found", 404)

    def restore(self, pid: str, t: int):
        src = self._find_snap(pid, t)
        raw = src.read_bytes()
        self.snapshot(pid, manual=True)  # save the current state so the rollback can be undone
        d = self.dir_of(pid)
        with self.lock:
            tmp = self.tmp / f"{pid}.restore"
            tmp.write_bytes(raw)
            os.replace(tmp, d / "board.json")
            self._last_bak[pid] = time.time()

    def delete_snapshot(self, pid: str, t: int):
        self._find_snap(pid, t).unlink(missing_ok=True)

    def export_zip(self, pid: str) -> tuple[Path, str]:
        self.dir_of(pid)
        board = self.read_board(pid)
        name = self._meta(pid).get("name", pid)
        fd, tmp = tempfile.mkstemp(dir=self.tmp, suffix=".zip")
        os.close(fd)
        with zipfile.ZipFile(tmp, "w") as z:
            z.writestr("board.json", board, compress_type=zipfile.ZIP_DEFLATED)
            z.writestr("project.json", json.dumps({"name": name}, ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
            for a in sorted(self.referenced_assets(board)):
                f = self.assets / a
                if f.is_file():
                    z.write(f, "assets/" + a, compress_type=zipfile.ZIP_STORED)  # media is already compressed
        return Path(tmp), name

    def export_md_zip(self, name: str, md: str, assets: list[str]) -> bytes:
        import io
        buf = io.BytesIO()
        safe = re.sub(r'[\\/:*?"<>|]+', "_", clean_name(name))
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr(safe + ".md", md.encode("utf-8"), compress_type=zipfile.ZIP_DEFLATED)
            for a in dict.fromkeys(assets):
                if isinstance(a, str) and ASSET_RE.match(a) and (self.assets / a).is_file():
                    z.write(self.assets / a, "assets/" + a, compress_type=zipfile.ZIP_STORED)
        return buf.getvalue()

    def import_zip(self, path: Path, fallback_name: str) -> dict:
        try:
            z = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            raise ProjectError("this is not a project zip archive")
        with z:
            names = set(z.namelist())
            if "board.json" not in names:
                raise ProjectError("board.json is missing from the archive")
            board = z.read("board.json")
            try:
                obj = json.loads(board)
                assert isinstance(obj, dict) and isinstance(obj.get("items"), list)
            except Exception:
                raise ProjectError("board.json is corrupted")
            name = fallback_name
            if "project.json" in names:
                try:
                    name = json.loads(z.read("project.json")).get("name") or name
                except Exception:
                    pass
            for n in names:
                base = n[7:] if n.startswith("assets/") else None
                if base and ASSET_RE.match(base):
                    dest = self.assets / base
                    if not dest.exists():
                        tmp = self.tmp / f"imp-{secrets.token_hex(4)}"
                        with z.open(n) as src, open(tmp, "wb") as out:
                            shutil.copyfileobj(src, out)
                        os.replace(tmp, dest)
        return self.create(name, board)
