"""Lathe setups end to end through the API: the shaft example released with camlib's FANUC lathe post, its playback
stream's turned stock against camlib's own, what the result says wasn't checked, the same program on the Centroid lathe
post, and what the shop and program helpers map and refuse."""
from __future__ import annotations

import math

import pytest

from camlib_ui import stream

from conftest import build, edit, needs_posts, variant

OPERATIONS = ["face", "rough", "finish", "thread", "part_off"]


def _replaced(old, new):
    def change(text):
        assert old in text, old
        return text.replace(old, new)
    return change


def test_the_shaft_is_released(shaft):
    assert shaft["status"] == "done" and shaft["ok"] and shaft["released"] == 1 and shaft["refused"] == 0, shaft.get("program_error")
    (setup,) = shaft["metadata"]["setups"]
    (machine,) = setup["machines"]
    assert machine["post"] == "fanuc_lathe" and machine["gcode"] == "gcode-1.nc" and machine["refused"] is None
    assert machine["finding_counts"] == {} and machine["accepted"] == ["unchecked_machine"]
    assert [op["id"] for op in setup["operations"]] == OPERATIONS
    assert all(op["moves"] > 0 and op["cut_mm"] > 0 for op in setup["operations"])
    assert sum(op["moves"] for op in setup["operations"]) == machine["moves"]
    # camlib's own report of each turning operation is kept as it gave it.
    assert setup["operations"][0]["report"]["passes"] == 2 and "min_part_clearance_mm" in setup["operations"][1]["report"]
    assert set(shaft["files"]) == {"cam-playback.bin", "gcode-1.nc"}


def test_what_a_lathe_build_did_not_check_is_said(shaft):
    machine = shaft["metadata"]["setups"][0]["machines"][0]
    # No crash model: the machine's bodies aren't checked (accepted by the program), and neither is its travel.
    assert machine["unchecked"] == ["machine", "machine travel (a lathe setup: checked only with a machine crash model)"]
    assert machine["scene"]["travel_mm"] is None and machine["scene"]["chuck_z_mm"] == -50
    # camlib's material check of the replayed stock against the part: no gouge; what is left is reported, not refused.
    material = machine["material"]
    assert material["gouge"]["assessment"] == "within_tolerance" and material["complete"] is True
    assert material["residual"]["assessment"] in ("possible_excess", "within_tolerance")
    assert len(material["findings"]) <= 64 and material["findings_total"] >= len(material["findings"])


def test_the_lathe_gcode_is_the_fanuc_posts(client, shaft):
    lines = client.get(shaft["files"]["gcode-1.nc"]).text.splitlines()
    assert lines[:11] == ["%", "O1001", "G21", "G18", "G98", "G97", "G40", "G80", "M5", "M9", "G54"]
    assert lines[-2:] == ["M30", "%"] and len(lines) == shaft["metadata"]["setups"][0]["machines"][0]["lines"]
    # Every turret station the program uses, as T<station><offset>; the thread as G32 with its lead; arcs in G18.
    assert [line for line in lines if line.startswith("T")] == ["T0101", "T0202", "T0303", "T0404"]
    assert any(line.startswith("G32 ") and line.endswith("F2.5") for line in lines)
    assert any(line.startswith(("G2 ", "G3 ")) for line in lines)
    # A lathe has no Y axis, and X words are diameters: the bar is 40 mm across, the tool starts at X80.
    words = [word for line in lines for word in line.split(" ")]
    assert not any(word.startswith("Y") for word in words) and "X80." in words


def test_the_stream_holds_the_turned_stock(client, shaft):
    data = client.get(shaft["files"]["cam-playback.bin"]).content
    (summary,) = stream.check(data)["setups"]
    machine = shaft["metadata"]["setups"][0]["machines"][0]
    assert summary["moves"] == machine["moves"] and summary["restarts"] == 0
    reader = stream.Reader(data)
    (setup,) = reader.setups()
    stock = setup["stock"]
    assert stock["kind"] == "turned" and stock["ny"] == 2 and stock["nx"] == 248 and stock["rings"] == []
    assert (stock["z_min_mm"], stock["z_max_mm"], stock["outer_radius_mm"], stock["bore_radius_mm"]) == (-60, 2, 20, 0)
    # Before the first move: the whole bar. After the last: camlib's own count of what is left.
    bar = math.pi * 20 ** 2 * 62
    start = stream.volume(setup, reader.stock_at(setup, 0))
    assert abs(start[0] - bar) < 1e-3 and start[0] == start[1]
    upper, lower = stream.volume(setup, reader.stock_at(setup, setup["moves"]))
    assert abs(upper - machine["stock_remaining_mm3"]["upper"]) < 0.5
    assert abs(lower - machine["stock_remaining_mm3"]["lower"]) < 0.5
    # The finished thread's land: its outer radius is the major radius' at most, and the bar past the part is parted off.
    grid = reader.stock_at(setup, setup["moves"])
    cell = lambda z: int((z - stock["z_min_mm"]) / stock["cell_mm"][0])
    assert grid[2 * cell(-10) + 1] <= 10 + 1e-3 and grid[2 * cell(-30) + 1] == pytest.approx(15, abs=0.02)
    assert grid[2 * cell(-41.5) + 1] < 0.5
    # Moves stay in the XZ plane; every move's G-code line is a line of the posted program, in order.
    moves = [m for chunk in setup["chunks"] for m in reader.moves(setup, chunk)]
    assert all(m["end"][1] == 0 for m in moves) and {m["plane"] for m in moves if m["curve"] == "arc"} == {"xz"}
    lines = [m["line"] for m in moves]
    assert lines == sorted(lines) and lines[0] >= 1 and lines[-1] <= machine["lines"]
    assert "thread" in {m["kind"] for m in moves}


