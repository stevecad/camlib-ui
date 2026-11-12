"""A camlib program's build, in its own process (`python -m camlib_ui.build <request.json>`). Two stages, in two
processes, so the program's own code never runs where its machine program is planned, checked, posted and released
(from STEVE Studio's camlib kernel):

Stage 1, the program (camlib_ui/build/stage1.py, a child process in its own session): runs program.py with its links
(the project's part file and shop.py) and hands back plain data only, through a pipe (camlib_ui.program.export_program):
camlib's compiled Job (stock, tools, operations with their regions and surfaces, checks), each setup's machines as data
(the post by name, the declared values, the tool table, the scene) and the accepted finding kinds. It writes no G-code,
findings or stream.

Stage 2, the build (this process): once stage 1 has ended, its whole process group is killed and nothing it wrote is
read. Stage 2 checks the data (shape, sizes), rebuilds the Job and the machines from it (camlib's posts, chosen by name
only), and for every setup and machine plans, simulates, checks every move, posts, decodes the posted G-code and replays
it on the stock (camlib's `Job.post`), then lets camlib's `export` release the G-code or refuse it. It writes, in a
directory of its own, then moves into the build's directory:

  - result.json: per setup and operation the moves, cut and rapid length, nominal time and camlib's own planning report
    (as camlib gave it: the engagement an adaptive clearing proved, a contour's loops left without a tab, ...);
    camlib's findings with their severity; per setup and machine the G-code's file, or why camlib refused it;
  - gcode-<n>.nc: each setup's posted program per machine, as camlib's export wrote it;
  - cam-playback.bin: every move of the decoded posted program with the stock it removes (docs/playback-stream.md).

A preview runs stage 1 and stage 2's checks and describes the program; nothing is planned.

While it runs, the build says what it is doing in progress.json in the build's directory (camlib_ui/build/progress.py):
its stage, and camlib's own planning progress of the operation being planned. That file is for the interface while it
waits: nothing of it goes into the result, and it is gone when the build ends.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import secrets
import select
import signal
import subprocess
import sys
import time
import traceback
import warnings

MAX_PROGRAMS = 32          # G-code files a build may return (gcode-1.nc … gcode-32.nc)
MAX_FINDINGS = 200         # findings listed per program (their counts are always complete)
MAX_DETAILS = 4            # details kept per finding
MAX_SETUPS, MAX_TARGETS = 16, 8
MAX_PROGRAM_DATA = 512 * 1024 * 1024   # stage 1's data (surface meshes for material checks are the large part)
STREAM = "cam-playback.bin"
OUTPUTS = ("result.json", STREAM, "cam-playback.body", *(f"gcode-{n}.nc" for n in range(1, MAX_PROGRAMS + 1)))
GCODE = re.compile(r"gcode-([1-9]|[12][0-9]|3[0-2])\.nc")
ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
CONFIG_KEYS = {"stock", "tools", "operations", "initial_position_mm", "sweep", "verification", "tool_change",
               "rapid_retracts", "revision"}
MAX_BODIES = 256           # fixture and protected bodies per machine scene
BODY_KEYS = {"id", "role", "footprint", "z_min_mm", "z_max_mm", "z_error_mm"}
NO_FIXTURES = "fixtures (no fixtures declared)"   # unchecked: the travel was checked, no fixture was
MAX_REPORT_BYTES = 256 * 1024   # an operation's planning report in result.json (a longer one is cut, and says where)
REPORT_CUT = "…"                # the key (or list item) that says what was cut from a report


class ProgramFailed(Exception):
    """Stage 1 (the program) failed: its own traceback is the message."""


def camlib_identity():
    """camlib's version, and the posts directory (with its git commit when it is a checkout)."""
    from importlib.metadata import version
    from camlib_ui.program import posts_directory
    directory = posts_directory()
    commit = None
    if directory is not None:
        try:
            commit = subprocess.run(["git", "-C", str(directory), "rev-parse", "HEAD"], capture_output=True, text=True,
                                    timeout=10).stdout.strip() or None
        except (OSError, subprocess.SubprocessError):
            commit = None
    return dict(version=version("camlib"), commit=commit, posts=str(directory) if directory else None)


# ------------------------------------------------------------------------------------------------ stage 1: the program

