"""A running build's progress (camlib_ui/build/progress.py): what the build process publishes, what the API gives while
the build runs, that it is gone once the build ends, the build with a camlib that reports no planning progress, and
that a build's files are the same with and without it."""
from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest

from camlib_ui.build import progress as progress_module
from camlib_ui.build.progress import FILE, Progress, SWITCH, engine_reports_progress, read_progress

from conftest import HIDDEN_BUILDS, watch


def planning(index, operation, basis=None, fraction=None, done=None, total=None):
    """camlib's ProgressUpdate, the fields the build reads."""
    return SimpleNamespace(operation=operation, index=index, operations=3, basis=basis, done=done, total=total,
                           fraction=fraction)


def control(operation, stage, completed):
    """camlib's OperationUpdate, the fields the build reads."""
    return SimpleNamespace(operation=operation, stage=stage, completed=completed, report=None)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


# ---------------------------------------------------------------------------------------------- the engine's API

def test_an_engine_with_planning_progress_is_detected(monkeypatch):
    monkeypatch.delenv(SWITCH, raising=False)

    def with_progress(self, *, progress_interval_s=None): ...
    def without(self): ...
    assert engine_reports_progress(with_progress) is True
    assert engine_reports_progress(without) is False
    assert engine_reports_progress(object()) is False   # nothing to inspect: no progress, no error
    monkeypatch.setenv(SWITCH, "0")
    assert engine_reports_progress(with_progress) is False


# ---------------------------------------------------------------------------------------------- what is published

def test_what_a_run_publishes(tmp_path):
    clock = Clock()
    progress = Progress(tmp_path, clock=clock)
    assert read_progress(tmp_path) is None
    progress.stage("program")
    clock.now += 2
    assert read_progress(tmp_path, now=clock.now) == {"stage": "program", "stage_seconds": 2.0, "run": None}

    progress.begin_run("top", "mill", 0, 2, [("pocket", "adaptive_pocket"), ("holes", "drilling"), ("outline", None)],
                       engine=True)
    assert progress.engine is True
    run = read_progress(tmp_path, now=clock.now)["run"]
    assert (run["setup"], run["machine"], run["index"], run["count"], run["engine_progress"]) == ("top", "mill", 0, 2, True)
    assert [(op["id"], op["kind"], op["state"]) for op in run["operations"]] == [
        ("pocket", "adaptive_pocket", "pending"), ("holes", "drilling", "pending"), ("outline", None, "pending")]

    # The first update of an operation has no fraction: it is being planned, and nothing is counted yet.
    progress.on_progress(planning(0, "pocket"))
    clock.now += 1.5
    pocket = read_progress(tmp_path, now=clock.now)["run"]["operations"][0]
    assert pocket == {"id": "pocket", "kind": "adaptive_pocket", "state": "planning", "seconds": 1.5, "moves": None,
                      "basis": None, "fraction": None, "done": None, "total": None}
    progress.on_progress(planning(0, "pocket", "area", 0.42, 1, 3))
    pocket = read_progress(tmp_path, now=clock.now)["run"]["operations"][0]
    assert (pocket["basis"], pocket["fraction"], pocket["done"], pocket["total"]) == ("area", 0.42, 1, 3)

    # Its end: done, with its time and the moves camlib planned for it; its fraction is gone.
    progress.on_operation(control("pocket", "begin", 0))
    clock.now += 2.5
    progress.on_operation(control("pocket", "end", 120))
    state = read_progress(tmp_path, now=clock.now)
    assert state["stage"] == "planning"
    assert state["run"]["operations"][0] == {"id": "pocket", "kind": "adaptive_pocket", "state": "done", "seconds": 4.0,
                                             "moves": 120, "basis": None, "fraction": None, "done": None, "total": None}

    # An operation camlib counts nothing for: planning, with no fraction made up for it.
    progress.on_progress(planning(1, "holes"))
    holes = read_progress(tmp_path, now=clock.now)["run"]["operations"][1]
    assert holes["state"] == "planning" and holes["fraction"] is None and holes["basis"] is None
    # An update for another operation than the one at that place is ignored.
    progress.on_progress(planning(2, "holes", "layers", 0.5, 1, 2))
    assert read_progress(tmp_path, now=clock.now)["run"]["operations"][2]["state"] == "pending"
    progress.on_operation(control("holes", "begin", 120))
    progress.on_operation(control("holes", "end", 150))
    progress.on_progress(planning(2, "outline", "layers", 1.0, 2, 2))
    progress.on_operation(control("outline", "begin", 150))
    progress.on_operation(control("outline", "end", 180))
    state = read_progress(tmp_path, now=clock.now)
    # Every operation planned: camlib finishes posting and checking.
    assert state["stage"] == "checking"
    assert [(op["state"], op["moves"]) for op in state["run"]["operations"]] == [("done", 120), ("done", 30), ("done", 30)]

    progress.stage("release")
    assert read_progress(tmp_path, now=clock.now)["stage"] == "release"
    progress.close()
    assert read_progress(tmp_path) is None and list(tmp_path.iterdir()) == []
    progress.stage("files")   # after its end nothing is written
    assert list(tmp_path.iterdir()) == []


