"""Shared fixtures: a projects root with the examples, the API's test client, and builds of the plate and cover examples
(each a real camlib build in its own process, so they are made once per session)."""
from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from camlib_ui.server import create_app


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


def variant(client: TestClient, name: str, example: str, change, mode: str = "full") -> dict:
    """A project made from an example with its program.py changed, built."""
    assert client.post("/api/projects", json={"name": name, "example": example}).status_code == 200
    edit(client, name, "program.py", change)
    return build(client, name, mode)
