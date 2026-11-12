"""Projects on disk: names, files, the part file kinds, the shared shop and build snapshots."""
from __future__ import annotations

import pytest

from camlib_ui.projects import HIDDEN, ProjectError, Projects, example_names


@pytest.fixture
def projects(tmp_path):
    projects = Projects(tmp_path / "root")
    projects.seed()
    return projects


def test_seed_copies_the_examples(projects):
    assert example_names() == ["cover", "plate"]
    assert [p["name"] for p in projects.list()] == ["cover", "plate"]
    for name in ("cover", "plate"):
        example = projects.describe(name)
        assert (example["part"], example["shop"], example["program"]) == ("part.py", "shop.py", "program.py")


def test_seed_leaves_a_root_with_projects_alone(tmp_path):
    root = tmp_path / "root"
    (root / "mine").mkdir(parents=True)
    Projects(root).seed()
    assert sorted(p.name for p in root.iterdir()) == ["mine"]


@pytest.mark.parametrize("name", ["", ".hidden", "../up", "a/b", "x" * 65, "sp ace"])
def test_project_names_are_checked(projects, name):
    with pytest.raises(ProjectError):
        projects.create(name)


@pytest.mark.parametrize("name", ["../program.py", ".builds", "program.exe", "a/b.py", ".x.py"])
def test_file_names_are_checked(projects, name):
    with pytest.raises(ProjectError):
        projects.file("plate", name)


def test_a_blank_project_gets_a_program_and_a_shop(projects):
    made = projects.create("blank")
    assert made["program"] == "program.py" and made["shop"] == "shop.py" and made["part"] is None
    with pytest.raises(ProjectError, match="already"):
        projects.create("blank")


def test_a_shared_shop_serves_projects_without_their_own(projects):
    (projects.root / "shop.py").write_text("shop = None\n")
    made = projects.create("shared")
    assert made["shop"] == "../shop.py"
    sources = projects.snapshot("shared", projects.root / "snap")
    assert (projects.root / "snap" / "shop.py").read_text() == "shop = None\n"
    assert sources["shop"].endswith("snap/shop.py")


def test_a_new_part_file_replaces_the_other_kinds(projects):
    projects.write("plate", "part.step", b"ISO-10303-21;")
    described = projects.describe("plate")
    assert described["part"] == "part.step"
    assert not (projects.path("plate") / "part.py").exists()


def test_write_and_delete(projects):
    projects.write("plate", "notes.md", b"# notes")
    assert any(f["name"] == "notes.md" for f in projects.describe("plate")["files"])
    projects.delete("plate", "notes.md")
    with pytest.raises(ProjectError, match="no file"):
        projects.delete("plate", "notes.md")


def test_snapshot_leaves_builds_and_hidden_files_out(projects):
    path = projects.path("plate")
    (path / HIDDEN / "old").mkdir(parents=True)
    (path / ".cache").mkdir()
    (path / "__pycache__").mkdir()
    sources = projects.snapshot("plate", projects.root / "snap")
    copied = sorted(p.name for p in (projects.root / "snap").iterdir())
    assert copied == ["part.py", "program.py", "shop.py", "vise.py"]
    assert sources["part"].endswith("snap/part.py")