def run_stage1(request_path, clock, log):
    """Starts stage 1 in its own session, reads its data (bounded in size and time), then kills its process group."""
    read_fd, write_fd = os.pipe()
    process = subprocess.Popen([sys.executable, "-m", "camlib_ui.build.stage1", str(request_path), str(write_fd)],
                               pass_fds=(write_fd,), start_new_session=True, stdin=subprocess.DEVNULL, stdout=log,
                               stderr=log, cwd=str(Path(request_path).parent / "stage1"))
    os.close(write_fd)
    chunks, size = [], 0
    try:
        while True:
            ready, _, _ = select.select([read_fd], [], [], max(0.0, clock.deadline - time.monotonic()))
            if not ready:
                raise TimeoutError("The program didn't finish in the build's time.")
            chunk = os.read(read_fd, 1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_PROGRAM_DATA:
                raise ValueError(f"The program's data is over {MAX_PROGRAM_DATA // (1024 * 1024)} MB: make its stock grid "
                                 "or material-check meshes coarser, or split it into several programs.")
            chunks.append(chunk)
    finally:
        os.close(read_fd)
        try:
            os.killpg(process.pid, signal.SIGKILL)   # stage 1 and everything it started (its own session)
        except (ProcessLookupError, PermissionError):
            pass
        process.wait()
    try:
        answer = json.loads(b"".join(chunks))
    except (ValueError, RecursionError):
        log.flush()
        tail = Path(log.name).read_bytes().decode(errors="replace")[-4000:] if isinstance(log.name, str) else ""
        raise ProgramFailed("The program stopped without handing back its data." + (f"\n{tail}" if tail else "")) from None
    if not isinstance(answer, dict):
        raise ProgramFailed("The program handed back something else than its data.")
    if not answer.get("ok"):
        error = str(answer.get("error") or "The program failed.")[-12000:]
        if answer.get("reason") == "memory":
            raise MemoryError(error)
        raise ProgramFailed(error)
    return answer.get("program")


# ------------------------------------------------------------------------------------------------ stage 2: the build

def _need(condition, message):
    if not condition:
        raise ValueError(f"The program's data is invalid: {message}.")


def _finite_point(value):
    return isinstance(value, list) and len(value) == 3 and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e7 for v in value)


def load_program(data):
    """Stage 1's data, checked (shape, sizes, names), as (CompiledJob, {setup id: [Target]}, accept, warnings). camlib's
    own engine checks the configurations again in full when it plans them."""
    from camlib.jobs import CompiledJob, CompiledSetup
    from camlib.motion import WorkFrame
    _need(isinstance(data, dict) and data.get("version") == 1, "version")
    job = data.get("job")
    _need(isinstance(job, dict) and isinstance(job.get("id"), str) and ID.fullmatch(job["id"]), "job id")
    _need(isinstance(job.get("revision"), str) and 0 < len(job["revision"]) <= 600, "job revision")
    setups = job.get("setups")
    _need(isinstance(setups, list) and 0 < len(setups) <= MAX_SETUPS, "setups")
    compiled, seen = [], set()
    for setup in setups:
        _need(isinstance(setup, dict) and set(setup) == {"id", "config", "frame", "dependencies", "provenance"}, "setup")
        _need(isinstance(setup["id"], str) and ID.fullmatch(setup["id"]) and setup["id"] not in seen, "setup id")
        seen.add(setup["id"])
        config = setup["config"]
        _need(isinstance(config, dict) and set(config) <= CONFIG_KEYS, "setup configuration (milling only)")
        _need(config.get("revision") == job["revision"], "setup revision")
        _need(isinstance(config.get("tools"), list) and 0 < len(config["tools"]) <= 64, "tools")
        _need(isinstance(config.get("operations"), list) and 0 < len(config["operations"]) <= 256, "operations")
        _need(all(isinstance(t, dict) and isinstance(t.get("id"), str) and ID.fullmatch(t["id"]) for t in config["tools"]),
              "tool ids")
        _need(all(isinstance(o, dict) and isinstance(o.get("id"), str) and ID.fullmatch(o["id"])
                  for o in config["operations"]), "operation ids")
        frame = setup["frame"]
        _need(isinstance(frame, dict) and set(frame) == {"origin_mm", "x", "y", "z"}
              and all(_finite_point(frame[k]) for k in frame), "frame")
        dependencies = setup["dependencies"]
        _need(isinstance(dependencies, list) and len(dependencies) <= 256 and all(
            isinstance(d, list) and len(d) == 2 and all(isinstance(v, str) and len(v) <= 256 for v in d)
            for d in dependencies), "dependencies")
        _need(isinstance(setup["provenance"], list), "provenance")
        compiled.append(CompiledSetup(setup["id"], json.dumps(config, allow_nan=False),
                                      WorkFrame(**{k: tuple(v) for k, v in frame.items()}),
                                      tuple(tuple(d) for d in dependencies),
                                      json.dumps(setup["provenance"], allow_nan=False)))
    targets = data.get("targets")
    _need(isinstance(targets, dict) and set(targets) == seen, "machines per setup")
    rebuilt = {}
    for setup in compiled:
        entries = targets[setup.id]
        _need(isinstance(entries, list) and 0 < len(entries) <= MAX_TARGETS, f"machines of setup {setup.id}")
        keys = [e.get("key") if isinstance(e, dict) else None for e in entries]
        _need(len(set(keys)) == len(keys), f"machines of setup {setup.id} (each once)")
        rebuilt[setup.id] = [_target(e, setup) for e in entries]
    accept = data.get("accept")
    from camlib.export import ACCEPTABLE
    _need(isinstance(accept, list) and set(accept) <= ACCEPTABLE, "accept")
    caught = data.get("warnings") or []
    _need(isinstance(caught, list), "warnings")
    notes = [dict(severity="warning", kind=str(w.get("kind"))[:64], message=str(w.get("message"))[:500])
             for w in caught[:50] if isinstance(w, dict)]
    return CompiledJob(job["id"], job["revision"], tuple(compiled)), rebuilt, frozenset(accept), notes


