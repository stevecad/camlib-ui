"""Plasma cutting end to end through the API: the sheet example (a nest of two parts, cut with a torch, posted with
camlib's QtPlasmaC post) released, its kerfs in the playback stream's stock, what the shop's table and recipe map to,
and what camlib and the helpers refuse."""
from __future__ import annotations

import pytest

from camlib_ui import stream

from conftest import build, needs_posts, variant


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