def test_the_stream_describes_the_turning_tools(client, shaft):
    reader = stream.Reader(client.get(shaft["files"]["cam-playback.bin"]).content)
    (setup,) = reader.setups()
    assert [tool["id"] for tool in setup["tools"]] == ["t_rough", "t_finish", "t_thread", "t_part"]
    assert [(tool["number"], tool["offset"]) for tool in setup["tools"]] == [(1, 1), (2, 2), (3, 3), (4, 4)]
    rough, _, thread, blade = (tool["turning"] for tool in setup["tools"])
    assert rough["insert"] == "outline" and rough["side"] == "outer" and rough["nose_radius_mm"] == 0.8
    # Outlines are relative to the point the program moves (the imaginary tip): an outside, right-hand insert lies
    # away from the axis (+x) and from the chuck (+z) of it, and its nose touches both of the tip's axes.
    xs, zs = [p[0] for p in rough["insert_outline"]], [p[1] for p in rough["insert_outline"]]
    assert min(xs) == pytest.approx(0, abs=0.01) and min(zs) == pytest.approx(0, abs=0.01) and max(xs) > 10
    # The parting blade: 3 mm wide, 22 mm long, its leading corner at the tip.
    assert sorted({tuple(p) for p in blade["insert_outline"]}) == [(0, 0), (0, 3), (22, 0), (22, 3)]
    assert thread["insert"] == "thread" and thread["insert_outline"][0] == [0, 0]
    assert [op["kind"] for op in setup["operations"]] == ["turn_face", "turn_rough", "turn_finish", "turn_thread", "turn_part_off"]
    assert [op["tool_number"] for op in setup["operations"]] == [1, 1, 2, 3, 4]
    assert setup["operations"][1]["spindle_rpm"] == 1200 and setup["operations"][1]["feed_mm_rev"] == 0.25


@needs_posts
def test_a_preview_describes_a_lathe_setup(client):
    preview = build(client, "shaft", mode="preview")
    assert preview["status"] == "done" and preview["ok"], preview.get("program_error")
    (setup,) = preview["metadata"]["program"]["setups"]
    assert setup["process"] == "turning" and [op["id"] for op in setup["operations"]] == OPERATIONS
    stock = setup["stock"]
    assert stock["kind"] == "turned" and stock["outer_radius_mm"] == 20 and stock["chuck_z_mm"] == -50
    assert stock["min_mm"] == [-20, -20, -60] and stock["max_mm"] == [20, 20, 2]
    # The part's half-section as camlib read it from the part file: lines, and the relief's fillet as an arc (a bulge).
    assert stock["profile"][0] == [0, 0, 0] and stock["profile"][-1] == [15, -40, 0]
    assert sum(1 for point in stock["profile"] if point[2] != 0) == 1
    (machine,) = setup["machines"]
    assert machine["post"] == "fanuc_lathe" and machine["scene"]["bodies"] == []
    assert "max_spindle_rpm" in machine["from_shop"] and "tool_changes" in machine["from_shop"]


@needs_posts
def test_without_its_acceptance_a_lathe_program_is_refused(client):
    refused = variant(client, "shaft_refused", "shaft", _replaced('    accept={"unchecked_machine"},\n', ""))
    assert refused["status"] == "done" and refused["ok"] and refused["released"] == 0 and refused["refused"] == 1
    machine = refused["metadata"]["setups"][0]["machines"][0]
    assert machine["gcode"] is None and machine["refused_kinds"] == ["unchecked_machine"]
    assert set(refused["files"]) == {"cam-playback.bin"}


