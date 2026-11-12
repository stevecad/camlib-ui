"""What camlib plans, checks and reports, end to end through the API: the cover example (an adaptive pocket that follows
the stock, a ramp entry, tabs at points) with camlib's own report of each operation; each tool checked against its own
travel; a tool change in place; a supplied toolpath; the part's outline at a depth; and camlib's refusals, shown as it
worded them."""
from __future__ import annotations

import json
import math

from camlib_ui import stream
from camlib_ui.build.run import REPORT_CUT, bounded_report

from conftest import variant


def _replaced(old: str, new: str, count: int = 1):
    def change(text: str) -> str:
        assert text.count(old) == count, f"{old!r} is in the program {text.count(old)} times"
        return text.replace(old, new)
    return change


def _all(*changes):
    def change(text: str) -> str:
        for item in changes:
            text = item(text)
        return text
    return change


def test_the_cover_is_released_with_camlibs_reports(client, cover):
    assert cover["status"] == "done" and cover["ok"] and cover["released"] == 1 and cover["refused"] == 0
    (setup,) = cover["metadata"]["setups"]
    (machine,) = setup["machines"]
    assert machine["finding_counts"] == {} and machine["accepted"] == ["unchecked_machine"]
    # Said, not hidden: the tabs are left on purpose, so the program runs no material check; it places no fixture.
    assert set(machine["unchecked"]) == {"material", "machine", "fixtures (no fixtures declared)"}
    pocket, recess, outline = setup["operations"]
    assert [op["id"] for op in setup["operations"]] == ["pocket", "recess", "outline"]
    # The adaptive pocket on camlib's default planner: its report, as camlib gave it, proves each level's engagement.
    report = pocket["report"]
    assert report["clearing"] == "engagement_front" and len(report["layers"]) == 2
    for layer in report["layers"]:
        clearing = layer["clearing"]
        assert 0 < clearing["proven_max_engagement_deg"] <= clearing["engagement_limit_deg"] + 1e-9
        assert clearing["wall_passes"] >= 1 and clearing["engagement_proved_strokes"] > 0
    # 1.5 mm on a 6 mm cutter: acos(1 - 1.5 / 3) = 60 degrees.
    assert abs(report["layers"][0]["clearing"]["engagement_limit_deg"] - math.degrees(math.acos(0.5))) < 1e-6
    # The recess is entered by ramps no steeper than the program's 3 degrees.
    assert recess["report"]["ramp_entries"] >= 1 and recess["report"]["helical_entries"] == 0
    assert 0 < recess["report"]["max_ramp_angle_deg"] <= 3 + 1e-9
    assert outline["report"]["strategy"] == "contour" and outline["report"]["loops"] == 1


def test_the_covers_tabs_are_in_the_playback(client, cover):
    """The outline's last passes rise over each tab (1.5 mm above the floor) at the four points the program gives."""
    reader = stream.Reader(client.get(cover["files"]["cam-playback.bin"]).content)
    (setup,) = reader.setups()
    assert setup["restarts"] == []
    index = [op["id"] for op in setup["operations"]].index("outline")
    moves = [m for chunk in setup["chunks"] for m in reader.moves(setup, chunk) if m["operation"] == index]
    tops = [m["end"] for m in moves if m["feed_mm_min"] is not None and abs(m["end"][2] - 1.5) < 1e-6]
    assert tops, "no move of the outline ends at the tabs' height"
    points = [(45, 0), (90, 25), (45, 50), (0, 25)]
    # The tool centre runs its radius (3 mm) and the contour's small margin outside the outline: within 3.5 mm + half a tab.
    near = lambda end, point: math.hypot(end[0] - point[0], end[1] - point[1]) < 3.5 + 3 + 1.5
    assert all(any(near(end, point) for end in tops) for point in points)
    assert all(any(near(end, point) for point in points) for end in tops)