def test_frequent_updates_are_written_at_most_every_interval(tmp_path):
    clock = Clock()
    progress = Progress(tmp_path, interval_s=0.25, clock=clock)
    progress.begin_run("top", "mill", 0, 1, [("pocket", "pocket")], engine=True)
    progress.on_progress(planning(0, "pocket", "layers", 0.1, 1, 10))
    progress.on_progress(planning(0, "pocket", "layers", 0.2, 2, 10))   # the same instant: kept, not written
    assert read_progress(tmp_path, now=clock.now)["run"]["operations"][0]["fraction"] == 0.1
    clock.now += 0.3
    progress.on_progress(planning(0, "pocket", "layers", 0.3, 3, 10))
    assert read_progress(tmp_path, now=clock.now)["run"]["operations"][0]["fraction"] == 0.3


def test_without_engine_progress_only_what_is_done_is_said(tmp_path):
    progress = Progress(tmp_path)
    progress.begin_run("top", "mill", 0, 1, [("face", "facing"), ("pocket", "pocket")], engine=False)
    assert progress.engine is False
    progress.on_operation(control("face", "begin", 0))
    run = read_progress(tmp_path)["run"]
    assert run["engine_progress"] is False and [op["state"] for op in run["operations"]] == ["pending", "pending"]
    progress.on_operation(control("face", "end", 40))
    face, pocket = read_progress(tmp_path)["run"]["operations"]
    # Done, with its moves; no time: camlib didn't say when its planning began.
    assert (face["state"], face["moves"], face["seconds"]) == ("done", 40, None) and pocket["state"] == "pending"


def test_progress_never_stops_a_build(tmp_path):
    progress = Progress(tmp_path / "missing")   # nowhere to write
    progress.stage("program")
    progress.begin_run("top", "mill", 0, 1, [("face", "facing")], engine=True)
    progress.on_progress(object())
    progress.on_operation(object())
    progress.close()
    nowhere = Progress(None)
    nowhere.stage("program")
    nowhere.begin_run("top", "mill", 0, 1, [("face", "facing")])
    assert nowhere.engine is False


