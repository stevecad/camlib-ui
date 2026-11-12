"""A running build's progress: what the build is doing right now, for the interface to show while it waits.

The build process (camlib_ui/build/run.py) writes progress.json in the build's directory, replaced whole each time; the
server reads it for a running build (camlib_ui/builds.py) and removes it when the build ends. It is transient: nothing
of it goes into result.json, the G-code or the playback stream, and a build is the same with or without it.

What is published is what the build and camlib know, never an estimate:

  - the stage: "program" (the program's own code runs), "describe" (its data is checked and rebuilt), then for each
    setup on each machine "planning" (camlib plans the operations, posting and checking their moves as they come),
    "checking" (every operation is planned; camlib finishes posting and checking), "playback" (the playback stream is
    written), "release" (camlib decides what it releases), and last "files" (the build's files are checked);
  - the run: which setup on which machine, and its place among the build's runs (setups × machines);
  - its operations in order, each pending, planning or done. camlib's planning progress (camlib.simulation.
    ProgressUpdate, camlib #198) says which one is being planned and, where its planner counts something, a completed
    fraction with its basis ("layers", "passes", "area") and the levels or passes done of those planned. An operation
    camlib counts nothing for has no fraction, and none is made up. There is no figure for the whole build either.

With a camlib that has no planning progress, the stage and the operations camlib has finished are published, and no
operation is said to be the one being planned.
"""
from __future__ import annotations

import inspect
import json
import math
import os
import threading
import time
from pathlib import Path

FILE = "progress.json"
VERSION = 1
STAGES = ("program", "describe", "planning", "checking", "playback", "release", "files")
BASES = ("layers", "passes", "area")
STATES = ("pending", "planning", "done")
INTERVAL_S = 0.25           # how often camlib is asked for planning progress, and at most how often the file is rewritten
MAX_BYTES = 256 * 1024      # a progress file larger than this isn't read
MAX_OPERATIONS = 256        # as a setup's operations (camlib_ui/build/run.py)
# Don't ask camlib for planning progress (as with a camlib that has none): CAMLIB_UI_ENGINE_PROGRESS=0.
SWITCH = "CAMLIB_UI_ENGINE_PROGRESS"


def engine_reports_progress(run_operations=None) -> bool:
    """Whether this camlib reports planning progress: its Simulation.run_operations takes progress_interval_s (#198)."""
    if os.environ.get(SWITCH, "1").strip().lower() in ("0", "no", "off", "false"):
        return False
    try:
        if run_operations is None:
            from camlib.simulation import Simulation
            run_operations = Simulation.run_operations
        return "progress_interval_s" in inspect.signature(run_operations).parameters
    except (ImportError, AttributeError, TypeError, ValueError):
        return False


class Progress:
    """Publishes a build's progress to `directory`/progress.json (None: nowhere). Its methods never raise: a build
    doesn't fail because its progress couldn't be written. camlib calls on_progress and on_operation on the thread that
    produces the run while the build's own thread sets the stages, so every change is made under one lock."""

    def __init__(self, directory, *, interval_s=INTERVAL_S, clock=time.time):
        self.path = None if directory is None else Path(directory) / FILE
        self.interval_s, self.clock = interval_s, clock
        self.lock = threading.Lock()
        self.state = dict(version=VERSION, stage=None, stage_started=None, run=None)
        self.written = -math.inf
        self.begun = {}
        self.engine = False   # camlib is asked for planning progress in the run begun (begin_run)

    # ---- what the build says

    def stage(self, name):
        with self.lock:
            self._stage(name)
            self._write()

    def begin_run(self, setup, machine, index, count, operations, *, engine=None):
        """A setup about to be planned for a machine: run `index` (0-based) of the build's `count`; `operations` are the
        setup's (id, kind) in order; `engine`: camlib reports planning progress for it (None: as this camlib does)."""
        if engine is None:
            engine = self.path is not None and engine_reports_progress()
        with self.lock:
            self.begun, self.engine = {}, bool(engine)
            self.state["run"] = dict(setup=setup, machine=machine, index=index, count=count, engine_progress=bool(engine),
                                     operations=[dict(id=op, kind=kind, state="pending") for op, kind in operations])
            self._stage("planning")
            self._write()

    def on_progress(self, update):
        """camlib's planning progress (camlib.simulation.ProgressUpdate): the operation being planned and how far."""
        try:
            with self.lock:
                item = self._operation(update.index, update.operation)
                if item is None or item["state"] == "done":
                    return
                changed = item["state"] != "planning"
                if changed:
                    item.update(state="planning", started=self.clock())
                # camlib's own figures, as given: a fraction only with its basis.
                basis = update.basis if update.basis in BASES else None
                item.update(basis=basis, fraction=update.fraction if basis else None, done=update.done, total=update.total)
                if changed or self.clock() - self.written >= self.interval_s:
                    self._write()
        except Exception:  # noqa: BLE001  Progress never stops a build.
            pass

    def on_operation(self, update):
        """camlib's operation control (camlib.simulation.OperationUpdate): an operation's end marks it done, with the
        moves camlib planned for it and, when camlib said when its planning began, how long it took."""
        try:
            with self.lock:
                run = self.state["run"]
                if run is None:
                    return
                index = next((i for i, op in enumerate(run["operations"]) if op["id"] == update.operation), None)
                if index is None:
                    return
                item = run["operations"][index]
                if update.stage == "begin":
                    self.begun[index] = update.completed
                elif update.stage == "end" and item["state"] != "done":
                    now = self.clock()
                    started = item.pop("started", None)
                    for key in ("basis", "fraction", "done", "total"):
                        item.pop(key, None)
                    item["state"] = "done"
                    if started is not None:
                        item["seconds"] = round(max(0.0, now - started), 3)
                    if index in self.begun and isinstance(update.completed, int):
                        item["moves"] = max(0, update.completed - self.begun[index])
                    if all(op["state"] == "done" for op in run["operations"]):
                        self._stage("checking")
                    self._write()
        except Exception:  # noqa: BLE001
            pass

    def close(self):
        """The build is over: its progress is gone."""
        with self.lock:
            path, self.path = self.path, None
        if path is not None:
            for name in (path, path.with_name(FILE + ".tmp")):
                try:
                    name.unlink()
                except OSError:
                    pass

    # ---- inside (the lock held)

    def _stage(self, name):
        if self.state["stage"] != name:
            self.state.update(stage=name, stage_started=self.clock())

    def _operation(self, index, operation):
        run = self.state["run"]
        if run is None or not isinstance(index, int) or not 0 <= index < len(run["operations"]):
            return None
        item = run["operations"][index]
        return item if item["id"] == operation else None

    def _write(self):
        if self.path is None:
            return
        try:
            self.written = self.clock()
            text = json.dumps({**self.state, "updated": self.written}, allow_nan=False, separators=(",", ":"))
            tmp = self.path.with_name(FILE + ".tmp")
            tmp.write_text(text)
            os.replace(tmp, self.path)
        except (OSError, ValueError, TypeError):
            pass