def test_each_tool_is_checked_against_its_own_travel(client):
    """The machine's Z travel is its spindle gauge line's. With the work zero at machine Z -190 the 10 mm end mill
    starts with its tip at -130: inside its own travel (up to -115, its gauge length below the top), though above what
    the longest tool (the drill, -140) could reach. camlib checks each tool against its own travel, so it is released."""
    done = variant(client, "travel_ok", "plate", _replaced("WorkFrame((200, 150, -300))", "WorkFrame((200, 150, -190))"))
    assert done["ok"] and done["released"] == 1, done.get("program_error")
    scene = done["metadata"]["setups"][0]["machines"][0]["scene"]
    assert scene["travel_mm"] == [[0, 0, -400], [500, 400, 0]]
    assert {tool: box[1][2] for tool, box in scene["tool_tip_travel_mm"].items()} == {"t_em10": -115, "t_em6": -100, "t_drill": -140}
    # At -110 the same tool starts above its own travel: refused, and the finding names the tool and its limit.
    done = variant(client, "travel_out", "plate", _replaced("WorkFrame((200, 150, -300))", "WorkFrame((200, 150, -110))"))
    assert done["ok"] and done["released"] == 0 and done["refused"] == 1
    machine = done["metadata"]["setups"][0]["machines"][0]
    assert machine["gcode"] is None and machine["finding_counts"].get("violation", 0) > 0
    first = machine["findings"][0]["details"][0]
    assert first["kind"] == "machine_travel" and "t_em10" in first["detail"] and "-115" in first["detail"]


IN_PLACE = _all(_replaced('tool_change_position_mode="preserve_tip"', 'tool_change_position_mode="preserve_spindle"'),
                _replaced("from camlib import Contour,", "from camlib import ToolChangeInPlace, Contour,"))


def _two_operations(text: str) -> str:
    """The plate's facing and pocket only (the longer tool first), without the material check they wouldn't pass alone."""
    start, end = text.index('    Contour("outline"'), text.index(")\nsetup = Setup(")
    text = text[:start] + text[end:]
    return _all(_replaced(", material=(protect_part,)", ""), _replaced("(mill10, mill6, drill), ops", "(mill10, mill6), ops"))(text)


def test_a_tool_change_in_place_moves_the_tip_without_a_move(client):
    """The spindle stays at a tool change, so the shorter tool's tip is 15 mm higher (gauge lengths 115 and 100 mm). The
    playback stream says where the next move starts; nothing joins it to the last move's end."""
    done = variant(client, "in_place", "plate", _all(IN_PLACE, _two_operations, _replaced(
        "verification=StreamChecks(", "tool_change=ToolChangeInPlace(), verification=StreamChecks(")))
    assert done["ok"] and done["released"] == 1, done.get("program_error")
    data = client.get(done["files"]["cam-playback.bin"]).content
    assert stream.check(data)["setups"][0]["restarts"] == 1
    reader = stream.Reader(data)
    (setup,) = reader.setups()
    ((move, x, y, z),) = setup["restarts"]
    moves = [m for chunk in setup["chunks"] for m in reader.moves(setup, chunk)]
    before = moves[move - 1]
    assert moves[move]["tool"] != before["tool"]
    assert (x, y) == before["end"][:2] and abs(z - (before["end"][2] + 15)) < 1e-9


def test_camlibs_refusals_are_shown_as_it_worded_them(client):
    # The machine changes tools in place but the setup isn't planned that way: camlib refuses the pair and says what to do.
    half = variant(client, "in_place_half", "plate", _replaced('tool_change_position_mode="preserve_tip"',
                                                             'tool_change_position_mode="preserve_spindle"'))
    assert half["status"] == "done" and half["ok"] is False and half["files"] == {}
    assert "plan with Setup(tool_change=ToolChangeInPlace())" in half["program_error"]
    # An orbit option on the planner that follows the stock.
    orbit = variant(client, "orbit", "cover", _replaced("stepover_mm=1.5, clearance_z_mm=20,",
                                                         "stepover_mm=1.5, clearance_z_mm=20, orbit_radius_mm=1,"))
    assert orbit["ok"] is False and orbit["files"] == {}
    assert "engagement_front does not use orbits; leave orbit_radius_mm" in orbit["program_error"]
    # A tab point off the outline.
    off = variant(client, "tab_off", "cover", _replaced("(45, 0), (90, 25)", "(45, 0.5), (90, 25)"))
    assert off["ok"] is False and off["files"] == {}
    assert "tab" in off["program_error"] and "position_tolerance_mm" in off["program_error"]


SUPPLIED = """    SuppliedToolpath("mark", mill6, (
        ToolpathMove("plunge", Line((40, 30, 30), (40, 30, 19)), 300),
        ToolpathMove("cut", Line((40, 30, 19), (60, 30, 19)), 600),
        ToolpathMove("cut", Arc((60, 30, 19), (60, 34, 19), (60, 32, 19), math.pi), 600),
        ToolpathMove("retract", Line((60, 34, 19), (60, 34, 30)), 600)),
        clearance_z_mm=30, spindle_rpm=11000, coolant="flood", **slot(shop.rack, mill6)),
"""


