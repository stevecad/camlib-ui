"""Plasma cutting end to end through the API: the sheet example (a nest of two parts, cut with a torch, posted with
camlib's QtPlasmaC post) released, its kerfs in the playback stream's stock, what the shop's table and recipe map to,
and what camlib and the helpers refuse."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from camlib_ui import forms, stream

from conftest import build, edit, needs_posts, variant


def _replaced(old, new):
    def change(text):
        assert old in text, old
        return text.replace(old, new)
    return change


@pytest.fixture(scope="module")
def sheet(client) -> dict:
    """The sheet example, built in full."""
    from conftest import POSTS
    if POSTS is None:
        pytest.skip("camlib's controller posts aren't there (CAMLIB_POSTS)")
    return build(client, "sheet")


def test_the_sheet_is_released(sheet):
    assert sheet["status"] == "done" and sheet["ok"] and sheet["released"] == 1 and sheet["refused"] == 0, sheet.get("program_error")
    (setup,) = sheet["metadata"]["setups"]
    (machine,) = setup["machines"]
    assert machine["post"] == "qtplasmac" and machine["gcode"] == "gcode-1.nc" and machine["finding_counts"] == {}
    # Every move was checked against the torch's travel and the sheet; no fixture or material target is declared.
    assert machine["checks"]["progress"]["clear"] == machine["moves"]
    assert machine["unchecked"] == ["material", "machine", "fixtures (no fixtures declared)"]
    (op,) = setup["operations"]
    report = op["report"]
    # camlib's own report of the cut: 14 parts, each loop pierced once (6 brackets with 4 holes, 8 washers with 1).
    assert report["parts"] == 14 and report["pierces"] == 6 * 5 + 8 * 2 and report["kerf_mm"] == 1.5
    assert report["small_holes"] == 12   # the brackets' 6 mm holes: up to 1.5 x the 6 mm sheet


def test_the_torchs_gcode_is_qtplasmacs(client, sheet):
    lines = client.get(sheet["files"]["gcode-1.nc"]).text.splitlines()
    assert lines[:8] == ["G21", "G90", "G17", "G94", "G40", "G49", "G80", "G92.1"] and "M52 P1" in lines and "G64 P0.005" in lines
    assert "T0 M6" in lines and "G43 H0" in lines
    # One torch-on and one torch-off per pierce; height control on and off round each loop.
    pierces = sheet["metadata"]["setups"][0]["operations"][0]["report"]["pierces"]
    assert lines.count("M3 $0 S1") == pierces and lines.count("M5 $0") == pierces
    assert "M63 P2" in lines and "M62 P2" in lines
    # QtPlasmaC owns Z: the program holds one height.
    heights = {word for line in lines for word in line.split(" ") if word.startswith("Z")}
    assert len(heights) == 1


def test_the_stream_shows_the_kerfs(client, sheet):
    data = client.get(sheet["files"]["cam-playback.bin"]).content
    stream.check(data)
    reader = stream.Reader(data)
    (setup,) = reader.setups()
    stock = setup["stock"]
    assert (stock["nx"], stock["ny"]) == (1000, 600) and stock.get("kind") is None
    machine = sheet["metadata"]["setups"][0]["machines"][0]
    upper, lower = stream.volume(setup, reader.stock_at(setup, setup["moves"]))
    assert abs(upper - machine["stock_remaining_mm3"]["upper"]) < 1 and abs(lower - machine["stock_remaining_mm3"]["lower"]) < 1
    # The sheet is cut through along every kerf (cells at the sheet's bottom), and nowhere before the first move.
    full = 500 * 300 * 6
    assert stream.volume(setup, reader.stock_at(setup, 0)) == (full, full)
    # About 4 m of 1.5 mm kerf through 6 mm: at least 15 cm³ is certainly gone, and no more than the kerf's own volume
    # plus the cells it only touches.
    cut_mm = sheet["metadata"]["setups"][0]["operations"][0]["cut_mm"]
    assert 15000 < full - upper < full - lower < 2 * cut_mm * 1.5 * 6
    kinds = {m["kind"] for chunk in setup["chunks"] for m in reader.moves(setup, chunk)}
    assert kinds == {"rapid", "lead", "cut"}
    (tool,) = setup["tools"]
    assert tool["id"] == "torch" and tool["shape"] == {"kind": "beam"} and tool["diameter_mm"] == 1.5


@needs_posts
def test_camlib_refuses_a_nest_that_does_not_fit(client):
    refused = variant(client, "sheet_small", "sheet", _replaced("rectangle(0, 0, 500, 300)", "rectangle(0, 0, 300, 200)"), mode="preview")
    assert refused["ok"] is False and "do not fit on the sheet" in refused["program_error"]


@needs_posts
def test_a_sheet_outside_the_tables_travel_is_refused(client):
    # The sheet's zero 60 mm below the head mount's top: the torch (135 mm long) can't reach down to it.
    refused = variant(client, "sheet_high", "sheet", _replaced("WorkFrame((100, 100, -190))", "WorkFrame((100, 100, -60))"))
    assert refused["ok"] and refused["released"] == 0 and refused["refused"] == 1
    machine = refused["metadata"]["setups"][0]["machines"][0]
    assert machine["finding_counts"] == {"violation": machine["moves"]}
    assert machine["findings"][0]["details"][0]["kind"] == "machine_travel"


@needs_posts
def test_what_a_cutting_machine_refuses(client):
    cases = {
        "heights": ('height_mode="fixed"', 'height_mode="program"', "plan with height_mode='fixed'"),
        "tooling": ("machine(shop.table, setup, ", "machine(shop.table, setup, tooling=shop.table, ", "give no tooling="),
        "coolant": ("arcs=True, helices=False", "arcs=True, helices=False, flood=False", "Post qtplasmac sets flood itself"),
    }
    for name, (old, new, message) in cases.items():
        refused = variant(client, f"sheet_{name}", "sheet", _replaced(old, new), mode="preview")
        assert refused["ok"] is False and message in refused["program_error"], (name, refused["program_error"][-600:])


def test_the_shops_table_and_recipe_map_to_camlibs_torch():
    import camlib

    from camlib_ui.program import ShopMappingError, cutting, head
    from camlib_ui.shop import Controller, CuttingHead, CuttingRecipe, Machine, MachineModel, Shop
    shop = Shop()
    model = shop.add(MachineModel.table("m", "Table", travel=(1300, 650, 100), rapid=15000,
                                        head=CuttingHead.plasma("torch", nozzle_diameter=12, nozzle_length=20,
                                                                body_diameter=35, body_length=120)))
    control = shop.add(Controller("c", "Generic", dialect="none_v1", processes=("plasma",)))
    table = shop.add(Machine("table", "Table", model=model, controller=control))
    recipe = shop.add(CuttingRecipe("steel6", "6 mm steel", process="plasma", kerf=1.5, feed=2500, cut_height=1.5,
                                    pierce_seconds=0.5, pierce_radius=2.25, lead_in=2, lead_out=1))
    torch = head(table, recipe)
    assert torch.id == "torch"
    assert camlib.Torch("torch", kerf_width=1.5, nozzle_diameter=12, nozzle_length=20, body_diameter=35, body_length=120,
                        name="torch") == torch
    values = cutting(recipe, table, height_mode="fixed", lead_in_radius_mm=3, lead_out_radius_mm=2)
    assert values == dict(feed_mm_min=2500, cut_height_mm=1.5, pierce_delay_s=0.5, pierce_clearance_mm=1.5,
                          lead_in=camlib.Lead(2, 3), lead_out=camlib.Lead(1, 2), height_mode="fixed", power_percent=100)
    # The program moving Z itself needs the recipe's pierce height and travel height: none is assumed.
    with pytest.raises(ShopMappingError, match="steel6 has no pierce_height_mm, clearance_mm"):
        cutting(recipe, table, height_mode="program", lead_in_radius_mm=3, lead_out_radius_mm=2)
    laser = shop.add(CuttingRecipe("ply3", "3 mm plywood", process="laser", kerf=0.2, feed=600, cut_height=0, pierce_seconds=0,
                                   pierce_radius=0.3, lead_in=1, lead_out=0, power_w=30))
    with pytest.raises(ShopMappingError, match="ply3 is for laser; the head cuts plasma"):
        head(table, laser)
    d = model.definition
    assert d["processes"] == ["plasma"] and d["cutting_heads"][0]["attachment"] == "head_mount"
    assert [n["limits"]["maximum"] for n in d["nodes"][1:]] == [1300, 650, 0]


@needs_posts
@pytest.mark.skipif(shutil.which("node") is None, reason="Node isn't installed")
def test_the_cutting_forms_read_write_and_build(client, tmp_path):
    """web/tests/thermal.test.ts on the sheet example: the cut reads into its form through its `**plan` and the shop's
    recipe; with micro-joints added, with a crop cut added, with corner loops, a corner slow-down and leads at corners added, with chain cutting added, and with a mark added before it, camlib builds and releases what the forms wrote."""
    root = Path(__file__).resolve().parent.parent
    code = (root / "camlib_ui" / "examples" / "sheet" / "program.py").read_text()
    (tmp_path / "input.json").write_text(json.dumps({"code": code, "outline": forms.outline(code), "fields": forms.operation_fields()}))
    out = tmp_path / "out"
    out.mkdir()
    run = subprocess.run(["node", "--test", "tests/thermal.test.ts"], cwd=root / "web", capture_output=True, text=True, timeout=120,
                         env={**os.environ, "CAMLIB_UI_THERMAL": str(tmp_path / "input.json"), "CAMLIB_UI_FORMS_OUT": str(out)})
    assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-4000:]
    assert "✔ the sheet program’s cut read, edited and written back" in run.stdout
    for name in ("joints", "cropped", "cornered", "chained", "marked"):
        text = (out / f"{name}.py").read_text()
        if name == "marked":
            # How this machine marks is its own (QtPlasmaC: two entries of its material file); the program states it.
            assert "blend_mm=0.005)" in text
            unmarked = variant(client, "sheet_form_unmarked", "sheet", lambda _old, text=text: text)
            assert "declares no marking" in json.dumps(unmarked)
            text = text.replace("blend_mm=0.005)", "blend_mm=0.005, mark_material=2, cut_material=1, material_wait_s=2)")
        built = variant(client, f"sheet_form_{name}", "sheet", lambda _old, text=text: text)
        assert built["status"] == "done" and built["ok"], f"{name}:\n{built.get('program_error')}"
        assert built["released"] == 1 and built["refused"] == 0, f"{name}: {json.dumps(built['metadata']['setups'][0]['machines'], indent=1)[:3000]}"
        operations = built["metadata"]["setups"][0]["operations"]
        if name == "joints":
            assert operations[0]["report"]["micro_joints"] > 0
        elif name == "cropped":
            assert operations[0]["report"]["crop_length_mm"] == 300
        elif name == "cornered":
            # Six brackets: a loop at each corner but the one its lead is sent to (the cut starts and ends there, so
            # nothing turns it); every other corner has a loop, which leaves none to slow down for.
            report = operations[0]["report"]
            assert (report["corner_loops"], report["corner_slowdowns"], report["leads_moved"]) == (18, 0, 6)
        elif name == "chained":
            # Fewer pierces than loops: outlines reached through a link need none.
            report = operations[0]["report"]
            assert report["chain_links"] > 0
            assert report["pierces"] == report["loops"] - report["chain_links"]
        else:
            assert [op["id"] for op in operations] == ["mark", "cut"]


@needs_posts
@pytest.mark.skipif(shutil.which("node") is None, reason="Node isn't installed")
def test_dxf_parts_nest_from_a_corner_and_the_remnant_comes_out(client, tmp_path):
    """The nest example: parts read from its DXF drawing, nested, cut with rapids kept off freed parts, released; the
    build hands out remnant.dxf, which reads back as one sheet clear of the parts. Then web/tests/nest.test.ts edits
    the nest through its form (start corner, fill axis, a quantity, rotations) and camlib releases that too, with the
    parts at the other end of the sheet."""
    from camlib.dxf import read_parts

    root = Path(__file__).resolve().parent.parent
    built = build(client, "nest")   # the examples are the root's first projects
    assert built["status"] == "done" and built["ok"], built.get("program_error")
    assert built["released"] == 1 and built["refused"] == 0, json.dumps(built["metadata"]["setups"][0]["machines"])[:3000]
    report = built["metadata"]["setups"][0]["operations"][0]["report"]
    assert report["parts"] == 15 and report["part_order"] == {"kind": "spread", "min_distance_mm": 120}
    assert report["rerouted_rapids"] >= 0 and report["min_part_step_mm"] > 0
    assert "remnant.dxf" in built["files"]
    (tmp_path / "remnant.dxf").write_bytes(client.get(built["files"]["remnant.dxf"]).content)
    (remnant,) = read_parts(tmp_path / "remnant.dxf", unit_mm=1, join_tolerance_mm=1e-6)
    xs = [v[0] for v in remnant.components[0].outer.vertices]
    assert min(xs) >= 0 and max(xs) <= 500

    code = (root / "camlib_ui" / "examples" / "nest" / "program.py").read_text()
    (tmp_path / "input.json").write_text(json.dumps({"code": code, "outline": forms.outline(code), "fields": forms.operation_fields()}))
    out = tmp_path / "out"
    out.mkdir()
    run = subprocess.run(["node", "--test", "tests/nest.test.ts"], cwd=root / "web", capture_output=True, text=True, timeout=120,
                         env={**os.environ, "CAMLIB_UI_NEST": str(tmp_path / "input.json"), "CAMLIB_UI_FORMS_OUT": str(out)})
    assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-4000:]
    assert "✔ the nest read, edited and written back" in run.stdout
    text = (out / "nest_edited.py").read_text()
    edited = variant(client, "nest_edited", "nest", lambda _old: text)
    assert edited["status"] == "done" and edited["ok"], edited.get("program_error")
    assert edited["released"] == 1 and edited["refused"] == 0
    assert edited["metadata"]["setups"][0]["operations"][0]["report"]["parts"] == 14
    (tmp_path / "edited.dxf").write_bytes(client.get(edited["files"]["remnant.dxf"]).content)
    (left,) = read_parts(tmp_path / "edited.dxf", unit_mm=1, join_tolerance_mm=1e-6)

    def free(region, p):
        """Whether a point is in the remnant (its outline's and holes' corners as polygons)."""
        def within(boundary):
            inside, v = False, boundary.vertices
            for a, b in zip(v, v[1:] + v[:1]):
                if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]):
                    inside = not inside
            return inside
        (component,) = region.components
        return within(component.outer) and not any(within(hole) for hole in component.holes)

    # Nested from the lower left the parts cover (40, 40) and (460, 260) is left; from the upper right it is the reverse.
    assert not free(remnant, (40, 40)) and free(remnant, (460, 260))
    assert free(left, (40, 40)) and not free(left, (460, 260))


@needs_posts
def test_a_wincnc_table_that_runs_in_inches(client):
    """The nest example on a WinCNC control set to inches (a ShopSabre table's setup): the shop states inch output and
    the control's resolution in inches, WinCNC's own material setup owns the pierce, the heights and height control, and
    the program is released in inches (G20, four decimals) with its half-turn arcs still arcs or checked lines."""
    assert client.post("/api/projects", json={"name": "nest_inch", "example": "nest"}).status_code == 200
    edit(client, "nest_inch", "shop.py", _replaced(
        'Controller("control", "LinuxCNC QtPlasmaC", dialect="linuxcnc_qtplasmac_v1", processes=("plasma",),\n'
        '                              linear_resolution_mm=0.001)',
        'Controller("control", "WinCNC", dialect="wincnc_plasma_v1", processes=("plasma",),\n'
        '                              output_units="inch", linear_resolution_in=0.0001)'))
    program = [
        ("plan = dict(overcut_mm=-0.5, height_control=True, small_holes=SmallHoles(feed_percent=60),",
         "plan = dict(overcut_mm=-0.5, small_holes=SmallHoles(feed_percent=60, height_control_off=False),"),
        ("(torch,), ops, (0, 0, 40),", "(torch,), ops, (0, 0, THICKNESS + 1.5),"),
        ('arcs=True, helices=False, planes=("xy",), max_sweep_rad=math.tau, max_tool_number=1, max_length_register=1,\n'
         '            blend_mm=0.005),',
         "arcs=True, helices=False, max_tool_number=1, max_length_register=1),"),
    ]

    def change(text):
        for old, new in program:
            assert old in text, old
            text = text.replace(old, new)
        return text

    edit(client, "nest_inch", "program.py", change)
    built = build(client, "nest_inch")
    assert built["status"] == "done" and built["ok"], built.get("program_error")
    machine = built["metadata"]["setups"][0]["machines"][0]
    assert built["released"] == 1 and machine["post"] == "wincnc_plasma", json.dumps(machine)[:2000]
    lines = client.get(built["files"]["gcode-1.nc"]).text.splitlines()
    assert lines[:2] == ["G90", "G20"] and "G22" not in lines
    xs = [float(word[1:]) for line in lines if line[:2] in ("G0", "G1", "G2", "G3") for word in line.split() if word[0] == "X"]
    # The sheet is 500 mm wide: 19.7 in. Every word is inches, at four decimals.
    assert xs and 0 < min(xs) and max(xs) < 19.7
    assert all(len(word.partition(".")[2]) <= 4 for line in lines if line[:1] == "G" for word in line.split() if word[0] in "XYIJ")
    assert sum(line[:2] in ("G2", "G3") for line in lines) > 20
    # A resolution in the wrong unit for the control is refused, naming the field.
    edit(client, "nest_inch", "shop.py", _replaced("linear_resolution_in=0.0001", "linear_resolution_mm=0.001"))
    refused = build(client, "nest_inch", "preview")
    assert refused["ok"] is False and "linear_resolution_in" in refused["program_error"]