def _target(entry, setup):
    """One machine of a setup, rebuilt from data with the post named in it (camlib_ui.program.POSTS)."""
    from camlib.post import ToolSetting
    from camlib_ui.program import POSTS, Target, build_machine, decode
    _need(isinstance(entry, dict) and set(entry) == {"key", "controller", "post", "name", "values", "tools", "lowering",
                                                     "derived", "scene"}, "machine")
    _need(all(isinstance(entry[k], str) and ID.fullmatch(entry[k]) for k in ("key", "controller")), "machine key")
    _need(entry["post"] in POSTS, "post (one of camlib-ui's posts, by name)")
    _need(isinstance(entry["name"], str) and 0 < len(entry["name"]) <= 128, "machine name")
    _need(isinstance(entry["values"], dict) and len(entry["values"]) <= 128, "machine values")
    values = {str(k): decode(v) for k, v in entry["values"].items()}
    _need("work_to_machine" in values, "machine work_to_machine (the program states it; never a default)")
    scene = _scene_data(entry["scene"])
    lowering = decode(entry["lowering"])
    gauges = {t["id"]: t.get("gauge_length_mm") for t in setup.config["tools"]}
    tools = entry["tools"]
    _need(isinstance(tools, list) and len(tools) == len(gauges), "machine tool table")
    settings = []
    for t in tools:
        _need(isinstance(t, dict) and set(t) == {"tool", "number", "length_register", "position_after_mm",
                                                 "diameter_register"} and t["tool"] in gauges, "tool setting")
        _need(all(isinstance(t[k], int) and not isinstance(t[k], bool) for k in ("number", "length_register"))
              and (t["diameter_register"] is None or isinstance(t["diameter_register"], int))
              and _finite_point(t["position_after_mm"]), "tool setting values")
        settings.append(ToolSetting(t["tool"], t["number"], t["length_register"], gauges[t["tool"]],
                                    tuple(t["position_after_mm"]), t["diameter_register"]))
    machine, post_class, decoder_class = build_machine(entry["post"], entry["name"], settings, values)
    derived = entry["derived"] if isinstance(entry["derived"], list) else []
    return Target(entry["key"], entry["controller"], entry["post"], machine, post_class, decoder_class, lowering,
                  {str(k): True for k in derived[:32]}, {}, scene)


def _number(value, low=-1e7, high=1e7):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and low <= value <= high


def _scene_data(value):
    """A machine's scene from stage 1, checked: the spindle's gauge-line travel in machine coordinates (the shop's) and
    the bodies placed on the machine (camlib Prisms, rebuilt from their data; camlib's engine checks them again in full
    when it prepares the scene)."""
    from camlib.verification import Prism
    _need(isinstance(value, dict) and set(value) == {"travel_mm", "bodies"}, "machine scene")
    travel = value["travel_mm"]
    _need(isinstance(travel, list) and len(travel) == 2 and all(_finite_point(p) for p in travel)
          and all(travel[0][k] < travel[1][k] for k in range(3)), "machine travel")
    bodies, ids = value["bodies"], set()
    _need(isinstance(bodies, list) and len(bodies) <= MAX_BODIES, f"scene bodies (at most {MAX_BODIES})")
    prisms = []
    for body in bodies:
        _need(isinstance(body, dict) and BODY_KEYS <= set(body) <= BODY_KEYS | {"representation"}, "scene body")
        _need(isinstance(body["id"], str) and ID.fullmatch(body["id"]) and body["id"] not in ids, "scene body id")
        ids.add(body["id"])
        _need(body["role"] in ("fixture", "protected_target"), "scene body role")
        _need(body.get("representation", "solid_prism") in ("solid_prism", "outer_envelope"), "scene body representation")
        _need(_number(body["z_min_mm"]) and _number(body["z_max_mm"]) and body["z_min_mm"] < body["z_max_mm"]
              and _number(body["z_error_mm"], 0, 1e3) and isinstance(body["footprint"], dict), "scene body geometry")
        prisms.append(Prism(body["id"], body["footprint"], float(body["z_min_mm"]), float(body["z_max_mm"]), body["role"],
                            float(body["z_error_mm"]), body.get("representation", "solid_prism")))
    return dict(travel_mm=(tuple(map(float, travel[0])), tuple(map(float, travel[1]))), bodies=tuple(prisms))


