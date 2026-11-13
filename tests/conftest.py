"""Shared fixtures: a projects root with the examples, the API's test client, and builds of the plate, cover and shaft
examples (each a real camlib build in its own process, so they are made once per session).

camlib's controller posts other than LinuxCNC are in a camlib checkout's examples/ folder (README, Install): $CAMLIB_POSTS,
else ../camlib/examples next to this repository, as start.sh finds it. Tests that post with one (the lathe's) are skipped
without it, and say so."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from camlib_ui.projects import HIDDEN as HIDDEN_BUILDS  # noqa: F401  (tests read a build's own directory)
from camlib_ui.server import create_app


def _posts() -> Path | None:
    given = os.environ.get("CAMLIB_POSTS")
    for path in ([Path(given).expanduser()] if given else []) + [Path(__file__).resolve().parents[2] / "camlib" / "examples"]:
        if path.is_dir() and any(path.glob("*_post.py")):
            return path
    return None


POSTS = _posts()
if POSTS is not None:
    os.environ["CAMLIB_POSTS"] = str(POSTS)   # builds run in child processes: they read it from the environment
needs_posts = pytest.mark.skipif(POSTS is None, reason="camlib's controller posts aren't there: set CAMLIB_POSTS to a "
                                                       "camlib checkout's examples/ folder")


def wait_for(client: TestClient, project: str, build: str, timeout: float = 300) -> dict:
    """Polls a build until it is no longer queued or running; returns it."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = client.get(f"/api/projects/{project}/builds/{build}").json()
        if found["status"] not in ("queued", "running"):
            return found
        time.sleep(0.5)
    raise TimeoutError(f"build {build} of {project} didn't finish in {timeout} s")


def build(client: TestClient, project: str, mode: str = "full") -> dict:
    started = client.post(f"/api/projects/{project}/builds", json={"mode": mode})
    assert started.status_code == 200, started.text
    return wait_for(client, project, started.json()["id"])


def watch(client: TestClient, project: str, mode: str = "full", timeout: float = 300) -> tuple[dict, list[dict]]:
    """Starts a build and reads it often until it ends; returns it and every "progress" it gave while it ran."""
    started = client.post(f"/api/projects/{project}/builds", json={"mode": mode})
    assert started.status_code == 200, started.text
    seen, deadline = [], time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = client.get(f"/api/projects/{project}/builds/{started.json()['id']}").json()
        if found["status"] not in ("queued", "running"):
            return found, seen
        if "progress" in found:
            seen.append(found["progress"])
        time.sleep(0.05)
    raise TimeoutError(f"build of {project} didn't finish in {timeout} s")


def edit(client: TestClient, project: str, name: str, change) -> None:
    text = client.get(f"/api/projects/{project}/files/{name}").text
    changed = change(text)
    assert changed != text
    assert client.put(f"/api/projects/{project}/files/{name}", content=changed.encode()).status_code == 200


@pytest.fixture(scope="session")
def root(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("projects")


@pytest.fixture(scope="session")
def client(root) -> TestClient:
    return TestClient(create_app(root, timeout=600))


@pytest.fixture(scope="session")
def plate(client) -> dict:
    """The plate example, built in full."""
    return build(client, "plate")


@pytest.fixture(scope="session")
def cover(client) -> dict:
    """The cover example, built in full."""
    return build(client, "cover")


@pytest.fixture(scope="session")
def shaft(client) -> dict:
    """The shaft example (a lathe, posted with camlib's FANUC lathe post), built in full."""
    if POSTS is None:
        pytest.skip("camlib's controller posts aren't there (CAMLIB_POSTS)")
    return build(client, "shaft")


def variant(client: TestClient, name: str, example: str, change, mode: str = "full") -> dict:
    """A project made from an example with its program.py changed, built."""
    assert client.post("/api/projects", json={"name": name, "example": example}).status_code == 200
    edit(client, name, "program.py", change)
    return build(client, name, mode)
