# camlib-ui

A local interface for [camlib](https://github.com/stevecad/camlib), the CAM engine: write a milling program in
Python, build it, see what camlib planned, checked and released, play it back on the stock, and download its G-code.

> [!IMPORTANT]
> **For demonstration purposes only.** camlib-ui shows what camlib does: it is not a CAM product, is not supported,
> and is not meant for making parts. Don't use its G-code on a machine.

> [!CAUTION]
> camlib is experimental, and so is this interface. Neither camlib's toolpaths nor its G-code have been proven on real
> machines. camlib checks a program against the model you give it (stock, tools, fixtures, machine limits); it can't
> know your real work offsets, tool lengths or clamps. **Simulate every posted file in independent software, dry-run
> above the part, and single-block the first run.** You use it entirely at your own risk.

## What it does

- **Projects on disk**: a folder per project with its part (STEP or a CadQuery script), its shop (machines, tools,
  fixtures as Python) and its program (camlib itself, plus a few helpers). See [docs/programs.md](docs/programs.md).
- **Toolpaths without writing code**: the browser's Setups list the program's setups and operations as its code says.
  Right-click a setup to add any of camlib's 25 milling operations (face, pocket, contour, drill, bore, tap, parallel,
  waterline, …) through a form; double-click one to edit it; drag, Delete, F2 and Ctrl+D reorder, delete, edit and
  duplicate. Faces, hole walls and edges are picked on the part. Every field is camlib's own (from the installed
  camlib), with no cutting data assumed. Each change writes exactly that code into `program.py`, and OK builds it.
- **Code editor** for every project file, with Python highlighting; <kbd>Ctrl</kbd>+<kbd>S</kbd> saves,
  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves and builds, <kbd>Ctrl</kbd>+<kbd>P</kbd> goes to a file. A program's error
  links each traceback line to the file and line it names.
- **Check** runs the program and describes it (setups, stock, tools, operations, machines). **Build** has camlib plan
  every setup, check every move, post, decode and replay the G-code, and release it or refuse it.
- **The verdict** per setup and machine: released (download the G-code) or refused, with each finding a click away in
  the playback, what wasn't checked, and the figures (moves, time, stock left, the material check).
- **3D view** in work coordinates, navigated as in STEVE Studio (view cube, standard views, mouse styles of STEVE,
  SOLIDWORKS, Fusion and Onshape, the command palette on <kbd>Ctrl</kbd>+<kbd>K</kbd>, every shortcut on
  <kbd>?</kbd>): the part (click a face for its name), the stock as cut at any move, the toolpath coloured by move
  kind, the tool and its holder, the fixtures the program placed.
- **Player**: play, step, scrub a timeline banded by operation with findings marked, at up to 500× machine time,
  beside the posted G-code (the current line follows playback; click a line to go to its move). The stock shows each
  tool's own profile swept through the moves on a fine grid; camlib's own check grid is a toggle away.

Each build runs in its own processes: your program runs in one, and only the plain data it hands back reaches the one
where camlib plans, checks, posts and releases the G-code ([docs/programs.md](docs/programs.md#building)).

## Install

You need Python 3.12, a Rust toolchain (camlib compiles its engine), and Node 22.18 or newer (to build the
interface).

```sh
git clone https://github.com/stevecad/camlib-ui && cd camlib-ui
git clone https://github.com/stevecad/camlib ../camlib
python3.12 -m venv .venv && . .venv/bin/activate
pip install ../camlib                  # camlib, built from its source
pip install -e '.[test]'
cd web && npm ci && npm run build && cd ..
```

> [!WARNING]
> Install camlib from [its repository](https://github.com/stevecad/camlib), as above. The `camlib` package on PyPI
> is an unrelated project: `pip install camlib` installs that one, and camlib-ui won't work with it.

`npm run build` writes the interface into `camlib_ui/web/`, which the server serves. The camlib checkout's
`examples/` folder holds its controller posts: pass it with `--camlib-posts ../camlib/examples` (below).

## Run

```sh
camlib-ui --projects ~/camlib-projects --camlib-posts ../camlib/examples
```

Then open <http://127.0.0.1:8765>. An empty projects folder is given the `plate` example to start from.

| Option | |
|---|---|
| `--projects DIR` | The projects folder (default `./camlib-projects`, or `$CAMLIB_UI_PROJECTS`). |
| `--camlib-posts DIR` | camlib's controller posts: a camlib checkout's `examples/` folder (or `$CAMLIB_POSTS`). Without it only the LinuxCNC post, built into camlib, is available. |
| `--host`, `--port` | Where to listen (default `127.0.0.1:8765`). |
| `--timeout S` | A build's time limit (default 900 s). |

camlib-ui runs your project's Python code on this machine: it listens on 127.0.0.1 only unless you say otherwise.
Don't expose it to a network you don't trust.

## Develop

```sh
python -m camlib_ui --projects /tmp/projects --camlib-posts ../camlib/examples   # the API on :8765
cd web && npm run dev                                                                 # the interface on :5179, hot reloaded
```

Tests and checks:

```sh
pytest                          # projects, builds end to end, the API, and the viewer's stream reader against the reference
ruff check camlib_ui tests
cd web && npm run typecheck && npm test
```

| Path | |
|---|---|
| `camlib_ui/server.py` | The HTTP API (`/api/docs` lists it). |
| `camlib_ui/projects.py`, `builds.py` | Projects on disk; builds, each in its own process. |
| `camlib_ui/build/` | A build: stage 1 (the program) and stage 2 (camlib plans, checks, posts, releases). |
| `camlib_ui/shop.py`, `program.py`, `parts.py` | The shop as code, the program helpers, part files. |
| `camlib_ui/stream.py`, `build/stream.py` | The playback stream's reader and writer ([docs/playback-stream.md](docs/playback-stream.md)). |
| `camlib_ui/examples/plate/` | The example project. |
| `web/src/` | The interface: React, three.js (react-three-fiber), CodeMirror. |

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

The build pipeline, shop as code, program helpers, playback stream, player, stock simulation and navigation are adapted
from STEVE Studio's camlib integration. The colour palette comes from STEVE (MIT), and the interface bundles the Inter
and JetBrains Mono typefaces (SIL Open Font License 1.1); NOTICE carries their notices. camlib is a separate dependency
under the MIT license.