def scene_of(setup, target):
    """The setup's verification on this machine: the program's own checks (stock contact, material) and camlib's Scene
    for its travel and bodies. A mill's travel limits its spindle's gauge line, which sits each tool's gauge length above
    the tip, so the scene declares the gauge line's travel (camlib's MachineLimits.gauge_line) and camlib checks every
    move against its own tool's travel: the gauge box lowered along machine Z by that tool's gauge length. A plasma or
    laser head isn't held in a spindle (camlib refuses gauge-line travel for a beam): its one tool's tip travel is the
    head's travel less its gauge length, which is exact for one tool."""
    import dataclasses
    import hashlib
    from camlib.verification import MachineLimits, Options, Scene
    from camlib_ui.program import BEAM_PROCESSES, POSTS
    config = dict(setup.config.get("verification") or {})
    if config.get("scene"):
        raise ValueError(f"Setup {setup.id} configures its own camlib Scene: the machine's travel and fixtures come from "
                         "machine(..., work_to_machine=..., fixtures=...); leave scene out of StreamChecks.")
    gauges = {t["id"]: t.get("gauge_length_mm") for t in setup.config["tools"]}
    _need(all(_number(g, 0, 1e5) for g in gauges.values()), "tool gauge lengths")
    (low, high), bodies = target.scene["travel_mm"], target.scene["bodies"]
    machine = target.machine
    feeds = (machine.max_feed_mm_min, machine.max_normal_accel_mm_s2, machine.max_axis_feed_mm_min)
    # Each tool's own tip travel (for the result: what camlib checks its moves against).
    tips = {tool: [[low[0], low[1], low[2] - gauge], [high[0], high[1], high[2] - gauge]] for tool, gauge in gauges.items()}
    if POSTS[target.post].process in BEAM_PROCESSES:
        _need(len(gauges) == 1, "a cutting head's setup has one tool")
        (tip_low, tip_high), = tips.values()
        limits = MachineLimits(tuple(tip_low), tuple(tip_high), *feeds)
    else:
        limits = MachineLimits.gauge_line(tuple(low), tuple(high), *feeds)
    content = dict(bodies=[b.to_dict() for b in bodies], machine=limits.to_dict(),
                   frame=dataclasses.asdict(machine.work_to_machine))
    revision = hashlib.sha256(json.dumps(content, sort_keys=True, allow_nan=False).encode()).hexdigest()[:32]
    scene = Scene(setup.id, revision, bodies, limits, machine.work_to_machine)
    config["scene"] = dict(scene=scene.to_dict(), options=dataclasses.asdict(Options()))
    config.setdefault("material", [])
    summary = dict(travel_mm=[list(low), list(high)], tool_tip_travel_mm=tips,
                   work_to_machine=dataclasses.asdict(machine.work_to_machine),
                   fixtures=[b.id for b in bodies if b.role == "fixture"],
                   protected=[b.id for b in bodies if b.role == "protected_target"],
                   bodies=[_body_outline(b) for b in bodies])
    return config, summary


def _body_outline(body):
    """A scene body for the viewer to draw (display only): its id, role, Z range and each footprint component's outer
    vertices (x, y; the curve data between them is left out)."""
    footprint = body.footprint.to_dict() if hasattr(body.footprint, "to_dict") else body.footprint
    outlines = [[[float(v[0]), float(v[1])] for v in (c.get("outer") or {}).get("vertices") or []][:2000]
                for c in (footprint or {}).get("components") or [] if isinstance(c, dict)][:64]
    return dict(id=body.id, role=body.role, z_min_mm=body.z_min_mm, z_max_mm=body.z_max_mm, outlines=outlines)


def unchecked_on(scene, unchecked):
    """camlib's unchecked checks, plus what the scene left out: travel is always checked here (the shop's), fixtures
    only when the program placed some, which is said rather than claimed."""
    out = [u for u in unchecked]
    if not scene["fixtures"]:
        out.append(NO_FIXTURES)
    return out


