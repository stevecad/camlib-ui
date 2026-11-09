"""Builds end to end through the API: the plate example released, refused once its acceptance is taken out, a program
error with its traceback, a preview, and the files a build serves (G-code, the playback stream by ranges, sources)."""
from __future__ import annotations

from camlib_ui import stream

from conftest import build, edit


def test_the_plate_is_released(plate):
    assert plate["status"] == "done" and plate["ok"] and plate["released"] == 1 and plate["refused"] == 0
    metadata = plate["metadata"]
    (setup,) = metadata["setups"]
    (machine,) = setup["machines"]
    assert machine["gcode"] == "gcode-1.nc" and machine["refused"] is None
    assert machine["finding_counts"] == {} and machine["accepted"] == ["unchecked_machine"]
    assert machine["checks"]["progress"]["clear"] == machine["moves"]
    assert [op["id"] for op in setup["operations"]] == ["face", "pocket", "outline", "holes"]
    assert sum(op["moves"] for op in setup["operations"]) == machine["moves"]
    assert set(plate["files"]) == {"cam-playback.bin", "gcode-1.nc"}
    # The program as compiled, with its machine's scene (the vise's three bodies, placed by the program).
    (described,) = metadata["program"]["setups"]
    assert described["stock"] == {"min_mm": [-5, -5, -6], "max_mm": [105, 65, 21], "cell_size_mm": 0.5}
    assert described["machines"][0]["scene"]["fixtures"] == ["vise_base", "vise_jaw_fixed", "vise_jaw_moving"]


def test_the_gcode_is_served(client, plate):
    response = client.get(plate["files"]["gcode-1.nc"])
    assert response.status_code == 200
    lines = response.text.splitlines()
    assert lines[0] == "G21" and "M6" in lines and len(lines) == plate["metadata"]["setups"][0]["machines"][0]["lines"]
    response.content.decode("ascii")


def test_the_stream_matches_camlibs_stock(client, plate):
    data = client.get(plate["files"]["cam-playback.bin"]).content
    summary = stream.check(data)
    (setup_summary,) = summary["setups"]
    machine = plate["metadata"]["setups"][0]["machines"][0]
    assert setup_summary["moves"] == machine["moves"]
    reader = stream.Reader(data)
    (setup,) = reader.setups()
    stock = setup["stock"]
    full = (stock["max_mm"][0] - stock["min_mm"][0]) * (stock["max_mm"][1] - stock["min_mm"][1]) * (stock["max_mm"][2] - stock["min_mm"][2])
    assert stream.volume(setup, reader.stock_at(setup, 0)) == (full, full)
    upper, lower = stream.volume(setup, reader.stock_at(setup, setup["moves"]))
    assert abs(upper - machine["stock_remaining_mm3"]["upper"]) < 0.01
    assert abs(lower - machine["stock_remaining_mm3"]["lower"]) < 0.01
    # Every move's first G-code line is a line of the posted program, in order.
    lines = [m["line"] for chunk in setup["chunks"] for m in reader.moves(setup, chunk)]
    assert lines == sorted(lines) and lines[0] >= 1 and lines[-1] <= machine["lines"]


def test_the_stream_is_served_by_ranges(client, plate):
    url = plate["files"]["cam-playback.bin"]
    whole = client.get(url).content
    part = client.get(url, headers={"Range": "bytes=8-15"})
    assert part.status_code == 206 and part.content == whole[8:16]


def test_build_sources_are_kept(client, plate):
    text = client.get(f"/api/projects/plate/builds/{plate['id']}/src/program.py").text
    assert "Program(" in text
    assert client.get(f"/api/projects/plate/builds/{plate['id']}/src/..%2Fresult.json").status_code == 404
    assert client.get(f"/api/projects/plate/builds/{plate['id']}/files/result.json").status_code == 404


def test_without_its_acceptance_camlib_refuses(client):
    assert client.post("/api/projects", json={"name": "refused", "example": "plate"}).status_code == 200
    edit(client, "refused", "program.py", lambda text: text.replace('    accept={"unchecked_machine"},\n', ""))
    refused = build(client, "refused")
    assert refused["status"] == "done" and refused["ok"] and refused["released"] == 0 and refused["refused"] == 1
    machine = refused["metadata"]["setups"][0]["machines"][0]
    assert machine["gcode"] is None and "unchecked_machine" in machine["refused"]
    assert machine["refused_kinds"] == ["unchecked_machine"]
    assert [f["severity"] for f in machine["findings"]] == ["unchecked_machine"]
    # No G-code is served, but the playback of what was planned and checked is.
    assert set(refused["files"]) == {"cam-playback.bin"}


def test_a_program_error_comes_back_with_its_traceback(client):
    assert client.post("/api/projects", json={"name": "broken", "example": "plate"}).status_code == 200
    edit(client, "broken", "program.py", lambda text: text.replace('"pocket_floor"', '"pocket_flor"'))
    broken = build(client, "broken", mode="preview")
    assert broken["status"] == "done" and broken["ok"] is False
    error = broken["program_error"]
    assert "/src/program.py\", line 15" in error and "pocket_flor" in error
    assert broken["files"] == {}


def test_a_preview_describes_without_planning(client):
    preview = build(client, "plate", mode="preview")
    assert preview["status"] == "done" and preview["ok"]
    assert "setups" not in preview["metadata"] and preview["files"] == {}
    assert [op["id"] for op in preview["metadata"]["program"]["setups"][0]["operations"]] == ["face", "pocket", "outline", "holes"]


def test_the_part_is_tessellated_with_its_names(client):
    part = client.get("/api/projects/plate/part").json()
    corners = part["bounds"]["min"] + part["bounds"]["max"]   # OCCT's boxes carry a few µm of tolerance
    assert all(abs(got - want) < 0.01 for got, want in zip(corners, [0, 0, 0, 100, 60, 20]))
    named = {name for face in part["faces"] for name in face["names"]}
    assert named == {"top", "pocket_floor", "bottom"}
    assert len(part["triangle_faces"]) * 3 == len(part["indices"])


def test_bad_requests(client):
    assert client.post("/api/projects/plate/builds", json={"mode": "release"}).status_code == 400
    assert client.get("/api/projects/nope").status_code == 404
    assert client.get("/api/projects/plate/builds/nope").status_code == 404
    assert client.put("/api/projects/plate/files/run.sh", content=b"x").status_code == 400