def test_a_supplied_toolpath_is_run_and_checked(client):
    """Moves the program supplies (camlib's SuppliedToolpath), here a short cut inside the pocket before it is cleared:
    they are simulated, checked, posted and played back as given, the arc as an arc."""
    done = variant(client, "supplied", "plate", _all(
        _replaced("from camlib import Contour,", "from camlib import SuppliedToolpath, ToolpathMove, Contour,"),
        _replaced("import math\n", "import math\n\nfrom camlib.motion import Arc, Line\n"),
        _replaced('    Pocket("pocket"', SUPPLIED + '    Pocket("pocket"')))
    assert done["ok"] and done["released"] == 1, done.get("program_error") or done["metadata"]["setups"][0]["machines"][0]["refused"]
    (setup,) = done["metadata"]["setups"]
    assert [op["id"] for op in setup["operations"]] == ["face", "mark", "pocket", "outline", "holes"]
    reader = stream.Reader(client.get(done["files"]["cam-playback.bin"]).content)
    (played,) = reader.setups()
    mine = [m for chunk in played["chunks"] for m in reader.moves(played, chunk) if m["operation"] == 1]
    assert len(mine) == setup["operations"][1]["moves"]
    (arc,) = [m for m in mine if m["curve"] == "arc"]
    assert arc["end"] == (60, 34, 19) and arc["center"] == (60, 32, 19) and arc["plane"] == "xy"
    assert abs(arc["sweep_rad"] - math.pi) < 1e-6
    # The same cut 0.5 mm into the finished top beside the pocket is a gouge: camlib refuses the program.
    gouged = variant(client, "supplied_gouge", "plate", _all(
        _replaced("from camlib import Contour,", "from camlib import SuppliedToolpath, ToolpathMove, Contour,"),
        _replaced("import math\n", "import math\n\nfrom camlib.motion import Arc, Line\n"),
        _replaced('    Pocket("pocket"', SUPPLIED.replace(", 30, ", ", 5, ").replace("(60, 34, ", "(60, 9, ").replace("(60, 32, ", "(60, 7, ")
                  .replace(", 19)", ", 19.5)") + '    Pocket("pocket"')))
    assert gouged["ok"] and gouged["released"] == 0 and gouged["refused"] == 1
    assert gouged["metadata"]["setups"][0]["machines"][0]["refused_kinds"] == ["violation"]


def test_the_parts_outline_at_a_depth(client):
    """silhouette(part, z, max_error_mm=...): camlib's silhouette of the part's mesh, as the region of a contour."""
    done = variant(client, "silhouette", "cover", _all(
        _replaced('outline = region(part, "bottom", name="outline")', 'outline = silhouette(part, 0, max_error_mm=0.003, name="outline")'),
        _replaced("import Program, machine, region, slot, tool", "import Program, machine, region, silhouette, slot, tool")))
    assert done["ok"] and done["released"] == 1, done.get("program_error")
    assert done["metadata"]["setups"][0]["operations"][2]["report"]["loops"] == 1
    # camlib refuses an outline it can't give within the error asked for, and says so.
    fine = variant(client, "silhouette_fine", "cover", _all(
        _replaced('outline = region(part, "bottom", name="outline")', 'outline = silhouette(part, 0, max_error_mm=0.0001, name="outline")'),
        _replaced("import Program, machine, region, slot, tool", "import Program, machine, region, silhouette, slot, tool")), mode="preview")
    assert fine["ok"] is False and "max_error_mm" in fine["program_error"]


def test_a_long_report_is_cut_where_it_says():
    small = {"strategy": "x", "layers": [{"tip_z_mm": 1.0, "diagnostics": ["a"]}], "missing": None}
    assert bounded_report(small) == small
    assert bounded_report(None) is None and bounded_report("text") is None
    long = {"strokes": [{"index": i, "note": "n" * 50} for i in range(5000)], "kept": 1}
    cut = bounded_report(long, limit=20_000)
    assert cut["kept"] == 1 and len(json.dumps(cut)) <= 20_000
    assert cut["strokes"][-1] == {REPORT_CUT: f"{5000 - (len(cut['strokes']) - 1)} more of 5000 not listed"}
    assert cut["strokes"][0] == long["strokes"][0]
    assert bounded_report({"a": float("inf")}) == {"a": "inf"}
    assert bounded_report({"text": "x" * 100_000}, limit=10_000)["text"].endswith("more characters)")
    assert bounded_report({"text": "x" * 100_000}, limit=50) == {REPORT_CUT: "the report is over 50 bytes even cut short: not listed"}
