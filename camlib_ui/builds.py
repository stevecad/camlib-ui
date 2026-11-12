"""Builds: each one in its own process (python -m camlib_ui.build), on a copy of the project's sources, one or two at a
time. A build's directory is <project>/.builds/<id>/: request.json, src/ (the sources), log.txt, result.json and the
files camlib released (gcode-<n>.nc) with the playback stream (cam-playback.bin).

Statuses: queued, running, done (result.json says whether the program built: ok, and per setup and machine whether
camlib released its G-code), failed (the build itself stopped: a timeout, a crash), cancelled.

A running build also says what it is doing (its stage, the operation camlib is planning and how far along):
progress.json, which the build process rewrites as it goes (camlib_ui/build/progress.py). It is given only while the
build runs ("progress" in its summary) and removed when the build ends: it is no part of the build's result.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .build.progress import clear_progress, read_progress
from .projects import HIDDEN, Projects

KEEP = 20            # builds kept per project (the newest)
LOG_TAIL = 20000


class Builds:
    def __init__(self, projects: Projects, *, timeout: int = 900, workers: int = 1):
        self.projects = projects
        self.timeout = timeout
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="build")
        self.lock = threading.Lock()
        self.running: dict[str, subprocess.Popen] = {}

    def recover(self):
        """At start: builds a previous server left queued or running never finish."""
        for project in self.projects.root.iterdir():
            directory = project / HIDDEN
            if not directory.is_dir():
                continue
            for path in directory.iterdir():
                if (path / "status.json").is_file() and self._status(path).get("status") in ("queued", "running"):
                    self._write_status(path, status="failed", error="The server stopped during the build.",
                                       finished=time.time())
                    clear_progress(path)

    def directory(self, project: str) -> Path:
        return self.projects.path(project) / HIDDEN

    def path(self, project: str, build: str) -> Path:
        if not (build.isalnum() and len(build) <= 40):
            raise KeyError(build)
        path = self.directory(project) / build
        if not (path / "status.json").is_file():
            raise KeyError(build)
        return path

    @staticmethod
    def _status(path: Path) -> dict:
        try:
            return json.loads((path / "status.json").read_text())
        except (OSError, ValueError):
            return {"status": "failed", "error": "The build's status can't be read."}

    @staticmethod
    def _write_status(path: Path, **fields):
        status = {**Builds._status(path), **fields} if (path / "status.json").is_file() else fields
        tmp = path / "status.json.tmp"
        tmp.write_text(json.dumps(status))
        tmp.replace(path / "status.json")

    def start(self, project: str, mode: str) -> dict:
        if mode not in ("preview", "full"):
            raise ValueError("A build is a preview or full.")
        build = time.strftime("%Y%m%d%H%M%S") + secrets.token_hex(3)
        path = self.directory(project) / build
        path.mkdir(parents=True)
        sources = self.projects.snapshot(project, path / "src")
        if not Path(sources["program"]).is_file():
            shutil.rmtree(path)
            raise ValueError("The project has no program.py.")
        (path / "request.json").write_text(json.dumps({"mode": mode, "timeout": self.timeout, **sources}))
        self._write_status(path, id=build, project=project, mode=mode, status="queued", created=time.time())
        self.pool.submit(self._run, project, build, path)
        self._prune(project)
        return self.summary(project, build)

    def _run(self, project: str, build: str, path: Path):
        if self._status(path).get("status") == "cancelled":
            return
        self._write_status(path, status="running", started=time.time())
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        with open(path / "stderr.txt", "wb") as stderr:
            process = subprocess.Popen([sys.executable, "-m", "camlib_ui.build", str(path / "request.json")],
                                       cwd=str(path), env=env, start_new_session=True, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=stderr)
        with self.lock:
            self.running[build] = process
        error = None
        try:
            process.wait(timeout=self.timeout + 30)
        except subprocess.TimeoutExpired:
            error = f"The build didn't finish in {self.timeout} s."
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)   # the build and everything it started
            except (ProcessLookupError, PermissionError):
                pass
            process.wait()
            with self.lock:
                self.running.pop(build, None)
            clear_progress(path)   # The build is over, however it ended (it removes its own when it ends by itself).
        if self._status(path).get("status") == "cancelled":
            return
        if error is None and not (path / "result.json").is_file():
            stderr = (path / "stderr.txt").read_bytes().decode(errors="replace")[-4000:]
            error = f"The build stopped (exit {process.returncode}) without a result.\n{stderr}".strip()
        self._write_status(path, status="failed" if error else "done", error=error, finished=time.time())

    def cancel(self, project: str, build: str) -> dict:
        path = self.path(project, build)
        if self._status(path).get("status") in ("queued", "running"):
            self._write_status(path, status="cancelled", finished=time.time())
            with self.lock:
                process = self.running.get(build)
            if process is not None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        return self.summary(project, build)

    def _prune(self, project: str):
        builds = sorted(p for p in self.directory(project).iterdir() if p.is_dir())
        for old in builds[:-KEEP]:
            if self._status(old).get("status") not in ("queued", "running"):
                shutil.rmtree(old, ignore_errors=True)

    def summary(self, project: str, build: str) -> dict:
        """The build's status; while it runs, what it is doing ("progress": camlib_ui.build.progress.read_progress); and
        when it is done, its outcome in a few words (released / refused counts)."""
        path = self.path(project, build)
        status = self._status(path)
        out = {k: status.get(k) for k in ("id", "mode", "status", "created", "started", "finished", "error")}
        if status.get("status") == "running":
            progress = read_progress(path)
            if progress is not None:
                out["progress"] = progress
        result = self._result(path)
        if result is not None:
            out["ok"] = bool(result.get("ok"))
            metadata = result.get("metadata") or {}
            programs = metadata.get("programs") or []
            out["released"] = sum(1 for p in programs if p.get("artifact"))
            out["refused"] = sum(1 for p in programs if p.get("refused"))
        return out

    @staticmethod
    def _result(path: Path) -> dict | None:
        try:
            return json.loads((path / "result.json").read_text())
        except (OSError, ValueError):
            return None

    def list(self, project: str) -> list[dict]:
        directory = self.directory(project)
        if not directory.is_dir():
            return []
        out = []
        for p in sorted(directory.iterdir(), reverse=True):
            if (p / "status.json").is_file():
                out.append(self.summary(project, p.name))
        return out

    def get(self, project: str, build: str) -> dict:
        """The build: its summary, its result (camlib's metadata, or the program's error) and its log's tail."""
        path = self.path(project, build)
        out = self.summary(project, build)
        result = self._result(path)
        if result is not None:
            out["metadata"] = result.get("metadata")
            out["program_error"] = None if result.get("ok") else result.get("error")
        log = path / "log.txt"
        out["log"] = log.read_bytes()[-LOG_TAIL:].decode(errors="replace") if log.is_file() else ""
        files = {}
        for name in ["cam-playback.bin", *[f"gcode-{n}.nc" for n in range(1, 33)]]:
            if (path / name).is_file():
                files[name] = f"/api/projects/{project}/builds/{build}/files/{name}"
        out["files"] = files
        return out

    def file(self, project: str, build: str, name: str) -> Path:
        path = self.path(project, build)
        if name != "cam-playback.bin" and not (name.startswith("gcode-") and name.endswith(".nc")
                                               and name[6:-3].isdigit()):
            raise KeyError(name)
        target = path / name
        if not target.is_file():
            raise KeyError(name)
        return target

    def source(self, project: str, build: str, name: str) -> Path:
        """A source file as the build used it (src/)."""
        path = self.path(project, build) / "src" / name
        if "/" in name or name.startswith(".") or not path.is_file():
            raise KeyError(name)
        return path
