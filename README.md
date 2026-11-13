# camlib-ui

A local interface for [camlib](https://github.com/stevecad/camlib), the CAM engine: write a milling, a lathe or a
plasma cutting program in Python, build it, see what camlib planned, checked and released, play it back on the stock, and download its G-code.

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
  camlib), with no cutting data assumed: an adaptive pocket's path (camlib's default follows the stock; the fields that
  path refuses aren't offered), ramp, helix and stock-edge entries, tabs by count, spacing or at points, a trace beside
  its path, one-way rows. Each change writes exactly that code into `program.py`, and OK builds it.
- **Code editor** for every project file, with Python highlighting; <kbd>Ctrl</kbd>+<kbd>S</kbd> saves,
  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> saves and builds, <kbd>Ctrl</kbd>+<kbd>P</kbd> goes to a file. A program's error
  links each traceback line to the file and line it names.
- **Check** runs the program and describes it (setups, stock, tools, operations, machines). **Build** has camlib plan
  every setup, check every move, post, decode and replay the G-code, and release it or refuse it.
- **The verdict** per setup and machine: released (download the G-code) or refused, with each finding a click away in
  the playback, what wasn't checked, and the figures (moves, time, stock left, the material check). Every tool is
  checked against its own travel (the machine's, lowered by that tool's gauge length).
- **camlib's report of each operation**, as camlib gave it: the engagement an adaptive clearing proved level by level
  and its wall passes, ramp angles, a contour's loops left without a tab, a waterline's shadow error, and every other
  value under camlib's own name.
- **3D view** in work coordinates, navigated as in STEVE Studio (view cube, standard views, mouse styles of STEVE,
  SOLIDWORKS, Fusion and Onshape, the command palette on <kbd>Ctrl</kbd>+<kbd>K</kbd>, every shortcut on
  <kbd>?</kbd>): the part (click a face for its name), the stock as cut at any move, the toolpath coloured by move
  kind, the tool and its holder, the fixtures the program placed. The eye on an operation's row in the browser hides
  or shows that operation's toolpath (<kbd>Alt</kbd>+click shows only that one, and again puts the others back; a
  setup's eye does all of its operations). The moves between operations go with the operation they lead to. It is a
  display choice, kept per project: the playback, the tool and the stock still run every operation.
- **Lathes**: a lathe project (the `shaft` and `bushing` examples) has a turned part, a shop with a lathe, its turning tools (ISO
  inserts and holders, blades, threading inserts, drills) and its turret, and a program of camlib's turning operations
  posted with camlib's FANUC or Centroid lathe post. The ten turning operations (face, rough, finish, groove, part
  off, thread, drill, bore, face groove) have forms like the milling ones, every field camlib's own. The 3D view shows
  camlib's own turned stock revolved about the spindle axis, a quarter cut away, with the tool's insert and holder in
  the section. See
  [docs/programs.md](docs/programs.md#lathes); [docs/machine-types.md](docs/machine-types.md) says what is there for
  each machine type and what is planned.
- **Plasma and laser tables**: a sheet project (the `sheet` example) nests flat parts on a sheet with camlib's `Nest`
  and cuts them with a torch or a laser head (`ThermalCut`: pierces, leads and kerf paths proven clear of every part),
  posted with camlib's QtPlasmaC, Centroid plasma, WinCNC or GRBL laser post. The playback shows the sheet with every
  kerf cut through. See [docs/programs.md](docs/programs.md#plasma-and-laser-tables).
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
./start.sh
```

Then open <http://127.0.0.1:8765>. An empty projects folder is given the examples to start from: `plate` (face,
pocket, outline and holes, in a vise), `cover` (an adaptive pocket that follows the stock, a recess entered by a
ramp, the outline cut through with tabs at points), `shaft` (a lathe: a bar faced, roughed, finished, threaded and
parted off), `bushing` (a lathe: a hole drilled and bored, the outside turned and grooved) and `sheet` (a plasma table:
two parts nested on a sheet and cut out). `shaft`, `bushing` and `sheet` need camlib's posts (below). A new project can start from any of them. Every machine, tool, speed and
feed in the examples is an example value, not a real machine's.

`start.sh` checks that camlib-ui and camlib are installed, builds the interface if it isn't built yet, finds camlib's
posts in `../camlib/examples` (the checkout from Install), and starts the server. `./start.sh --help` lists it all:

| Option | |
|---|---|
| `-p`, `--projects DIR` | The projects folder (default `./camlib-projects`, or `$CAMLIB_UI_PROJECTS`). |
| `--host ADDRESS`, `-P`, `--port PORT` | Where to listen (default `127.0.0.1:8765`: this machine only). |
| `--lan` | Listen on this machine's LAN address, so other computers on your network can open it. |
| `--posts DIR` | camlib's controller posts: a camlib checkout's `examples/` folder (default `$CAMLIB_POSTS`, else `../camlib/examples`). Without them only the LinuxCNC post, built into camlib, is available. |
| `--timeout SECONDS` | A build's time limit (default 900). |
| `--build` | Rebuild the interface first (after pulling changes). |
| `--venv DIR` | The Python environment camlib-ui is installed in (default `./.venv`). |

For example, `./start.sh --lan --projects ~/cam --port 9000`. The installed `camlib-ui` command takes the same
`--projects`, `--host`, `--port`, `--timeout` and `--camlib-posts` options directly.

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
                                # (the lathe tests post with camlib's FANUC and Centroid posts: $CAMLIB_POSTS, else
                                # ../camlib/examples; they are skipped, and say so, when neither is there)
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
| `camlib_ui/build/turning.py` | A lathe setup as the result and the stream describe it (the bar, the part's half-section, the tools' outlines). |
| `camlib_ui/examples/plate/`, `cover/`, `shaft/`, `bushing/`, `sheet/` | The example projects (`shaft`, `bushing`: a lathe; `sheet`: a plasma table). |
| `web/src/` | The interface: React, three.js (react-three-fiber), CodeMirror. |

## License

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

The build pipeline, shop as code, program helpers, playback stream, player, stock simulation and navigation are adapted
from STEVE Studio's camlib integration. The colour palette comes from STEVE (MIT), and the interface bundles the Inter
and JetBrains Mono typefaces (SIL Open Font License 1.1); NOTICE carries their notices. camlib is a separate dependency
under the MIT license.