def _job(compiled):
    """A camlib Job whose compile() is the rebuilt CompiledJob: Job.post then runs camlib's own posting path on it."""
    from camlib.jobs import Job

    class Compiled(Job):
        def compile(self):
            return compiled
    return Compiled(compiled.id, compiled.revision, ())


def _tool_summary(tool):
    from camlib.tools import ToolAssembly
    tool = ToolAssembly.from_dict(tool)
    cutter = tool.cutter
    return dict(id=tool.id, name=cutter.name, shape=dict(cutter.shape), diameter_mm=cutter.diameter_mm,
                cutting_length_mm=cutter.cutting_length_mm, overall_length_mm=cutter.overall_length_mm,
                shank_diameter_mm=cutter.shank_diameter_mm, flutes=cutter.flutes, stickout_mm=tool.stickout_mm,
                gauge_length_mm=tool.gauge_length_mm,
                holders=[dict(z_min_mm=h.z_min_mm, z_max_mm=h.z_max_mm, radius_min_mm=h.radius_min_mm,
                              radius_max_mm=h.radius_max_mm) for h in tool.holders])


def _operation_summary(op):
    return dict(id=op["id"], kind=op.get("kind"), tool=op.get("tool"), tool_number=op.get("tool_number"),
                length_register=op.get("length_register"), spindle_rpm=op.get("spindle_rpm"),
                feed_mm_min=op.get("feed_mm_min"))


def describe(compiled, targets, accept):
    """The program as compiled: setups, their stock, tools, operations and machines (no planning)."""
    setups = []
    for setup in compiled.setups:
        config = setup.config
        stock = config["stock"]
        setups.append(dict(
            id=setup.id,
            stock=dict(min_mm=stock.get("min_mm"), max_mm=stock.get("max_mm"), cell_size_mm=stock.get("cell_size_mm"))
            if isinstance(stock, dict) else None,
            tools=[_tool_summary(t) for t in config["tools"]],
            operations=[_operation_summary(o) for o in config["operations"]],
            machines=[dict(machine=t.key, controller=t.controller, post=t.post, units=t.machine.output_units,
                           decimals=t.machine.decimals, from_shop=sorted(t.derived), scene=scene_of(setup, t)[1])
                      for t in targets[setup.id]],
        ))
    return dict(id=compiled.id, revision=compiled.revision, setups=setups, accept=sorted(accept))


DETAIL_KEYS = ("kind", "object_id", "part", "source", "contact_point_mm", "witness", "cell_range", "message", "depth_mm",
               "assessment", "detail")


def _finding(entry, material):
    """One of camlib's non-clear results as the build lists it: the move it is attributed to (1-based count of moves
    done; 0 before the first), its severity (camlib's status: violation or uncertain) and up to MAX_DETAILS details. A
    material result's details are its gouge and residual assessments (the whole report is the machine's `material`)."""
    details = []
    for item in list(entry.get("findings") or [])[:MAX_DETAILS]:
        if not isinstance(item, dict):
            continue
        if "gouge" in item and "residual" in item:   # A material result: camlib gives its report as the finding.
            details.append(dict(kind="material", target_id=item.get("target_id"),
                                gouge=(item.get("gouge") or {}).get("assessment"),
                                residual=(item.get("residual") or {}).get("assessment"), complete=item.get("complete")))
            continue
        detail = item.get("finding", item)
        details.append({k: detail[k] for k in DETAIL_KEYS if k in detail})
    if not details and material and material.get("completed") == entry.get("completed"):
        details.append(dict(kind="material", target_id=material.get("target_id"),
                            gouge=(material.get("gouge") or {}).get("assessment"),
                            residual=(material.get("residual") or {}).get("assessment"), complete=material.get("status")))
    return dict(move=entry.get("completed"), severity=entry.get("status"), details=details)