def test_a_progress_file_is_read_as_data(tmp_path):
    path = tmp_path / FILE
    for text in ("", "[]", "{", '{"version": 1, "stage": "coffee"}', '{"version": 2, "stage": "program"}',
                 '{"version": 1, "stage": "planning", "run": {"operations": [{"id": 3, "state": "done"}]}}',
                 '{"version": 1, "stage": "planning", "run": {"operations": [{"id": "a", "state": "soon"}]}}'):
        path.write_text(text)
        assert read_progress(tmp_path) is None, text
    # Only known fields are kept, and a fraction only as camlib could have given it: with a basis, from 0 to 1.
    path.write_text(json.dumps({"version": 1, "stage": "planning", "stage_started": "x", "extra": 1, "run": {
        "setup": "top", "machine": "mill", "index": 0, "count": 1, "engine_progress": 1, "note": "x", "operations": [
            {"id": "a", "state": "planning", "started": 10, "basis": "guess", "fraction": 0.5, "html": "<b>"},
            {"id": "b", "state": "planning", "basis": "layers", "fraction": 1.5},
            {"id": "c", "state": "planning", "basis": "layers", "fraction": 0.5, "done": 1, "total": 2},
            {"id": "d", "state": "done", "seconds": "long", "moves": -4}]}}))
    state = read_progress(tmp_path, now=12)
    assert set(state) == {"stage", "stage_seconds", "run"} and state["stage_seconds"] is None
    assert set(state["run"]) == {"setup", "machine", "index", "count", "engine_progress", "operations"}
    assert state["run"]["engine_progress"] is False
    a, b, c, d = state["run"]["operations"]
    assert all(set(op) == {"id", "kind", "state", "seconds", "moves", "basis", "fraction", "done", "total"} for op in (a, b, c, d))
    assert (a["seconds"], a["basis"], a["fraction"]) == (2.0, None, None)
    assert (b["basis"], b["fraction"]) == (None, None)
    assert (c["basis"], c["fraction"], c["done"], c["total"]) == ("layers", 0.5, 1, 2)
    assert (d["seconds"], d["moves"]) == (None, None)
    path.unlink()
    path.symlink_to(tmp_path / "elsewhere.json")
    (tmp_path / "elsewhere.json").write_text('{"version": 1, "stage": "program"}')
    assert read_progress(tmp_path) is None
    path.unlink()
    path.write_text('{"version": 1, "stage": "program", "pad": "' + "x" * progress_module.MAX_BYTES + '"}')
    assert read_progress(tmp_path) is None


# ---------------------------------------------------------------------------------------------- a real build

STABLE_DROPPED = ("timings_ms", "plan_s")


def stable(value):
    """A build's result without what differs from one run of the same build to the next: how long it took."""
    if isinstance(value, dict):
        return {k: stable(v) for k, v in value.items() if k not in STABLE_DROPPED}
    if isinstance(value, list):
        return [stable(v) for v in value]
    return value


def files_of(root, project, build):
    directory = root / project / HIDDEN_BUILDS / build
    names = sorted(p.name for p in directory.iterdir() if p.is_file())
    return directory, names


@pytest.fixture(scope="module")
def watched(client):
    """The cover example (an adaptive pocket, a pocket, a contour) built in full, its progress read as it ran."""
    assert client.post("/api/projects", json={"name": "watched", "example": "cover"}).status_code == 200
    return watch(client, "watched")


def test_a_running_build_says_its_stage(watched):
    build, seen = watched
    assert build["status"] == "done" and build["ok"] and build["released"] == 1
    stages = [state["stage"] for state in seen]
    assert stages, "the build ran without any progress to read"
    assert set(stages) <= set(progress_module.STAGES)
    # In the build's own order, none coming back.
    order = [stage for index, stage in enumerate(stages) if index == 0 or stages[index - 1] != stage]
    assert order == sorted(set(order), key=progress_module.STAGES.index)
    assert "planning" in order
    runs = [state["run"] for state in seen if state["run"]]
    assert runs and all((run["setup"], run["machine"], run["index"], run["count"]) == ("top", "mill", 0, 1) for run in runs)
    assert all([(op["id"], op["kind"]) for op in run["operations"]]
               == [("pocket", "adaptive_pocket"), ("recess", "pocket"), ("outline", "contour")] for run in runs)
    # An operation only goes forward: pending, planning, done.
    rank = {"pending": 0, "planning": 1, "done": 2}
    for index in range(3):
        states = [rank[run["operations"][index]["state"]] for run in runs]
        assert states == sorted(states)
    assert all(sum(op["state"] == "planning" for op in run["operations"]) <= 1 for run in runs)


