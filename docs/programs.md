# Writing a program

A camlib-ui project is a folder with three kinds of file:

| File | What it is |
|---|---|
| `part.step`, `part.stp` or `part.py` | The part the program machines (optional). A STEP file, or a CadQuery script that sets `result`. |
| `shop.py` | Your shop: machines, controllers, tools, tool setups and fixtures, in Python. A project without one uses the projects folder's `shop.py`. |
| `program.py` | The program: a camlib `Job`, and the machine each setup is posted for, as `program = Program(...)`. |

Anything else in the folder (helper modules, fixture bodies such as the example's `vise.py`) can be imported or
referenced by these. The `plate` example (`camlib_ui/examples/plate/`) is a complete project; start from it. The
`cover` example beside it shows an adaptive pocket on camlib's default planner, a ramp entry and tabs at points. The
`shaft` example is a lathe project ([Lathes](#lathes)), the `sheet` example a plasma table's
([Plasma and laser tables](#plasma-and-laser-tables)).

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
other record (a fixture, for one). See `camlib_ui/shop.py` and the example's `shop.py`. A lathe's and a plasma or
laser table's helpers are in [Lathes](#lathes) and [Plasma and laser tables](#plasma-and-laser-tables).

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

While a build runs, each operation's progress is on its own row of the browser, next to the toolpath it belongs to
(how far camlib is with it and a bar along the row, then its moves and time once planned); the setup's row and the top
bar say the stage, and so does the Result panel, which also lists the operations while the left panel is hidden. They show the stage (running the program, planning,
posting and checking, writing the playback, deciding the release) and, while camlib plans, each of the setup's
operations as pending, being planned or done. The operation being planned shows how far along it is where camlib
counts something: depth levels, finishing passes, or the area cleared by an adaptive clearing (camlib's planning
progress, `camlib.simulation.ProgressUpdate`). An operation camlib counts nothing for (drilling, facing) shows a moving
bar and no percentage, and there is no percentage for the whole build: none is estimated. The model tree marks the same
operations. With a camlib that has no planning progress, the stage and the operations finished so far are shown. This
is for watching only: nothing of it is kept in the build's result, and the build is the same with or without it.

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

camlib-ui builds 3-axis milling programs, lathe programs ([Lathes](#lathes)) and plasma or laser cutting programs
([Plasma and laser tables](#plasma-and-laser-tables)). An operation the forms have no form
for (camlib's `SuppliedToolpath`, whose moves the program gives; `Deburr`; probing) is written in the code: it is built,
checked, reported and played back like any other, and opens in the code editor. Controller posts other than LinuxCNC
come from a camlib checkout's `examples/` folder (`--camlib-posts`).

## Lathes

A lathe project is the same three files. The `shaft` example (`camlib_ui/examples/shaft/`) is a complete one: a bar
faced, roughed, finished (a thread relief with a fillet, followed as an arc), threaded and parted off, posted with
camlib's FANUC lathe post. The `bushing` example beside it drills a hole on the axis, bores it with a boring bar
(`side="inner"`), turns the outside to size, grooves it with a blade and parts off, on camlib's Centroid lathe post.
Their values are example values, not a real machine's or a tool maker's.

**The part** is a solid of revolution about its Z axis with its front face toward +Z. The lathe's Z is the part's Z and
the lathe's X is the radius; the centre of the front face is the program's zero. `turned(part)` reads its half-section
with camlib's own `camlib.cadquery.turning_section`, lines and arcs exact; camlib refuses a solid that isn't one of
revolution (flats, cross holes, undercuts) and says why.

**The shop** holds the lathe, its turning tools and its turret:

```python
model = shop.add(MachineModel.lathe("lathe_model", "Example lathe", x_travel=(0, 150), z_travel=(-400, 50),
                                    max_rpm=4000, stations=8, rapid=8000))
control = shop.add(Controller("control", "FANUC 0i-TF", dialect="fanuc_lathe_system_a_v1", processes=("turning",),
                              linear_resolution_mm=0.001))
lathe = shop.add(Machine("lathe", "Example lathe", model=model, controller=control))
t_rough = shop.add(TurningTool("t_rough", "CCMT 12 04 08 on SCLCR 2525", side="outer", hand="right",
                               insert=TurningInsert.iso_code("CCMT120408", holder="SCLCR2525M12"),
                               holder=TurningHolder.rectangle(width=25, length=150, offset=0, y=(-25, 3)), seat=(0, 0)))
turret = shop.add(Turret("turret", "Turret", tools={1: t_rough, ...}))
```

| Helper | What it is |
|---|---|
| `MachineModel.lathe(key, name, x_travel=, z_travel=, max_rpm=, stations=, rapid=)` | A two-axis lathe: X (the radius, away from the spindle axis toward the tool) and Z travel in machine coordinates, the work spindle's top speed, the turret's stations, the axes' rate. |
| `TurningInsert.iso_code(code, holder= or approach_angle=)`, `.iso(...)`, `.groove(width=, depth=)`, `.face_groove(...)`, `.thread(profile_angle=, depth=)`, `.drill(diameter=, point_angle=, flute_length=)` | An insert, as camlib's `TurningInsert.iso_code`/`iso`, `GrooveInsert`, `FaceGrooveInsert`, `ThreadInsert` or `DrillInsert`. |
| `TurningHolder.rectangle(width=, length=, offset=, y=)` | camlib's rectangular holder (`TurningHolder.rectangle`), with its extent across the centre plane. |
| `TurningTool(key, name, insert=, side=, hand=, holder=, seat=, nose_radius=, insert_thickness=, insert_clearance=, …)` | A tool as it sits in the turret: camlib's `TurningTool`, field for field. camlib requires every value (the seat's rake and inclination, the insert's thickness and clearance unless its ISO code gives them, a blade's corner radius) and refuses a tool with one missing, by name. |
| `Turret(key, name, tools={station: tool, station: (tool, {"offset": n})})` | The tools by turret station; a station's offset register is its own number unless it says otherwise. |

Lathe controllers and their posts: `fanuc_lathe_system_a_v1` (camlib's `examples/fanuc_lathe_post.py`, G-code system A)
and `centroid_lathe_v1` (`examples/centroid_lathe_post.py`, Centroid CNC12). Both come from `--camlib-posts`.

**The program** is camlib's own lathe setup, with three helpers:

```python
from links import part, shop
from camlib import Job, Setup, TurnFace, TurnFinish, TurnRough, TurnStockSpec, TurningSetup
from camlib_ui.program import Program, machine, station, tool, turned

rough = tool(shop.t_rough)                               # a shop TurningTool as camlib's, its id the shop key
ops = (TurnFace("face", "t_rough", z_mm=0, feed_mm_rev=0.15, rpm=1200),
       TurnRough("rough", "t_rough", depth_of_cut_mm=2, allowance_mm=0.3, feed_mm_rev=0.25, rpm=1200))
setup = Setup("turn", stock=TurnStockSpec(z_min_mm=-60, z_max_mm=2, outer_radius_mm=20),
              tools=(station(shop.turret, rough),), operations=ops, initial_position_mm=(40, 0, 30),
              turning=TurningSetup.from_section(turned(part), chuck_z_mm=-50, clearance_mm=2, tolerance_mm=0.01))
program = Program(Job("shaft", "1", (setup,)),
                  machine(shop.lathe, setup, flood=True, mist=False, arcs=True, helices=False, max_sweep_rad=math.tau,
                          max_tool_number=8, max_length_register=8, program_number=1001),
                  accept={"unchecked_machine"})
```

| Helper | What it gives |
|---|---|
| `tool(shop.t_x)` | A shop `TurningTool` as camlib's `TurningTool` (a turning operation names it by its id, the shop key). |
| `station(shop.turret, tool)` | Its turret station and offset as camlib's `TurnToolSetting`: what a lathe setup's `tools` hold. |
| `turned(part)` | The part's half-section (`profile`, `bore`, `face_grooves`) for `TurningSetup.from_section`. |
| `machine(shop.lathe, setup, ...)` | The shop lathe as a camlib machine with its post. No `tooling=` (the stations are the setup's), no `fixtures=` (the workholding is the setup's chuck face, `chuck_z_mm`); `work_to_machine` is optional. From the shop: the spindle's top speed, the axes' rate, units and decimals. The posts set `planes` and `tool_change_position_mode` themselves. |

camlib plans a lathe setup's operations (`TurnFace`, `TurnRough`, `TurnFinish`, `TurnGroove`, `TurnPartOff`,
`TurnThread`, `TurnDrill`, `TurnBoreRough`, `TurnBoreFinish`, `TurnFaceGroove`: camlib's `docs/operations.md`,
"Turning") and checks every move, planned and posted, against the part, its bore, the chuck face and the stock: the
insert, its body below the cutting face, and the holder. A move it can't make is the build's error, in camlib's own
words (which tool, where, by how much).

What a lathe build's result says:

- **Not checked**: the machine's own bodies and its travel. camlib checks those only with a machine crash model
  (camlib's `docs/machine.md`), which the shop here doesn't declare; the program accepts `unchecked_machine` on
  purpose, and the travel is listed too. A lathe setup takes no fixtures or milling checks (camlib refuses them).
- **Material**: camlib's comparison of the turned stock with the part, per z bin. A gouge stops the build; material
  left (a nose radius in a corner, a roughing allowance) is reported, not refused.
- **Operations**: each one's passes, cut length and least clearances to the part and the holder, as camlib reported.

In the 3D view the bar is drawn whole, revolved about Z: it is camlib's own turned stock at the playback position (per
0.25 mm bin along Z, the most material that may still be there), with the tool's insert and holder outlines at the
point the program moves. A lathe project opens with the spindle axis across the screen, the chuck on the left and the
radius up. While the playback runs with the spindle on, the bar and a chuck drawn behind the chuck face turn (the
player's Spin toggle): slowed down to be seen, three lines along the bar and the jaws showing it. The chuck is a
picture, not a model of yours, and nothing is checked against it. Before a build the bar is shown with the part's half-section and the chuck face (dashed).

The tree lists a lathe setup and its operations from the code, and the forms edit its operations as they do a mill's:
right-click the setup → **Add turning operation**, or use the ribbon (with a lathe setup selected it shows the turning
operations, grouped Turning, Grooving, Holes and Threading, in place of the milling ones), double-click an operation to edit
it, drag, duplicate and delete. Every field is camlib's own, and the ones camlib requires (the feed per revolution and
the speed among them) are required in the form. A turning operation takes no geometry: the part's half-section is the
setup's. Its tool is chosen from the setup's turret (the tools whose insert fits the operation: a blade for a groove, a
boring-side insert for a bore) and written as its id; a tool the program doesn't use yet gets its `tool(shop.…)` and
its `station(...)` in the setup's tools. The milling operations aren't offered for a lathe setup, nor the turning ones
for a mill's.

The lathe **setup** itself (its bar, its chuck face, its machine) is edited in the code for now: the setup form
writes milling setups. [machine-types.md](machine-types.md) lists what is planned.


## Plasma and laser tables

A sheet project needs no part file: its parts are flat outlines. The `sheet` example (`camlib_ui/examples/sheet/`)
nests six brackets and eight washers on a 500 × 300 mm sheet with camlib's `Nest` and cuts them with a plasma torch,
posted with camlib's QtPlasmaC post. Its values are example values, not a real table's or a torch maker's cut chart.

**The shop** holds the table, its head and a cutting recipe per material and thickness:

```python
model = shop.add(MachineModel.table("table_model", "Example plasma table", travel=(1300, 650, 100), rapid=15000,
                                    head=CuttingHead.plasma("torch", nozzle_diameter=12, nozzle_length=20,
                                                            body_diameter=35, body_length=120)))
control = shop.add(Controller("control", "LinuxCNC QtPlasmaC", dialect="linuxcnc_qtplasmac_v1", processes=("plasma",),
                              linear_resolution_mm=0.001))
table = shop.add(Machine("table", "Example plasma table", model=model, controller=control))
steel6 = shop.add(CuttingRecipe("steel6", "6 mm mild steel, 45 A", process="plasma", kerf=1.5, feed=2500, cut_height=1.5,
                                pierce_seconds=0.5, pierce_radius=2.25, lead_in=2, lead_out=1))
```

| Helper | What it is |
|---|---|
| `MachineModel.table(key, name, travel=(x, y, z), head=, rapid=)` | A gantry carrying one cutting head: the head mount's travel (Z from -z up to 0) and rate. |
| `CuttingHead.plasma(id, nozzle_diameter=, nozzle_length=, body_diameter=, body_length=)`, `CuttingHead.laser(..., max_power_w=)` | The head as camlib checks it against the work: its nozzle and body. A laser's full power. |
| `CuttingRecipe(key, name, process=, kerf=, feed=, cut_height=, pierce_seconds=, pierce_radius=, lead_in=, lead_out=, pierce_height=, clearance=, power_w=)` | A line of the cut chart: the kerf, the feed and cut height, the pierce's time and splash radius, the leads' straight lengths; the pierce and travel heights when the program moves Z itself; a laser's power. |

A control that runs in inches is declared so in the shop: `Controller(..., output_units="inch",
linear_resolution_in=0.0001)`. Programs are then posted in inches at that resolution (`G20`; the program, the shop's
travel and the cut chart stay in millimetres). A resolution in the other unit than the control's is refused.

Controllers and their posts (all from `--camlib-posts`): `linuxcnc_qtplasmac_v1` (QtPlasmaC), `centroid_plasma_v1`
(Centroid CNC12 plasma), `wincnc_plasma_v1` (WinCNC), `grbl_laser_v1` (GRBL in laser mode; `machine(...,
beam_s_max=<$30>)`). Each post says what its controller does itself: QtPlasmaC owns Z, the pierce height and the pierce
delay, so its cuts are planned with `height_mode="fixed"`.

**The program** is camlib's `ThermalCut` on a `Setup` whose stock is the sheet:

```python
from links import shop
from camlib import Job, Nest, NestPart, Setup, StockSpec, ThermalCut
from camlib.planar import Boundary, Component, PlanarRegion
from camlib_ui.program import Program, cutting, head, machine

bracket = PlanarRegion("bracket", (Component(outline, (hole, hole)),), 0)       # a part: its outline, then its holes
torch = head(shop.table, shop.steel6)                                            # camlib's Torch, the recipe's kerf
process = cutting(shop.steel6, shop.table, height_mode="fixed", lead_in_radius_mm=3, lead_out_radius_mm=2)
cut = ThermalCut("cut", torch, None, tool_number=1, length_register=1, **process)
nest = Nest.for_cut(cut, sheet, parts=(NestPart(bracket, quantity=6, rotations_deg=(0, 90)),),
                    part_spacing_mm=3, edge_margin_mm=10, resolution_mm=1).run()
cut = dataclasses.replace(cut, parts=nest.region)
setup = Setup("sheet", StockSpec((0, 0, 0), (500, 300, 6), 0.5), (torch,), (cut,), (0, 0, 40), verification=...)
program = Program(Job("sheet", "1", (setup,)), machine(shop.table, setup, work_to_machine=WorkFrame((100, 100, -190)), ...))
```

| Helper | What it gives |
|---|---|
| `head(shop.table, shop.recipe)` | The table's head as camlib's `Torch` or `LaserHead`: its kerf the recipe's, its nozzle and body the shop's. |
| `cutting(shop.recipe, shop.table, height_mode=, lead_in_radius_mm=, lead_out_radius_mm=)` | A `ThermalCut`'s process values from the recipe (feed, cut height, pierce delay and clearance, leads, power), less what the controller owns. |
| `machine(shop.table, setup, work_to_machine=, ...)` | The table as a camlib machine with its post. No `tooling=`: the one tool is the head, its T number and register the operation's. The travel checked is the torch tip's: the head mount's, lowered by the head's length. |

camlib's `Nest` places the copies and proves the distances between what is cut for any two parts and to the sheet's
edge; it refuses a nest that doesn't fit and says which part. `ThermalCut` orders the loops (holes before their
outline), runs the kerf beside each part, places every pierce and lead in the scrap and proves them clear of every
part before any motion; its report (the result's Operations) lists the parts, loops, pierces and the order. Leads,
overcut, `SmallHoles`, `MicroJoints`, `CommonLine` and `ThermalMark` are camlib's (its `docs/operations.md`, "Plasma
and laser cutting").

**Parts from a drawing, the nest and the remnant.** The `nest` example (`camlib_ui/examples/nest/`) is the workflow
for cutting your own parts:

1. **Import DXF** (ribbon, Sheet) puts a drawing in the project. `dxf_parts("parts.dxf", unit_mm=1,
   join_tolerance_mm=0.01)` reads it: each closed outline is a part, with the holes drawn inside it, in the order they
   are drawn. `unit_mm` is 1 for a drawing in millimetres and 25.4 for inches; both values are stated, never guessed.
   Lines, arcs, circles and polylines are read; a spline, an ellipse, a block or an open outline is refused with the
   entity it is about (explode or close it in the drawing).
2. **Nest** (ribbon, Sheet) edits the program's `layout = Nest.for_cut(cut, sheet, parts=(NestPart(...), ...), ...)`:
   copies and rotations per part, the material left between cuts and to the sheet's edge, and where the nest starts
   (`start_corner`, `fill_axis`): the remnant is left on the far side. camlib places the copies and proves the
   spacing, or refuses naming the parts that don't fit.
3. **Cut** edits the `ThermalCut`. Two of its options matter on a real table: the cut order (`SpreadHeat(min_distance_mm)`
   keeps two parts cut one after the other apart, against heat building up in one place) and
   `AvoidCutParts(clearance_mm)`, which keeps rapids off parts and slugs already cut free (they can tip up between the
   slats); a rapid with no way round is refused. Both distances are yours.
4. **Remnant** (ribbon, Sheet) downloads `remnant.dxf` from the build: what is left of the sheet, from
   `layout.remnant(nest, remnant_margin_mm=3)`, handed out with `Program(..., outputs={"remnant.dxf":
   write_regions(remnant.pieces[0])})`. Import it into the next project and use it as the sheet:
   `(sheet,) = dxf_parts("remnant.dxf", unit_mm=1, join_tolerance_mm=0.001)`. It is in the coordinates of the sheet
   it was cut from, so the plate goes back against the same corner; it is the planned remnant, not a measured one.

**The forms.** With a sheet setup selected the ribbon's Cutting group has **Cut** (`ThermalCut`) and **Mark**
(`ThermalMark`); double-click an operation to edit it. A cut's form takes the head (the program's
`head(shop.<machine>, shop.<recipe>)`), the parts (a nest's `.region`, or a `PlanarRegion` the program makes), the
overcut, the lead arcs' radii, whose heights are used (`height_mode`), torch height control, small holes,
micro-joints, common lines and kerf compensation. Feed, cut height, pierce and lead lengths are not fields: they are
the shop's recipe, shown in the form and written as `**cutting(shop.<recipe>, shop.<machine>, ...)`. A cut written
with a `**plan` dict of keywords (as the example's is) reads into the form and is written back as one call. A
mark's lines are typed one per row as their points on the sheet, `(x, y), (x, y)`, and written as
`polyline(...)` paths (`camlib_ui.program.polyline`); its feed, height, power and width are the form's, since a
recipe holds none. How a machine marks is the machine's own: camlib's QtPlasmaC post takes
`machine(..., mark_material=, cut_material=, material_wait_s=)` (two entries of the table's material file) and
refuses a program with a mark without them; the Centroid and WinCNC plasma posts declare no marking.

In the playback the sheet is camlib's own stock grid: every kerf is cut through it as the torch passes, lead moves are
drawn in their own colour, and the view cube’s top view looks straight down on the sheet. The head is drawn as a
torch inside the nozzle and body the shop declares (what camlib checks against the sheet). While a cut or lead move
plays, its arc is shown: the jet through the sheet, its glare and light, and sparks. The sheet lies on a slat table.
The arc, the sparks and the table are drawn for context only: no table is declared to camlib and nothing is checked
against them (the player's stock note says so; the Fixtures toggle hides the table).