def bounded_report(report, limit=MAX_REPORT_BYTES):
    """An operation's planning report as camlib gave it, for result.json: unchanged when it fits `limit` bytes of JSON,
    else with its long lists and texts cut shorter until it does. Whatever is cut is said in place, never dropped
    silently: a cut list ends with {"…": "<n> more of <total> not listed"}, a cut text with "… (<n> more characters)",
    and values nested too deep are {"…": "not listed (nested too deep)"}."""
    def cut(value, items, text, depth):
        if isinstance(value, dict):
            if depth > 12:
                return {REPORT_CUT: "not listed (nested too deep)"}
            return {str(k)[:200]: cut(v, items, text, depth + 1) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            if depth > 12:
                return [{REPORT_CUT: "not listed (nested too deep)"}]
            kept = [cut(v, items, text, depth + 1) for v in value[:items]]
            if len(value) > items:
                kept.append({REPORT_CUT: f"{len(value) - items} more of {len(value)} not listed"})
            return kept
        if isinstance(value, str) and len(value) > text:
            return f"{value[:text]}… ({len(value) - text} more characters)"
        if isinstance(value, float) and not math.isfinite(value):
            return str(value)
        if value is None or isinstance(value, (bool, int, float, str)):
            return value
        return str(value)[:text]
    if not isinstance(report, dict):
        return None
    for items, text in ((10**9, 10**9), (256, 4000), (64, 2000), (16, 1000), (4, 400), (1, 100)):
        shaped = cut(report, items, text, 0)
        if len(json.dumps(shaped, allow_nan=False, default=str)) <= limit:
            return shaped
    return {REPORT_CUT: f"the report is over {limit} bytes even cut short: not listed"}


class Clock:
    def __init__(self, started, timeout):
        self.deadline = started + timeout - 15   # time left to write the result and send the files

    def left(self):
        return max(1.0, self.deadline - time.monotonic())


def _post(job, setup, target, clock, *, stream=None, program_accept=frozenset(), artifact=None, progress=None):
    """One setup posted for one machine: statistics (and the playback stream) from the posted, decoded and replayed
    program, camlib's findings, and its G-code if camlib's export releases it. `progress` (camlib_ui.build.progress) is
    told what camlib is planning; it changes nothing of the run."""
    from camlib_ui.build.progress import INTERVAL_S, Progress
    progress = progress or Progress(None)
    from camlib.export import ExportRefused, unchecked as missing
    from camlib.simulation import checked_length, stock_state
    clock_start = time.monotonic()
    verification, scene = scene_of(setup, target)
    # camlib's own report of each operation as it planned it (the last one it gave: an operation's end carries the
    # whole plan's figures), kept as given for the result. Called while the run is read; a list append only.
    reports = {}

    def on_operation(update):
        if isinstance(update.report, dict):
            reports[update.operation] = update.report
        progress.on_operation(update)
    options = dict(machine=target.machine, post=target.post_class, decoder=target.decoder_class,
                   verification=verification, on_operation=on_operation)
    # camlib's planning progress, where this camlib has it (#198): transient, the run is the same with or without it.
    if progress.engine:
        options.update(on_progress=progress.on_progress, progress_interval_s=INTERVAL_S)
    if target.lowering is not None:
        options["lowering"] = target.lowering
    run = job.post(setup.id, **options)
    with run:
        run.wait(timeout=clock.left())
        status = run.status()
        if status["error"]:
            raise RuntimeError(f"camlib stopped setup {setup.id!r} for {target.key}: {status['error']}")
        if not status["finished"]:
            raise TimeoutError(f"setup {setup.id!r} for {target.key} didn't finish in the build's time")
        planned_s = time.monotonic() - clock_start
        config = setup.config
        order = [o["id"] for o in config["operations"]]
        operations = {op: dict(id=op, moves=0, cut_mm=0.0, rapid_mm=0.0, seconds=0.0) for op in order}
        count = status["available"]
        progress.stage("playback")
        state = stock_state(run.wait_ready()) if stream is not None else None
        writer = None
        if stream is not None:
            from camlib_ui.build.stream import SetupStream
            writer = SetupStream(stream, setup.id, state, tools=[_tool_summary(t) for t in config["tools"]],
                                 operations=[_operation_summary(o) for o in config["operations"]], machine=target.key,
                                 controller=target.controller, post=target.post)
        for index in range(count):
            frame = run.read_chunk(index)
            start, end = run.motion_time(index)
            if state is not None:
                update = state.accept(frame)
                motion, changes, changed = update.motion, update.changes, update.changed_count
            else:
                motion, changes, changed = _motion(frame), b"", 0
            item = operations.setdefault(motion["operation"], dict(id=motion["operation"], moves=0, cut_mm=0.0,
                                                                   rapid_mm=0.0, seconds=0.0))
            length = checked_length(motion["curve"])
            item["moves"] += 1
            item["seconds"] += end - start
            if motion["feed_mm_min"] is None:
                item["rapid_mm"] += length
            else:
                item["cut_mm"] += length
            if writer is not None:
                try:
                    nc = run.posted_motion(index)["nc"]
                    line = nc[0]["number"] if nc else None
                except (KeyError, IndexError, TypeError):
                    line = None
                writer.add(motion, changes, changed, end - start, line)
        posting = run.posting_status()
        remaining = None
        if state is not None:
            volume = state.volume()   # camlib's own count of the final stock, for the viewer's (and tests') replay
            remaining = dict(upper=round(volume["remaining_upper_mm3"], 3), lower=round(volume["remaining_lower_mm3"], 3))
        result = dict(machine=target.key, controller=target.controller, post=target.post, moves=count,
                      seconds=round(status["seconds"], 3), lines=posting["lines"],
                      arc_output=posting.get("arc_output"), plan_s=round(planned_s, 3),
                      **({"stock_remaining_mm3": remaining} if remaining else {}))
        progress.stage("release")
        try:
            exported = run.export(artifact, accept=program_accept, timeout=clock.left())
        except ExportRefused as refused:
            findings = list(refused.findings)
            result.update(gcode=None, refused=str(refused), refused_kinds=list(refused.statuses))
            unchecked = list(missing(run._verification_config()))
        else:
            findings = list(exported["findings"])
            result.update(gcode=Path(artifact).name, refused=None, accepted=list(exported["accepted"]))
            unchecked = list(exported["unchecked"])
        unchecked = unchecked_on(scene, unchecked)
        checks = run.verification_status(sample_limit=0)
        material = checks.get("material")
        counts = {}
        for entry in findings:
            counts[entry["status"]] = counts.get(entry["status"], 0) + 1
        result.update(findings=[_finding(f, material) for f in findings[:MAX_FINDINGS]], finding_counts=counts,
                      findings_listed=min(len(findings), MAX_FINDINGS), unchecked=unchecked,
                      checks=dict(progress=checks.get("progress"), coverage=checks.get("coverage")),
                      material=material, scene=scene)
        for item in operations.values():
            for key in ("cut_mm", "rapid_mm", "seconds"):
                item[key] = round(item[key], 3)
            item["report"] = bounded_report(reports.get(item["id"]))
        return result, [operations[op] for op in order] + [v for k, v in operations.items() if k not in order], writer


def _motion(frame):
    from camlib.simulation import _Decoder
    d = _Decoder(frame.payload)
    d.string(128), d.string(512), d.take(32)
    d.unpack("<3Q")
    return d.motion()


def _fresh_directory(job_dir):
    """Stage 2's own directory (stage 1 has ended: nothing can plant files in it), where it writes everything."""
    path = job_dir / f"stage2-{secrets.token_hex(8)}"
    path.mkdir(mode=0o700)
    (path / "tmp").mkdir(mode=0o700)
    return path


def _publish(work, job_dir, names):
    """Moves stage 2's outputs into the job directory, replacing whatever is there under those names (stage 1 may have
    left files named like them; a directory under such a name stops the build)."""
    for name in OUTPUTS:
        target = job_dir / name
        if target.is_symlink() or target.exists():
            if target.is_dir() and not target.is_symlink():
                raise RuntimeError(f"The program left a directory named {name}; the build stops here.")
            target.unlink()
    for name in names:
        os.replace(work / name, job_dir / name)


def build(request_path, started, log, progress=None):
    """The build's metadata; its files are put in the build's directory (the request's)."""
    from camlib_ui.build.progress import Progress
    progress = progress or Progress(None)
    request = json.loads(Path(request_path).read_text())
    mode = request.get("mode", "full")
    if mode not in ("preview", "full"):
        raise ValueError(f"A build is a preview or full, not {mode!r}.")
    clock = Clock(started, int(request.get("timeout") or 600))
    job_dir = Path(request_path).parent
    (job_dir / "stage1").mkdir(exist_ok=True)
    timings = {}
    t0 = time.monotonic()
    progress.stage("program")
    try:
        data = run_stage1(request_path, clock, log)
    except BaseException:
        _publish(job_dir, job_dir, [])   # Nothing the program wrote under an output's name goes out with its error.
        raise
    timings["program"] = round((time.monotonic() - t0) * 1000)
    # Stage 2: nothing of stage 1 runs any more. Its own directory and temporary files from here on.
    work = _fresh_directory(job_dir)
    os.chdir(work)
    progress.stage("describe")
    try:
        return _stage2(data, mode, clock, started, timings, work, job_dir, progress)
    except BaseException:
        _publish(work, job_dir, [])   # Nothing stage 1 left under an output's name goes out with the error.
        raise
    finally:
        os.chdir(job_dir)
        import shutil
        shutil.rmtree(work, ignore_errors=True)


def _stage2(data, mode, clock, started, timings, work, job_dir, progress):
    """Stage 2 in its own directory `work`: stage 1's data checked and rebuilt, then planned, checked, posted and
    released by camlib; its outputs moved into the job directory."""
    os.environ.update(TMPDIR=str(work / "tmp"), HOME=str(work))
    import tempfile
    tempfile.tempdir = None
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        compiled, targets, accept, notes = load_program(data)
        job = _job(compiled)
        metadata = dict(kind="camlib", camlib=camlib_identity(), program=describe(compiled, targets, accept))
        outputs = []
        if mode == "full":
            t1 = time.monotonic()
            setups, programs, streams = [], [], []
            runs = sum(len(targets[setup.id]) for setup in compiled.setups)
            with open("cam-playback.body", "wb") as body:
                for setup in compiled.setups:
                    entry = dict(id=setup.id, operations=None, machines=[])
                    for position, target in enumerate(targets[setup.id]):
                        if len(programs) >= MAX_PROGRAMS:
                            raise ValueError(f"A build posts at most {MAX_PROGRAMS} programs (setups × machines).")
                        artifact = f"gcode-{len(programs) + 1}.nc"
                        progress.begin_run(setup.id, target.key, len(programs), runs,
                                           [(o["id"], o.get("kind")) for o in setup.config["operations"]])
                        result, operations, writer = _post(job, setup, target, clock,
                                                           stream=body if position == 0 else None,
                                                           program_accept=accept, artifact=artifact, progress=progress)
                        if position == 0:
                            entry["operations"] = operations
                            entry["seconds"] = result["seconds"]
                            streams.append(writer.finish())
                        result["setup"] = setup.id
                        entry["machines"].append(result)
                        programs.append(dict(setup=setup.id, machine=target.key, controller=target.controller,
                                             post=target.post, artifact=result["gcode"], refused=result["refused"]))
                        if result["gcode"]:
                            outputs.append(result["gcode"])
                    setups.append(entry)
            progress.stage("files")
            from camlib_ui.build.stream import write
            write(STREAM, streams, "cam-playback.body", camlib=metadata["camlib"])
            outputs.append(STREAM)
            timings["post"] = round((time.monotonic() - t1) * 1000)
            metadata.update(setups=setups, programs=programs, stream=STREAM)
    metadata["warnings"] = (notes + [dict(severity="warning", kind=w.category.__name__, message=str(w.message)[:500])
                                     for w in caught])[:50]
    _publish(work, job_dir, outputs)
    timings["total"] = round((time.monotonic() - started) * 1000)
    metadata["timings_ms"] = timings
    return metadata


def verify_outputs(metadata, job_dir):
    """The files a full build left, against its result: every released program's G-code (ASCII) and nothing else, and a
    playback stream that follows its spec. Raises on any mismatch."""
    from camlib_ui import stream as reader
    released = [p["artifact"] for p in metadata.get("programs") or [] if p["artifact"]]
    if any(p["artifact"] and p["refused"] for p in metadata.get("programs") or []):
        raise RuntimeError("The build listed a refused program with G-code.")
    present = [p.name for p in job_dir.iterdir() if GCODE.fullmatch(p.name)]
    if sorted(present) != sorted(released) or len(set(released)) != len(released):
        raise RuntimeError("The build left G-code its result doesn't list as released.")
    for name in released:
        (job_dir / name).read_bytes().decode("ascii")
    if metadata.get("stream"):
        metadata["stream_summary"] = reader.check((job_dir / STREAM).read_bytes())


def main(request_path):
    """Builds; writes result.json ({"ok": true, "metadata": ...} or {"ok": false, "error": ...}) in the build's
    directory. The log (stage 1's output too) is log.txt there."""
    from camlib_ui.build.progress import Progress
    started = time.monotonic()
    job_dir = Path(request_path).resolve().parent
    progress = Progress(job_dir)
    with open(job_dir / "log.txt", "ab", buffering=0) as log:
        try:
            metadata = build(Path(request_path).resolve(), started, log, progress)
            if metadata.get("setups") is not None:
                verify_outputs(metadata, job_dir)
            result = {"ok": True, "metadata": metadata}
        except BaseException as error:  # noqa: BLE001  Every failure is the build's result.
            message = str(error) if isinstance(error, ProgramFailed) else traceback.format_exc()[-12000:]
            log.write(traceback.format_exc().encode())
            result = {"ok": False, "error": message, "reason": "memory" if isinstance(error, MemoryError) else None}
        finally:
            progress.close()   # Transient: gone before the result is there.
    text = json.dumps(result, allow_nan=False, default=str)
    (job_dir / "result.json.tmp").write_text(text)
    os.replace(job_dir / "result.json.tmp", job_dir / "result.json")
    return 0 if result["ok"] else 1
