"""Projects on disk: one directory per project under the projects root.

    <root>/<project>/
        program.py      the camlib program (makes `program = Program(job, machine(...))`)
        shop.py         the shop (makes `shop = Shop()`); falls back to <root>/shop.py when the project has none
        part.step|stp|py the part it machines (optional: a program may make its own geometry)
        *.py, *.step    anything else the program, part or shop use (helper modules, fixture bodies)
        .builds/<id>/   builds: a copy of the sources, the request, the log, the result and its files
"""
from __future__ import annotations

import re
import shutil
from importlib import resources
from pathlib import Path

from .parts import find_part

NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
FILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.(py|step|stp|txt|md|json)\Z", re.IGNORECASE)
MAX_FILE = 64 * 1024 * 1024
HIDDEN = ".builds"

BLANK_PROGRAM = '''"""A new camlib program. `from links import part, shop`: the project's part file and shop.py.

camlib's API: https://github.com/stevecad/camlib (docs/). camlib-ui's helpers (camlib_ui.program): solid, face, region,
hole_centers, surface, paths, part_target, tool, slot, fixture, protected, machine, Program. See the plate example.
"""
from links import shop  # noqa: F401  (add `part` once the project has a part file)
from camlib import Job, Setup, StockSpec  # noqa: F401
from camlib_ui.program import Program, machine, slot, tool  # noqa: F401

# program = Program(job, machine(shop.mill, setup, tooling=shop.rack, work_to_machine=WorkFrame((x, y, z)), ...))
'''


class ProjectError(ValueError):
    """A project or file name that isn't allowed, or one that doesn't exist."""


def examples() -> Path:
    return Path(str(resources.files("camlib_ui") / "examples"))


def example_names() -> list[str]:
    return sorted(p.name for p in examples().iterdir() if p.is_dir() and (p / "program.py").is_file())


class Projects:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def seed(self):
        """A first start: the examples as projects."""
        if not any(self.root.iterdir()):
            for name in example_names():
                shutil.copytree(examples() / name, self.root / name)

    def path(self, name: str) -> Path:
        if not NAME.fullmatch(name or ""):
            raise ProjectError(f"{name!r} isn't a project name (letters, digits, _ . - only).")
        path = self.root / name
        if not path.is_dir():
            raise ProjectError(f"There's no project {name!r}.")
        return path

    def file(self, project: str, name: str) -> Path:
        if not FILE.fullmatch(name or ""):
            raise ProjectError(f"{name!r} isn't a project file name (a .py, .step, .stp, .txt, .md or .json file).")
        return self.path(project) / name

    def list(self) -> list[dict]:
        return [self.describe(p.name) for p in sorted(self.root.iterdir())
                if p.is_dir() and NAME.fullmatch(p.name) and not p.name.startswith(".")]

    def shop_file(self, project: str) -> Path | None:
        own = self.path(project) / "shop.py"
        shared = self.root / "shop.py"
        return own if own.is_file() else shared if shared.is_file() else None

    def describe(self, name: str) -> dict:
        path = self.path(name)
        files = [{"name": f.name, "size": f.stat().st_size, "modified": f.stat().st_mtime}
                 for f in sorted(path.iterdir()) if f.is_file() and FILE.fullmatch(f.name)]
        part = find_part(path)
        shop = self.shop_file(name)
        return {"name": name, "files": files, "part": part.name if part else None,
                "shop": None if shop is None else ("shop.py" if shop.parent == path else "../shop.py"),
                "program": "program.py" if (path / "program.py").is_file() else None}

    def create(self, name: str, example: str | None = None) -> dict:
        if not NAME.fullmatch(name or ""):
            raise ProjectError(f"{name!r} isn't a project name (letters, digits, _ . - only).")
        target = self.root / name
        if target.exists():
            raise ProjectError(f"There's already a project {name!r}.")
        if example:
            if example not in example_names():
                raise ProjectError(f"There's no example {example!r} ({', '.join(example_names())}).")
            shutil.copytree(examples() / example, target)
        else:
            target.mkdir()
            (target / "program.py").write_text(BLANK_PROGRAM)
            if not (self.root / "shop.py").is_file():
                shutil.copy2(examples() / "plate" / "shop.py", target / "shop.py")
        return self.describe(name)

    def write(self, project: str, name: str, data: bytes) -> dict:
        if len(data) > MAX_FILE:
            raise ProjectError(f"{name} is over {MAX_FILE // (1024 * 1024)} MB.")
        path = self.file(project, name)
        if name.lower().startswith("part.") and name.lower().endswith((".py", ".step", ".stp")):
            for other in path.parent.glob("part.*"):   # one part file: a new one replaces the other kinds
                if other.name != name and other.suffix.lower() in (".py", ".step", ".stp"):
                    other.unlink()
        tmp = path.with_name(f".{name}.tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        return self.describe(project)

    def delete(self, project: str, name: str) -> dict:
        path = self.file(project, name)
        if not path.is_file():
            raise ProjectError(f"There's no file {name!r}.")
        path.unlink()
        return self.describe(project)

    def snapshot(self, project: str, target: Path) -> dict:
        """Copies the project's sources (not its builds) to `target` for a build; returns the build's file paths."""
        source = self.path(project)
        shutil.copytree(source, target, ignore=shutil.ignore_patterns(HIDDEN, "__pycache__", ".*"))
        shop = self.shop_file(project)
        if shop is not None and shop.parent != source:
            shutil.copy2(shop, target / "shop.py")
        part = find_part(target)
        return {"program": str(target / "program.py"), "part": str(part) if part else None,
                "shop": str(target / "shop.py") if (target / "shop.py").is_file() else None}