@needs_posts
def test_the_shaft_on_a_centroid_lathe(client):
    assert client.post("/api/projects", json={"name": "shaft_centroid", "example": "shaft"}).status_code == 200
    edit(client, "shaft_centroid", "shop.py", _replaced('"FANUC 0i-TF (system A)", dialect="fanuc_lathe_system_a_v1"',
                                                        '"Centroid CNC12 lathe", dialect="centroid_lathe_v1"'))
    edit(client, "shaft_centroid", "program.py", _replaced(", program_number=1001", ""))
    done = build(client, "shaft_centroid")
    assert done["ok"] and done["released"] == 1, done.get("program_error")
    lines = client.get(done["files"]["gcode-1.nc"]).text.splitlines()
    assert lines[:6] == ["G21", "G18", "G98", "G97", "G40", "G80"] and "G52 X0 Z0" in lines and "T0101" in lines


@needs_posts
def test_camlibs_refusal_of_a_turning_move_is_the_builds_error(client):
    # The thread run deeper than its chamfer allows: camlib's planner refuses the move, and says which.
    broken = variant(client, "shaft_gouge", "shaft", _replaced("z_start_mm=0, z_end_mm=-15", "z_start_mm=-1.5, z_end_mm=-15"))
    assert broken["status"] == "done" and broken["ok"] is False and broken["files"] == {}
    assert "thread: the insert would cut" in broken["program_error"]


@needs_posts
def test_what_a_lathe_machine_refuses(client):
    cases = {
        "tooling": ("machine(shop.lathe, setup, ", "machine(shop.lathe, setup, tooling=shop.turret, ", "give no tooling="),
        "premise": ("flood=True, mist=False", 'flood=True, mist=False, tool_change_position_mode="preserve_tip"',
                    "Post fanuc_lathe sets tool_change_position_mode itself"),
        "faster": ("flood=True, mist=False", "flood=True, mist=False, max_spindle_rpm=6000", "disagrees with the shop"),
        "missing": (", arcs=True", "", "arcs"),
    }
    for name, (old, new, message) in cases.items():
        refused = variant(client, f"shaft_{name}", "shaft", _replaced(old, new), mode="preview")
        assert refused["ok"] is False and message in refused["program_error"], (name, refused["program_error"][-600:])


def test_the_shops_turning_tools_map_field_for_field():
    import camlib

    from camlib_ui.program import ShopMappingError, station, tool
    from camlib_ui.shop import Shop, TurningHolder, TurningInsert, TurningTool, Turret
    shop = Shop()
    holder = TurningHolder.rectangle(width=25, length=150, offset=0, y=(-25, 3))
    turn = shop.add(TurningTool("turn", "CCMT", side="outer", hand="right", holder=holder, seat=(0, 0),
                                insert=TurningInsert.iso_code("CCMT120408", holder="SCLCR2525M12")))
    bar = shop.add(TurningTool("bar", "Boring bar", side="inner", hand="right", seat=(0, 0), insert_thickness=1.5,
                               insert_clearance=11, holder=TurningHolder.rectangle(width=10, length=80, offset=1, y=(-1.5, 1)),
                               insert=TurningInsert.iso(included_angle=55, approach_angle=95, edge_length=6, nose_radius=0.4)))
    blade = shop.add(TurningTool("blade", "Blade", side="outer", hand="right", seat=(0, 0), insert_thickness=3,
                                 insert_clearance=7, holder=TurningHolder.rectangle(width=2, length=60, offset=0, y=(-10, 2)),
                                 insert=TurningInsert.groove(width=2, depth=22)))
    turret = shop.add(Turret("turret", "Turret", tools={1: turn, 4: (bar, {"offset": 14})}))
    mapped = tool(shop.turn)
    assert isinstance(mapped, camlib.TurningTool) and mapped.id == "turn" and mapped.nose_radius_mm == 0.8
    assert (mapped.side, mapped.hand, mapped.seat) == ("outer", "right", camlib.TurningSeat(0, 0))
    # The ISO code's own thickness, clearance and size tolerance (camlib's), not values of ours.
    code = camlib.TurningInsert.iso_code("CCMT120408", holder="SCLCR2525M12")
    assert (mapped.insert_thickness_mm, mapped.insert_clearance_deg) == (code.thickness_mm, code.clearance_deg)
    assert mapped.holder.y_mm == (-25, 3)
    inner = tool(shop.bar)
    assert inner.side == "inner" and inner.insert_thickness_mm == 1.5 and inner.insert_clearance_deg == 11
    assert station(turret, mapped) == camlib.TurnToolSetting(mapped, 1, 1)
    assert station(turret, inner) == camlib.TurnToolSetting(inner, 4, 14)
    # A blade states its corner radius: nothing stands in for it. A tool the turret doesn't hold has no station.
    with pytest.raises(ShopMappingError, match="blade has no nose_radius_mm"):
        tool(blade)
    stray = camlib.TurningTool("stray", insert=inner.insert, side="inner", hand="right", holder=inner.holder,
                               seat=inner.seat, insert_thickness_mm=1.5, insert_clearance_deg=11)
    with pytest.raises(ShopMappingError, match="holds tool stray 0 times"):
        station(turret, stray)


