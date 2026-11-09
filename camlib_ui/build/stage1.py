"""Stage 1 of a build: the program. Runs program.py with its links (`from links import part, shop`) and hands back plain
data only (camlib_ui.program.export_program) as one JSON document on the file descriptor it is given. It writes no G-code,
findings or stream: stage 2 (camlib_ui.build) rebuilds everything from this data in another process, once this one and
everything it started have ended.

    python -m camlib_ui.build.stage1 <request.json> <fd>
"""
from __future__ import annotations

import json
import os
import sys
import traceback
import types
import warnings
from pathlib import Path


def links_module(request):
    """The `links` module a program imports: `part` (the project's part file) and `shop` (shop.py's `shop`)."""
    from camlib_ui.parts import load_part
    from camlib_ui.shop import Shop
    module = types.ModuleType("links")
    module.__doc__ = "The project's part and shop (camlib-ui)."
    if request.get("part"):
        module.part = load_part(Path(request["part"]), alias="part")
    if request.get("shop"):
        path = Path(request["shop"])
        namespace = {"__name__": "__shop__", "__file__": str(path)}
        exec(compile(path.read_text(), str(path), "exec"), namespace)
        shop = namespace.get("shop")
        if not isinstance(shop, Shop):
            raise ValueError(f"{path.name} must make `shop = Shop()` (from camlib_ui.shop import *).")
        module.shop = shop
    return module


def execute(request):
    """Runs the program; returns its `program`."""
    from camlib_ui.program import Program
    path = Path(request["program"])
    sys.modules["links"] = links_module(request)
    sys.path.insert(0, str(path.parent))   # the project's own helper modules
    namespace = {"__name__": "__main__", "__file__": str(path)}
    exec(compile(path.read_text(), str(path), "exec"), namespace)
    program = namespace.get("program")
    if not isinstance(program, Program):
        raise ValueError(f"{path.name} must make `program = Program(job, machine(...))` (from camlib_ui.program import "
                         "Program, machine): the camlib Job and the machine each setup is posted for.")
    return program


def main(request_path, fd):
    request = json.loads(Path(request_path).read_text())
    code = 1
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            from camlib_ui.program import export_program
            data = export_program(execute(request))
        data["warnings"] = [dict(kind=w.category.__name__, message=str(w.message)[:500]) for w in caught][:50]
        payload = {"ok": True, "program": data}
        code = 0
    except BaseException as error:  # noqa: BLE001  Everything becomes the program's error.
        reason = "memory" if isinstance(error, MemoryError) else None
        payload = {"ok": False, "error": traceback.format_exc()[-12000:], "reason": reason}
        traceback.print_exc()
    try:
        raw = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
    except (ValueError, TypeError) as error:
        raw = json.dumps({"ok": False, "error": f"The program's data isn't JSON: {error}"}).encode()
    view = memoryview(raw)
    while view:
        view = view[os.write(fd, view[:1 << 20]):]
    os.close(fd)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]))