def test_a_running_build_says_what_camlib_is_planning(watched):
    if not engine_reports_progress():
        pytest.skip("this camlib has no planning progress (camlib #198)")
    build, seen = watched
    runs = [state["run"] for state in seen if state["run"]]
    assert all(run["engine_progress"] for run in runs)
    pocket = [run["operations"][0] for run in runs if run["operations"][0]["state"] == "planning"]
    assert pocket, "the adaptive pocket was never seen being planned"
    # camlib counts an adaptive clearing by area; the fraction is its own, from 0 to 1, and never goes back.
    fractions = [op["fraction"] for op in pocket if op["fraction"] is not None]
    assert fractions and all(op["basis"] == "area" for op in pocket if op["fraction"] is not None)
    assert all(0 <= value <= 1 for value in fractions) and fractions == sorted(fractions)
    assert all(op["total"] == 2 for op in pocket if op["fraction"] is not None)   # 8 to 3 mm by 2.5 mm: two levels
    assert all(op["seconds"] is not None and op["seconds"] >= 0 for op in pocket)
    # An operation that isn't being planned has no fraction.
    assert all(op["fraction"] is None and op["basis"] is None for run in runs for op in run["operations"] if op["state"] != "planning")
    # Done operations: their time, and as many moves as camlib planned for them.
    done = [run["operations"] for run in runs if all(op["state"] == "done" for op in run["operations"])]
    if done:   # seen only when a poll fell between the last operation's end and the build's
        assert all(op["moves"] > 0 and op["seconds"] is not None for op in done[-1])


def test_progress_is_gone_once_the_build_is_done(client, root, watched):
    build, _ = watched
    assert "progress" not in build
    assert "progress" not in client.get(f"/api/projects/watched/builds/{build['id']}").json()
    assert all("progress" not in item for item in client.get("/api/projects/watched/builds").json())
    directory, names = files_of(root, "watched", build["id"])
    assert FILE not in names and FILE + ".tmp" not in names
    result = json.loads((directory / "result.json").read_text())
    assert "progress" not in result and "progress" not in result["metadata"]
    assert "engine_progress" not in (directory / "result.json").read_text()


def test_a_camlib_without_planning_progress_builds_and_says_its_stage(client, root, watched, monkeypatch):
    """The same program built without asking camlib for planning progress (as with a camlib that has none): it builds,
    says its stage and which operations are done, claims no operation is being planned, and leaves the same files."""
    monkeypatch.setenv(SWITCH, "0")
    assert client.post("/api/projects", json={"name": "plain", "example": "cover"}).status_code == 200
    plain, seen = watch(client, "plain")
    assert plain["status"] == "done" and plain["ok"] and plain["released"] == 1 and "progress" not in plain
    assert seen and "planning" in [state["stage"] for state in seen]
    runs = [state["run"] for state in seen if state["run"]]
    assert runs and not any(run["engine_progress"] for run in runs)
    assert all(op["state"] in ("pending", "done") and op["fraction"] is None and op["basis"] is None
               for run in runs for op in run["operations"])

    # The files of the two builds: byte for byte the same G-code and playback stream, and the same result but for how
    # long each took.
    built, _ = watched
    with_dir, with_names = files_of(root, "watched", built["id"])
    plain_dir, plain_names = files_of(root, "plain", plain["id"])
    assert with_names == plain_names and "gcode-1.nc" in with_names and "cam-playback.bin" in with_names
    for name in ("gcode-1.nc", "cam-playback.bin"):
        assert (with_dir / name).read_bytes() == (plain_dir / name).read_bytes(), name
    with_result, plain_result = (json.loads((d / "result.json").read_text()) for d in (with_dir, plain_dir))
    assert stable(with_result) == stable(plain_result)
    assert json.dumps(stable(with_result), sort_keys=True) == json.dumps(stable(plain_result), sort_keys=True)


def test_a_cancelled_build_has_no_progress(client, root):
    assert client.post("/api/projects", json={"name": "stopped", "example": "cover"}).status_code == 200
    started = client.post("/api/projects/stopped/builds", json={"mode": "full"}).json()
    url = f"/api/projects/stopped/builds/{started['id']}"
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline and "progress" not in client.get(url).json():
        time.sleep(0.05)
    cancelled = client.post(f"{url}/cancel").json()
    assert cancelled["status"] == "cancelled" and "progress" not in cancelled
    directory = root / "stopped" / HIDDEN_BUILDS / started["id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and (directory / FILE).exists():
        time.sleep(0.05)
    assert not (directory / FILE).exists()
    assert "progress" not in client.get(url).json()