def test_a_lathe_model_is_what_the_shop_states():
    from camlib_ui.shop import MachineModel
    model = MachineModel.lathe("m", "Lathe", x_travel=(0, 150), z_travel=(-400, 50), max_rpm=4000, stations=8, rapid=8000)
    d = model.definition
    assert d["processes"] == ["turning"] and [n["id"] for n in d["nodes"]] == ["base", "Z", "X"]
    assert d["spindles"][0]["max_rpm"] == 4000 and len(d["tool_change"]["stations"]) == 8
    with pytest.raises(ValueError, match="min below max"):
        MachineModel.lathe("m", "Lathe", x_travel=(150, 0), z_travel=(-400, 50), max_rpm=4000, stations=8, rapid=8000)


# ── The forms on a lathe program ──────────────────────────────────────────

def test_camlibs_turning_fields_are_what_the_forms_show():
    from camlib_ui import forms
    fields = forms.operation_fields()
    assert set(forms.TURNING) <= set(fields)
    finish = {name: (kind, default, keyword) for name, kind, default, keyword in fields["TurnFinish"]}
    # No default for the feed or the speed (camlib requires them); camlib's own default elsewhere.
    assert finish["feed_mm_rev"] == ("float", None, True) and finish["rpm"] == ("float", None, True)
    assert finish["allowance_mm"][1] == "0" and finish["compensation"][1] == "'computer'"
    assert [name for name, *_ in fields["TurnThread"]][:7] == ["id", "tool", "z_start_mm", "z_end_mm", "major_radius_mm",
                                                               "pitch_mm", "depth_mm"]


@needs_posts
def test_what_the_forms_write_for_a_lathe_builds(client, tmp_path):
    import json
    import os
    import shutil
    import subprocess
    from pathlib import Path

    from camlib_ui import forms
    if shutil.which("node") is None:
        pytest.skip("Node isn't installed")
    root = Path(__file__).resolve().parent.parent
    code = (root / "camlib_ui" / "examples" / "shaft" / "program.py").read_text()
    # The same program without its parting tool: the form then adds the tool, its station and the operation.
    bare = code
    for old, new in ((", part_off = tool(shop.t_rough), tool(shop.t_finish), tool(shop.t_thread), tool(shop.t_part)",
                      " = tool(shop.t_rough), tool(shop.t_finish), tool(shop.t_thread)"),
                     ("station(shop.turret, thread),\n                     station(shop.turret, part_off)),",
                      "station(shop.turret, thread)),"),
                     ('    TurnPartOff("part_off", "t_part", z_mm=-40, feed_mm_rev=0.05, rpm=800),\n', ""),
                     ("TurnFinish, TurnPartOff, TurnRough", "TurnFinish, TurnRough")):
        assert old in bare, old
        bare = bare.replace(old, new)
    data = {"code": code, "outline": forms.outline(code), "fields": forms.operation_fields(),
            "bare": {"code": bare, "outline": forms.outline(bare)}}
    (tmp_path / "input.json").write_text(json.dumps(data))
    out = tmp_path / "out"
    out.mkdir()
    run = subprocess.run(["node", "--test", "tests/turning.test.ts"], cwd=root / "web", capture_output=True, text=True, timeout=120,
                         env={**os.environ, "CAMLIB_UI_TURNING": str(tmp_path / "input.json"), "CAMLIB_UI_FORMS_OUT": str(out)})
    assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-4000:]
    assert "✔ the shaft program read, edited and written back" in run.stdout and "skipped 0" in run.stdout
    written = {path.stem: path.read_text() for path in out.glob("*.py")}
    assert set(written) == {"edited", "added", "parted", "duplicated", "deleted"}
    # camlib builds every program the forms wrote: the added and re-added operations are planned and released.
    expected = {"edited": OPERATIONS, "added": ["face", "rough", "finish", "spring", "thread", "part_off"], "parted": OPERATIONS,
                "duplicated": ["face", "rough", "finish", "finish_2", "thread", "part_off"],
                "deleted": ["face", "rough", "finish", "part_off"]}
    for name, text in written.items():
        project = f"shaft_form_{name}"
        assert client.post("/api/projects", json={"name": project, "example": "shaft"}).status_code == 200
        assert client.put(f"/api/projects/{project}/files/program.py", content=text.encode()).status_code == 200
        done = build(client, project)
        assert done["ok"] and done["released"] == 1, (name, done.get("program_error"))
        assert [op["id"] for op in done["metadata"]["setups"][0]["operations"]] == expected[name], name
