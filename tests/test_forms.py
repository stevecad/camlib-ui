"""The program forms (web/src/cam/forms.ts) on the plate example: what they read of program.py and what they write.

The forms read program.py through the server's outline (camlib_ui/forms.py). web/tests/forms.test.ts edits the plate's
program through them (an operation edited, one added, a new tool, delete, duplicate, reorder, a second setup) and writes
each result; every one of them must then run as a program, and the edited one must still be released by camlib."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from camlib_ui import forms

from conftest import build

WEB = Path(__file__).resolve().parent.parent / "web"
PLATE = Path(__file__).resolve().parent.parent / "camlib_ui" / "examples" / "plate" / "program.py"
COVER = Path(__file__).resolve().parent.parent / "camlib_ui" / "examples" / "cover" / "program.py"


def test_the_outline_reads_values_and_spans():
    code = 'x = 2\nPocket("p", mill, top_z_mm=x * 3, floor_z_mm=-1.5, coolant="flood")\ny = math.pi\n'
    outline = forms.outline(code)
    assert outline["ok"] and outline["parameters"] == {"x": 2, "y": 3.141592653589793}
    call = outline["statements"][1]
    assert call["kind"] == "other" and call["line"] == 2
    assigned = outline["bindings"]["y"]["value"]
    assert assigned["k"] == "attr" and abs(assigned["v"] - 3.141592653589793) < 1e-12
    assert forms.outline("x = (\n")["error"]["line"] == 1


def test_spans_are_utf16_offsets():
    code = 'note = "ångström 🙂"\nz = 1\n'
    outline = forms.outline(code)
    start, end = outline["bindings"]["z"]["value"]["s"]
    assert code.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le") == "1"


def test_camlibs_fields_come_from_the_installed_camlib():
    fields = forms.operation_fields()
    assert set(forms.OPERATIONS) <= set(fields) and set(forms.OPTIONS) <= set(fields)
    pocket = {name: (kind, default) for name, kind, default, _ in fields["Pocket"]}
    assert pocket["stepdown_mm"] == ("float", None) and pocket["radial_allowance_mm"][1] == "0"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node isn't installed")
def test_what_the_forms_write_builds(client, tmp_path):
    code = PLATE.read_text()
    data = {"code": code, "outline": forms.outline(code), "fields": forms.operation_fields()}
    (tmp_path / "input.json").write_text(json.dumps(data))
    out = tmp_path / "out"
    out.mkdir()
    env = {**os.environ, "CAMLIB_UI_FORMS": str(tmp_path / "input.json"), "CAMLIB_UI_FORMS_OUT": str(out)}
    run = subprocess.run(["node", "--test", "tests/forms.test.ts"], cwd=WEB, env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-4000:]
    assert "✔ the plate program read, edited and written back" in run.stdout
    written = {path.stem: path.read_text() for path in out.glob("*.py")}
    assert set(written) == {"edited", "added", "drilled", "deleted", "duplicated", "reordered", "second_setup", "new_program"}
    # A new setup is written before its first operation; the forms then write that into it (read again by the server).
    first = {"fields": forms.operation_fields(), "programs": {
        name: {"code": written[name], "outline": forms.outline(written[name]), "setup": "bottom" if name == "second_setup" else "top"}
        for name in ("second_setup", "new_program")}}
    (tmp_path / "first.json").write_text(json.dumps(first))
    run = subprocess.run(["node", "--test", "tests/forms.test.ts"], cwd=WEB, capture_output=True, text=True, timeout=120,
                         env={**os.environ, "CAMLIB_UI_FORMS_FIRST": str(tmp_path / "first.json"), "CAMLIB_UI_FORMS_OUT": str(out)})
    assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-4000:]
    assert "✔ a new setup gets its first operation" in run.stdout
    written.update({name: (out / f"{name}.py").read_text() for name in first["programs"]})
    for name, text in written.items():
        project = f"forms_{name}"
        assert client.post("/api/projects", json={"name": project, "example": "plate"}).status_code == 200
        assert client.put(f"/api/projects/{project}/files/program.py", content=text.encode()).status_code == 200
        done = build(client, project, mode="preview")
        assert done["status"] == "done" and done["ok"], f"{name}:\n{done.get('program_error')}\n{text}"
    edited = build(client, "forms_edited")
    assert edited["released"] == 1 and edited["refused"] == 0


def _node(test: str, env: dict, passed: str):
    run = subprocess.run(["node", "--test", f"tests/{test}"], cwd=WEB, env={**os.environ, **env}, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-4000:]
    assert f"✔ {passed}" in run.stdout, run.stdout[-2000:]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node isn't installed")
def test_the_newer_options_read_write_and_build(client, cover, tmp_path):
    """web/tests/options.test.ts on the cover example: the ramp entry and the tabs at points read into their forms; tabs
    moved, a ramp around the outline, a helix, the orbit planner, a trace beside an edge, a tool change in place and the
    part's outline at a depth are written, and camlib builds what the forms wrote."""
    code = COVER.read_text()
    outlined = code.replace('outline = region(part, "bottom", name="outline")', 'outline = silhouette(part, 0, max_error_mm=0.003, name="outline")') \
                   .replace("import Program, machine, region, slot, tool", "import Program, machine, region, silhouette, slot, tool")
    assert outlined.count("silhouette") == 2
    part = client.get("/api/projects/cover/part").json()
    edge = next(item["name"] for item in part["edge_info"] if item["flat"] and item["type"] == "LINE")
    fields = forms.operation_fields()
    data = {"code": code, "outline": forms.outline(code), "fields": fields, "edge": edge,
            "silhouette": {"code": outlined, "outline": forms.outline(outlined)}}
    (tmp_path / "input.json").write_text(json.dumps(data))
    out = tmp_path / "out"
    out.mkdir()
    _node("options.test.ts", {"CAMLIB_UI_OPTIONS": str(tmp_path / "input.json"), "CAMLIB_UI_FORMS_OUT": str(out)},
          "the cover program read, edited and written back")
    written = {path.stem: path.read_text() for path in out.glob("*.py")}
    assert set(written) == {"tabs_moved", "ramped", "helix", "orbits", "traced", "in_place", "silhouette"}
    # The setup changed to a tool change in place, read again by the server, then changed back.
    back = {"code": written["in_place"], "outline": forms.outline(written["in_place"]), "fields": fields}
    (tmp_path / "back.json").write_text(json.dumps(back))
    _node("options.test.ts", {"CAMLIB_UI_OPTIONS_BACK": str(tmp_path / "back.json"), "CAMLIB_UI_FORMS_OUT": str(out)},
          "a tool change in place is taken out again")
    written["back"] = (out / "back.py").read_text()
    built = {}
    for name, text in written.items():
        project = f"options_{name}"
        assert client.post("/api/projects", json={"name": project, "example": "cover"}).status_code == 200
        assert client.put(f"/api/projects/{project}/files/program.py", content=text.encode()).status_code == 200
        # camlib plans and posts what the forms wrote (the setup edits and the unchanged outline are run as programs).
        built[name] = build(client, project, mode="preview" if name in ("back", "silhouette") else "full")
        assert built[name]["status"] == "done" and built[name]["ok"], f"{name}:\n{built[name].get('program_error')}\n{text}"
    for name in ("tabs_moved", "ramped", "helix", "orbits", "traced", "in_place"):
        assert built[name]["released"] == 1 and built[name]["refused"] == 0, name
    operations = lambda name: {op["id"]: op for op in built[name]["metadata"]["setups"][0]["operations"]}
    # The orbit planner's report has no engagement proof to show; the default planner's (the cover fixture) does.
    assert operations("orbits")["pocket"]["report"].get("clearing") != "engagement_front"
    assert cover["metadata"]["setups"][0]["operations"][0]["report"]["clearing"] == "engagement_front"
    assert operations("traced")["step"]["moves"] > 0 and operations("traced")["step"]["cut_mm"] > 0
    assert operations("ramped")["outline"]["moves"] > 0
