# Writing a program

A camlib-ui project is a folder with three kinds of file:

| File | What it is |
|---|---|
| `part.step`, `part.stp` or `part.py` | The part the program machines (optional). A STEP file, or a CadQuery script that sets `result`. |
| `shop.py` | Your shop: machines, controllers, tools, tool setups and fixtures, in Python. A project without one uses the projects folder's `shop.py`. |
| `program.py` | The program: a camlib `Job`, and the machine each setup is posted for, as `program = Program(...)`. |

Anything else in the folder (helper modules, fixture bodies such as the example's `vise.py`) can be imported or
referenced by these. The `plate` example (`camlib_ui/examples/plate/`) is a complete project; start from it. The
`cover` example beside it shows an adaptive pocket on camlib's default planner, a ramp entry and tabs at points.

## The part

The part's own coordinates are the program's work coordinates: its origin is the G-code's zero. Lengths are
millimetres.

Faces and edges are named `face1`, `face2`, … and `edge1`, `edge2`, … in the shape's own order (stable for a given
file). A `part.py` may also name them, which reads better in a program and survives edits that renumber faces:

```python
faces = {"top": result.faces(">Z"), "pocket_floor": result.faces(...)}
edges = {...}
bodies = {"jaw": jaw_solid}     # named solids, for a part used as a fixture body
```

In the 3D view, click a face to see its names (click a name to copy it).

## The shop (`shop.py`)

A shop file makes `shop = Shop()` and adds items; a program reaches each one as `shop.<key>`:

```python
from camlib_ui.shop import *

shop = Shop()
model = shop.add(MachineModel.mill("vmc_model", "Example VMC", travel=(500, 400, 400),
                                   spindle=Spindle(interface="bt30", max_rpm=12000),
                                   changer=Changer.magazine(pockets=12, interface="bt30"), rapid=10000))
control = shop.add(Controller("control", "LinuxCNC", dialect="linuxcnc_cartesian_linear_v1", ...))
mill = shop.add(Machine("mill", "Example VMC", model=model, controller=control))
em6 = shop.add(EndMill("em6", "6 mm end mill", diameter=6, flutes=3, flute_length=18, overall_length=60))
t_em6 = shop.add(Tool("t_em6", "6 mm end mill", cutter=em6, holders=[er20], stickout=30))
rack = shop.add(ToolSetup("rack", "Rack", tools={2: (t_em6, {"offsets": {"length_register": 2}})}))
```

The helpers are `MachineModel`, `Spindle`, `Changer`, `Controller`, `Machine`, the cutters (`EndMill`,
`BallEndMill`, `BullEndMill`, `Drill`, `ChamferMill`, `FaceMill`, `ShellMill`, `Reamer`, `Tap`, `ThreadMill`,
`BoringBar`), `Holder`, `Tool`, `ToolSetup`, `Material`, `Preset` and `Post`; `Record(kind, key, {...})` writes any
other record (a fixture, for one). See `camlib_ui/shop.py` and the example's `shop.py`.

Every value camlib checks against comes from the shop (travel, feeds, spindle, tool and holder geometry) or from the
program. Nothing is assumed: a value camlib needs that neither gives is refused with what to add.

## The program (`program.py`)

