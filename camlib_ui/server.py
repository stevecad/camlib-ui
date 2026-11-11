"""The HTTP API the web interface uses (and the web interface itself, built into camlib_ui/web).

    GET    /api/info                                    camlib's version, the posts directory, the projects root
    GET    /api/projects                                projects; POST {name, example?} makes one
    GET    /api/projects/{p}                            its files, part, shop, program and builds
    GET    /api/projects/{p}/files/{name}               a file; PUT writes it (the body), DELETE removes it
    GET    /api/projects/{p}/part                       the part tessellated for the viewer (named faces, edges)
    GET    /api/projects/{p}/shop                       the shop's records (its machines, tool setups, tools) for the forms
    POST   /api/outline {"code"}                         a program's outline for the forms (nothing runs)
    GET    /api/operation-fields                        camlib's operations' fields, from the installed camlib
    POST   /api/projects/{p}/builds {"mode"}            a build: "preview" (describe) or "full" (plan, check, post)
    GET    /api/projects/{p}/builds[/{id}]              builds; one with camlib's result, the program's error, its log
    POST   /api/projects/{p}/builds/{id}/cancel
    GET    /api/projects/{p}/builds/{id}/files/{name}   released G-code (gcode-<n>.nc), the playback stream (ranges)
    GET    /api/projects/{p}/builds/{id}/src/{name}     a source file as the build used it
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import forms
from .builds import Builds
from .parts import Part, PartError, find_part
from .projects import ProjectError, Projects, example_names

WEB = Path(__file__).parent / "web"


class NewProject(BaseModel):
    name: str
    example: str | None = None


class NewBuild(BaseModel):
    mode: str = "full"


class Code(BaseModel):
    code: str


# The tessellation's format (bumped when it changes, so cached parts are read again).
PART_FORMAT = 3


def create_app(root: Path, *, timeout: int = 900) -> FastAPI:
    projects = Projects(root)
    projects.seed()
    builds = Builds(projects, timeout=timeout)
    builds.recover()
    app = FastAPI(title="camlib-ui", docs_url="/api/docs", openapi_url="/api/openapi.json")
    part_lock = threading.Lock()

    @app.exception_handler(ProjectError)
    async def project_error(request: Request, error: ProjectError):
        return JSONResponse({"detail": str(error)}, status_code=404 if "There's no" in str(error) else 400)

    @app.get("/api/info")
    def info():
        from importlib.metadata import PackageNotFoundError, version

        from .program import posts_directory
        try:
            camlib = version("camlib")
        except PackageNotFoundError:
            camlib = None
        posts = posts_directory()
        return {"camlib": camlib, "posts": str(posts) if posts else None,
                "posts_found": bool(posts and posts.is_dir() and any(posts.glob("*_post.py"))),
                "projects": str(projects.root), "examples": example_names(), "timeout_s": timeout}

    @app.get("/api/projects")
    def list_projects():
        return projects.list()

    @app.post("/api/projects")
    def new_project(body: NewProject):
        return projects.create(body.name, body.example)

    @app.get("/api/projects/{project}")
    def get_project(project: str):
        return {**projects.describe(project), "builds": builds.list(project)}

    @app.get("/api/projects/{project}/files/{name}")
    def get_file(project: str, name: str):
        path = projects.file(project, name)
        if name == "shop.py" and not path.is_file():
            path = projects.shop_file(project) or path
        if not path.is_file():
            raise HTTPException(404, f"There's no file {name!r}.")
        return FileResponse(path, media_type="text/plain; charset=utf-8" if path.suffix == ".py" else None)

    @app.put("/api/projects/{project}/files/{name}")
    async def put_file(project: str, name: str, request: Request):
        return projects.write(project, name, await request.body())

    @app.delete("/api/projects/{project}/files/{name}")
    def delete_file(project: str, name: str):
        return projects.delete(project, name)

    @app.get("/api/projects/{project}/part")
    def get_part(project: str):
        path = find_part(projects.path(project))
        if path is None:
            raise HTTPException(404, "The project has no part file (part.step, part.stp or part.py).")
        revision = Part(path).source["revision"]
        cache = projects.path(project) / ".cache"
        out = cache / f"part-{path.suffix[1:]}-{revision}-v{PART_FORMAT}.json"
        with part_lock:
            if not out.is_file():
                cache.mkdir(exist_ok=True)
                for old in cache.glob("part-*.json"):
                    old.unlink()
                try:
                    subprocess.run([sys.executable, "-m", "camlib_ui.parts", str(path), str(out)], cwd=str(cache),
                                   timeout=300, capture_output=True, check=False)
                except subprocess.TimeoutExpired:
                    raise HTTPException(504, "The part took more than 5 minutes to read.") from None
                if not out.is_file():
                    raise HTTPException(500, "The part couldn't be read.")
        data = json.loads(out.read_text())
        if not data.get("ok"):
            out.unlink()
            raise HTTPException(422, data.get("error") or "The part couldn't be read.")
        return Response(out.read_bytes(), media_type="application/json")

    @app.get("/api/projects/{project}/shop")
    def get_shop(project: str):
        """The shop's records, for the forms (shop.py runs in a child process; cached by its text)."""
        import hashlib
        path = projects.shop_file(project)
        if path is None:
            raise HTTPException(404, "The project has no shop.py (nor has the projects folder).")
        revision = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
        cache = projects.path(project) / ".cache"
        out = cache / f"shop-{revision}.json"
        with part_lock:
            if not out.is_file():
                cache.mkdir(exist_ok=True)
                for old in cache.glob("shop-*.json"):
                    old.unlink()
                try:
                    subprocess.run([sys.executable, "-m", "camlib_ui.forms", "shop", str(path), str(out)], cwd=str(cache),
                                   timeout=120, capture_output=True, check=False)
                except subprocess.TimeoutExpired:
                    raise HTTPException(504, "shop.py took more than 2 minutes to run.") from None
                if not out.is_file():
                    raise HTTPException(500, "shop.py couldn't be read.")
        data = json.loads(out.read_text())
        if not data.get("ok"):
            out.unlink()
            raise HTTPException(422, data.get("error") or "shop.py couldn't be read.")
        return Response(out.read_bytes(), media_type="application/json")

    @app.post("/api/outline")
    def get_outline(body: Code):
        return forms.outline(body.code)

    @app.get("/api/operation-fields")
    def get_operation_fields():
        return forms.operation_fields()

    @app.post("/api/projects/{project}/builds")
    def new_build(project: str, body: NewBuild):
        try:
            return builds.start(project, body.mode)
        except ValueError as error:
            raise HTTPException(400, str(error)) from None

    @app.get("/api/projects/{project}/builds")
    def list_builds(project: str):
        projects.path(project)
        return builds.list(project)

    def _build(call):
        try:
            return call()
        except KeyError:
            raise HTTPException(404, "There's no such build or file.") from None

    @app.get("/api/projects/{project}/builds/{build}")
    def get_build(project: str, build: str):
        return _build(lambda: builds.get(project, build))

    @app.post("/api/projects/{project}/builds/{build}/cancel")
    def cancel_build(project: str, build: str):
        return _build(lambda: builds.cancel(project, build))

    @app.get("/api/projects/{project}/builds/{build}/files/{name}")
    def build_file(project: str, build: str, name: str):
        path = _build(lambda: builds.file(project, build, name))
        if name.endswith(".nc"):
            return FileResponse(path, media_type="text/plain; charset=us-ascii")
        return FileResponse(path, media_type="application/octet-stream")

    @app.get("/api/projects/{project}/builds/{build}/src/{name}")
    def build_source(project: str, build: str, name: str):
        return PlainTextResponse(_build(lambda: builds.source(project, build, name)).read_text(errors="replace"))

    @app.exception_handler(PartError)
    async def part_error(request: Request, error: PartError):
        return JSONResponse({"detail": str(error)}, status_code=422)

    if WEB.is_dir() and (WEB / "index.html").is_file():
        app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
    else:
        @app.get("/")
        def no_web():
            return PlainTextResponse("camlib-ui's API is running; the web interface isn't built (cd web && npm install "
                                     "&& npm run build), or run its dev server (npm run dev).")
    return app