# ---------------------------------------------------------------------------------------------- the server's side

def _text(value, limit=128):
    return value[:limit] if isinstance(value, str) else None


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**53 else None


def _seconds(value):
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    return round(min(max(float(value), 0.0), 1e7), 1) if ok else None


def read_progress(directory, now=None) -> dict | None:
    """A running build's progress as the API gives it, or None (none written, or not readable). The file is a build
    process's: it is read as data, its shape checked and only the known fields kept. Times become seconds elapsed.

        {"stage", "stage_seconds", "run": {"setup", "machine", "index", "count", "engine_progress", "operations": [
            {"id", "kind", "state": "pending" | "planning" | "done", "seconds", "moves", "basis", "fraction", "done",
             "total"}]} | None}

    An operation's "fraction" (0 to 1) is there only with its "basis", as camlib counted it; "seconds" is how long a
    planning operation has been planned for so far, or how long a done one took.
    """
    path = Path(directory) / FILE
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
            return None
        data = json.loads(path.read_bytes())
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(data, dict) or data.get("version") != VERSION or data.get("stage") not in STAGES:
        return None
    now = time.time() if now is None else now
    since = lambda started: _seconds(now - started) if _seconds(started) is not None else None
    out = dict(stage=data["stage"], stage_seconds=since(data.get("stage_started")), run=None)
    run = data.get("run")
    if isinstance(run, dict) and isinstance(run.get("operations"), list):
        operations = []
        for item in run["operations"][:MAX_OPERATIONS]:
            if not isinstance(item, dict) or _text(item.get("id")) is None or item.get("state") not in STATES:
                return None
            state = item["state"]
            op = dict(id=_text(item["id"]), kind=_text(item.get("kind")), state=state, seconds=None, moves=None, basis=None,
                      fraction=None, done=None, total=None)
            if state == "planning":
                op["seconds"] = since(item.get("started"))
                fraction = item.get("fraction")
                if (item.get("basis") in BASES and isinstance(fraction, (int, float)) and not isinstance(fraction, bool)
                        and 0 <= fraction <= 1):
                    op.update(basis=item["basis"], fraction=float(fraction), done=_count(item.get("done")),
                              total=_count(item.get("total")))
            elif state == "done":
                op.update(seconds=_seconds(item.get("seconds")), moves=_count(item.get("moves")))
            operations.append(op)
        out["run"] = dict(setup=_text(run.get("setup")), machine=_text(run.get("machine")), index=_count(run.get("index")),
                          count=_count(run.get("count")), engine_progress=run.get("engine_progress") is True,
                          operations=operations)
    return out


def clear_progress(directory):
    """Removes a build's progress file (the build ended, however it did)."""
    for name in (FILE, FILE + ".tmp"):
        try:
            (Path(directory) / name).unlink()
        except OSError:
            pass