You don't have to write it by hand. The browser's **Setups** group shows the program's setups and operations as its
code says, and edits them through forms (from STEVE Studio's CAM forms):

- **New setup** (right-click Setups, or the "New setup…" row): the shop machine and tool setup, the stock box and its
  check grid, where the tool starts, the work offset, the checks, and what camlib needs of the machine that `shop.py`
  doesn't hold (work zero, coolant, arcs, …). Its first operation comes next; the setup is saved with it. In a new
  project the first setup writes the whole program: `Setup`, `Job` and `Program(...)`.
- **Add an operation** (right-click a setup → Add 2D / hole / 3D operation): every field is camlib's own, read from
  the installed camlib, and every field camlib requires (no default) is required in the form too: speeds, feeds and
  coolant are never assumed. Geometry is picked on the part: flat faces facing along Z (`region`), hole walls
  (`hole_centers`, or typed points), flat edges or a flat face's outline (`paths`, `path`). Tools come from the setup's
  tool setup, filtered to the cutters that fit. Option objects have their own rows: an entry (plunge, helix, from
  outside the stock, or a ramp along the path with its angle: a pocket takes any, a contour a ramp or a plunge), tabs
  (a count, a spacing, or **At points**: typed `(x, y), (x, y), …` on the part's outline; a loop without a point gets no
  tab, and camlib's report lists such loops), a trace's cutter position (on the path, or beside it to the left or
  right). An adaptive pocket's **Path** is camlib's own choice of planner: *Follow the stock* (camlib's default) or
  *Orbits*; fields the chosen path refuses (orbit radii on *Follow the stock*) aren't shown, and one the code already
  sets is marked so it can be cleared.
- **Edit** (double-click, F2), **duplicate** (Ctrl+D), **move** (drag, or Move up / down), **delete** (Delete, with
  Undo).

Each edit replaces exactly the code it changes (the operation's call, an item of the operations tuple, a keyword, an
import), so the rest of `program.py` stays as you wrote it. Code a form can't show (a computed value, your own helper)
is never rewritten: that operation opens in the code editor instead. OK on a form saves `program.py` and builds it;
tree edits save it (build to see their verdict). With unsaved changes to `program.py` in the editor, the forms wait:
save first.

A program is camlib itself (stock, setups, operations, checks: see camlib's `docs/`) plus a few helpers that bring in
the part and the shop:

```python
from links import part, shop                      # the project's part file and shop.py
from camlib import Job, Setup, StockSpec, Pocket
from camlib.motion import WorkFrame
from camlib_ui.program import Program, machine, region, slot, tool

mill = tool(shop.t_em6)
floor = region(part, "pocket_floor", name="pocket")
ops = (Pocket("pocket", mill, floor, top_z_mm=20, floor_z_mm=12, stepdown_mm=2, stepover_mm=2.5, clearance_z_mm=30,
              feed_mm_min=900, plunge_mm_min=300, spindle_rpm=11000, coolant="flood", **slot(shop.rack, mill)),)
setup = Setup("top", StockSpec((-5, -5, -6), (105, 65, 21), 0.5), (mill,), ops, (0, 0, 60))
program = Program(Job("plate", "1", (setup,)),
                  machine(shop.mill, setup, tooling=shop.rack, work_to_machine=WorkFrame((200, 150, -300)), ...))
```

| Helper | What it gives |
|---|---|
| `solid(part)` | The part as a CadQuery shape (what `camlib.cadquery` takes). |
| `face(part, name)`, `faces(part, name)` | The face(s) a name selects. |
| `region(part, *names, name=)` | Flat faces facing along Z as one camlib `PlanarRegion` (a pocket's floor, an outline). |
| `silhouette(part, z_mm, max_error_mm=, name=)` | The part's outline at a depth (the shadow of everything at or above it) as a `PlanarRegion`, from its mesh: camlib's `Engine.silhouette_region`, for a `Contour` around the whole part. A form shows it as the code it is. |
| `hole_centers(part, *names)` | The (x, y) centres of holes, from their walls: what `Drilling` and friends take. |
| `surface(part)` | The part's surface as camlib's `SurfaceMesh` (roughing targets, 3D finishing). |
| `paths(part, *names)`, `path(part, *names)` | Flat edges chained into camlib `TracePath`s. |
| `part_target(part, base_z_mm=)` | The part as camlib's material-check target (gouges and stock left). |
| `tool(shop.t_x)` | A shop tool as a camlib `ToolAssembly` (cutter and holder envelope). |
| `slot(shop.rack, tool)` | Its T number and length register in a tool setup, for an operation: `**slot(...)`. |
| `fixture(shop.vise, at=(x, y, z))` | Workholding placed in work coordinates; every move is checked against it. |
| `protected(item, at=...)` | Another part on the table that no move may touch. |
| `machine(shop.m, setup, ...)` | The shop machine as a camlib machine for the setup, with its post and its scene. |
| `Program(job, machines, accept=)` | What the build posts. |

`machine(...)` needs what the shop doesn't hold: `work_to_machine` (where the part's origin sits in machine
coordinates: the work offset's values), and the controller's premises (`flood`, `mist`, `planes`, `arcs`, `helices`,
`max_sweep_rad`, `max_tool_number`, `max_length_register`, `tool_change_position_mode`, …). A missing one is refused
by camlib with its name.

The machine's travel comes from the shop: it is the spindle gauge line's, so camlib checks every move against its own
tool's travel (that box lowered by the tool's gauge length); a finding names the tool and the limit.

`tool_change_position_mode` says where a tool change leaves the tip. `"preserve_tip"`: where it was. With
`"preserve_spindle"` no axis moves (a manual change, or a changer that comes to the spindle), so the new tip is the old
one moved along Z by the difference of the gauge lengths, and the setup is planned that way:
`Setup(..., tool_change=ToolChangeInPlace())`. The setup form writes both together; camlib refuses one without the
other. The playback starts the next move where the change left the tip, with nothing drawn in between.

`Program(..., accept={...})` releases G-code despite findings of those kinds, on purpose: `"uncertain"`,
`"violation"` or `"unchecked_machine"` (the shop declares no machine crash model). By default nothing is accepted,
so any finding refuses the G-code. The plate example accepts `unchecked_machine` and says so in its result.

## Building

**Check** runs the program and describes it (setups, stock, tools, operations, machines): nothing is planned. **Build**
also has camlib plan every setup, simulate it, check every move, post it, decode the posted G-code and replay it on the
stock, then release the G-code or refuse it.

A build runs in two processes. Stage 1 runs your files and hands back plain data only; once it has ended (and
everything it started has been killed), stage 2 rebuilds camlib's job and machines from that data, using camlib's own
posts by name, and does everything else. Your program's code never runs where its G-code is checked and released.

A build's result has, per setup and machine: the G-code (when released), camlib's findings (each at its move: click it
to see it in the playback), what wasn't checked, the moves, time and stock figures, and the playback stream
(`docs/playback-stream.md`). Builds are kept in the project's `.builds/` folder (the last 20).

Under them, **Operations** lists each operation as camlib planned it: its moves, lengths and time, and camlib's own
report, unchanged. What to read first is said in words (an adaptive clearing's proven engagement against its limit,
strokes in confined material that are cut as entry moves outside that limit, wall passes, a waterline's shadow error,
camlib's diagnostics, such as a contour's loops left without a tab); the whole report follows, every value under
camlib's own name. A report longer than 256 kB is cut, and says where.

camlib refuses what it can't do exactly (an orbit radius on the planner that follows the stock, a tab point off the
outline, a ramp with tabs): the build then shows camlib's own message, which names the value and what to change.

camlib-ui builds 3-axis milling programs. An operation the forms have no form for (camlib's `SuppliedToolpath`, whose
moves the program gives; `Deburr`; probing) is written in the code: it is built, checked, reported and played back like
any other, and opens in the code editor. Turning isn't built here: `machine(...)` refuses a lathe control. Controller
posts other than LinuxCNC come from a camlib checkout's `examples/` folder (`--camlib-posts`).
