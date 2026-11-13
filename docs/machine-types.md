# Machine types in camlib-ui: what is there, what is planned

camlib plans, checks and posts three kinds of work: 3-axis milling, turning (lathes) and plasma/laser cutting.
camlib-ui is a demonstration of camlib, so it should show all three. This page says, for each, what a project looks
like in the interface, what the interface reuses, what is missing in the server (`camlib_ui/`) and in the front end
(`web/src/`), and the order of the work with a rough size (S: an afternoon, M: a day or two, L: several days).

Everything here is for demonstration: the examples' machines, tools, speeds and feeds are example values, and no
G-code of this interface is meant for a machine (README).

Status words: **there** (on this branch, tested), **partly**, **missing**.

## What every machine type shares (reused as it is)

| Piece | Where | Why it carries over |
|---|---|---|
| Projects on disk, the code editor, builds in two processes, the build's progress | `projects.py`, `builds.py`, `build/run.py`, `build/stage1.py`, `build/progress.py` | A lathe or a plasma setup is an ordinary camlib `Setup`: stage 1 hands over camlib's compiled job as data whatever its kind. |
| camlib's verdict (released or refused), its findings, what wasn't checked, each operation's report | `build/run.py` `_post`, `web/src/cam/playback.ts`, `ResultPanel.tsx`, `cam/report.ts` | camlib's `Job.post` / `run.export` are the same calls for all three; reports are shown under camlib's own names. |
| The playback stream and the player (timeline by operation, G-code beside it, findings at their moves) | `build/stream.py`, `stream.py`, `web/src/cam/stream.ts`, `motion.ts`, `Player.tsx` | Moves are lines and arcs in work coordinates with a kind; a lathe's are in the XZ plane, a torch's in XY. |
| The shop as code and the program helpers | `shop.py`, `program.py` | `Item`/`Record`, `machine(...)`, the post table `POSTS` (it already lists camlib's plasma, laser and lathe posts). |
| The tree, the forms' reading and writing of `program.py` | `forms.py`, `web/src/cam/pyCode.ts`, `forms.ts`, `programEditor.ts`, `Sidebar.tsx` | The tree reads any `Setup(...)` and its operations tuple; an operation the forms don't know opens in the code. |

## Lathes

### What a lathe project looks like

- **Part**: a solid of revolution about Z, its front face toward +Z (`part.py` or STEP). `turned(part)` reads its
  half-section with camlib's `turning_section` (lines and arcs exact). **there**
- **Shop**: `MachineModel.lathe` (X and Z travel, the work spindle's top speed, the turret's stations, the rate), a
  lathe `Controller` (FANUC system A or Centroid CNC12), `TurningTool` items (an ISO insert by its code on a holder
  by its code, or camlib's wedge, grooving blade, face grooving blade, threading insert, drill; camlib's rectangular
  holder; the seat and insert body values camlib requires) and a `Turret` (tool per station, its offset). **there**
- **Program**: camlib's lathe `Setup` (`TurnStockSpec`, `TurnToolSetting` per tool via `station(...)`,
  `TurningSetup.from_section(turned(part), chuck_z_mm=, clearance_mm=, tolerance_mm=)`), the `Turn*` operations, and
  `machine(shop.lathe, setup, ...)`. **there**
- **Operations** (all ten of camlib's): `TurnFace`, `TurnRough`, `TurnFinish`, `TurnGroove`, `TurnPartOff`,
  `TurnThread`, `TurnDrill`, `TurnBoreRough`, `TurnBoreFinish`, `TurnFaceGroove`. All build and play back; all have
  forms (fields from the installed camlib, required where camlib has no default). **there**
- **Stock and playback**: camlib streams a turned stock: per 0.25 mm bin along Z (the `TurnStockSpec`'s `cell_mm`) the
  lower and upper bound of the bar's outer radius and of its bore's radius, plus rings removed inside the material
  (face grooves). camlib's Python `TurnStockState.accept` returns no per-move delta (its `changed_count` is 0), only
  the whole stock (`stock()`), so the build diffs the bins after every move and writes the changed ones into the same
  stream format as a milling grid (`nx` bins × 2 rows; docs/playback-stream.md "Turned stock"). The front end revolves
  the bins about Z into a closed mesh with a quarter cut away (`web/src/cam/turnedStock.ts`, `TurningView.tsx`), and
  draws the tool from its insert's and holder's outlines at the point the program moves. **there**
- **Posts**: `fanuc_lathe` (camlib `examples/fanuc_lathe_post.py`) and `centroid_lathe`
  (`examples/centroid_lathe_post.py`), from `--camlib-posts`. **there**. A LinuxCNC lathe isn't offered: camlib's
  built-in `GCodePost` writes a `Y0` word on every lathe move (camlib's own lathe posts strip them), and camlib-ui
  only uses camlib's posts as they are.
- **Verdict and report**: released or refused as for a mill; "not checked" names the machine's bodies and its travel
  (camlib checks a lathe setup against its part, bore, chuck face and stock; travel and bodies need a machine crash
  model); camlib's material comparison of the turned stock with the part (gouge and leftover per z bin); per operation
  its passes, cut length and least clearances. **there**

### Missing, in order

| # | What | Server | Front end | Size |
|---|---|---|---|---|
| L1 | A lathe **setup form** (new lathe setup, edit its bar, chuck face, clearance, tolerance, start position, turret, machine premises) | none (the outline already reads it) | `forms.ts` `readSetup`/`writeSetup`/`newProgramCode` have one milling shape: add a turning `SetupDraft` variant; `ProgramForm.tsx` `SetupForm` a second layout; `programEditor.ts` `openSetup`, `okProblem` | M |
| L2 | A **lathe view**: the axis horizontal (Z to the right, X up), a 2D half-section mode | none | `viewport/viewer.ts` keeps Z up for every named view and for "keep Z up" orbiting: add an X-up standard view for lathe setups; `turnedStock.ts` already has `turnedOutline` for a 2D section | M |
| L3 | **Face-groove rings** drawn (the stream already lists them: `stock.rings`) | none | `turnedStock.ts`: subtract each ring present at the move from the bins' material before meshing | S |
| L4 | A second example, **`bushing`**: drill on axis, bore rough and finish with a boring bar (`side="inner"`), an outside groove with a blade, part off; a third with a face groove | example files only; `shop.py` and `program.py` map all of it already (unit-tested for an inner tool) | none | S |
| L5 | **Partial-move stock**: the stock part way through the playing move (camlib has `TurnStockState.preview(frame, fraction)`), instead of at the move's end | a preview endpoint, or sub-steps written into the stream for long cuts | `TurningView.tsx` `TurnedStock` seeks whole moves | M |
| L6 | Holders from the maker's **model** (`TurningHolder.from_model`, a mesh), solid boring bars (`SolidBarHead`), free `InsertOutline`s | `shop.py` `TurningHolder`/`TurningInsert` cover camlib's parametric kinds only; `program.py` `_turning_tool`; `build/turning.py` outlines | none (the outlines drawn come from the server) | M |
| L7 | A **machine crash model** for the example lathe (camlib `docs/machine.md`, `process="turning"`), so travel and the machine's bodies are checked instead of accepted as unchecked | `shop.py`: declare bodies and axes; `program.py` `machine(crash_model=...)` already passes camlib's `MachineModel` through `encode` | the result panel already words machine findings | L |
| L8 | The tool's **real thickness and holder section** in the 3D view (now a 3 mm plate and the holder's XZ outline extruded over its `y_mm`) | `build/turning.py`: carry `insert_thickness_mm` | `TurningView.tsx` `toolGeometry` | S |

## Plasma and laser

### What a sheet project looks like

- **Parts**: flat parts as camlib `PlanarRegion`s: from a part's flat face (`region(part, "top")`, already there) or
  written as `Boundary` polygons and circles in the program. No part file is needed.
- **Shop**: a table model with a cutting head (`cutting_heads`: process, nozzle and body sizes, a laser's
  `max_power_w`), a plasma or laser `Controller`, and a cutting recipe per material and thickness (kerf, feed, cut
  height, pierce time and radius, leads). Today these are written as raw `MachineModel(...)` fields and
  `Record("sheet_cutting_recipe", ...)`: no helper.
- **Program**: `head(shop.table, shop.recipe)` (camlib `Torch`/`LaserHead` with the recipe's kerf),
  `cutting(shop.recipe, shop.table, height_mode=, lead_in_radius_mm=, lead_out_radius_mm=)` (a `ThermalCut`'s process
  values from the recipe, less what the controller owns), `camlib.Nest.for_cut(cut, sheet, parts=(NestPart(...),
  ...), part_spacing_mm=, edge_margin_mm=, resolution_mm=).run()` for the placed parts, `ThermalCut` (leads, overcut,
  small holes, micro-joints, `common_line=CommonLine(...)`, `compensation="wear"`), `ThermalMark` (strokes marked
  before the cut), a `Setup` whose `StockSpec` is the sheet, and `machine(shop.table, setup, ...)`.
- **Posts**: `qtplasmac`, `centroid_plasma`, `wincnc_plasma`, `grbl_laser` (already in `POSTS`, with what each
  controller owns: heights, pierce delay, height control).

### What already works

A plasma program written this way **builds through the interface today** (checked while writing this plan with a
6 mm sheet, six brackets and eight washers nested by `camlib.Nest`, QtPlasmaC post: 275 moves planned, every move
checked against the travel and the sheet, 428 lines of G-code released; a wrong work offset was refused by camlib as
275 travel violations). `program.py` `head`, `cutting` and the beam branch of `machine`, and `build/run.py`
`scene_of`'s tip-travel for a head, were ported with the rest. The stock is the ordinary height grid, so the playback
shows the sheet with every kerf cut through, and the stream's `lead` moves are coloured as leads. Nothing of it is
tested in `tests/`, there is no example and no documentation.

### Missing, in order

| # | What | Server | Front end | Size |
|---|---|---|---|---|
| P1 | **Shop helpers and an example** `sheet`: `MachineModel.table(travel=, head=CuttingHead.plasma(...))`, `CuttingRecipe(...)`; an example with a nest of two parts, leads, small holes, QtPlasmaC; tests like `tests/test_turning.py`; docs | `shop.py` (helpers), `examples/sheet/`, `tests/test_cutting.py`, `docs/programs.md` | none to build and play it | S–M |
| P2 | A **2D sheet view**: looking straight down by default for a sheet setup, the parts' outlines (kept) over the sheet, kerfs, lead-ins, pierce points marked, marks in their own colour | `build/run.py`: put the parts' regions, the nest's placements and camlib's report `order`/`pierces` into the setup's description; the stream needs a `mark` kind (camlib has it; `KINDS` maps it to "other" today) | `Viewport.tsx`: a `SheetView` (outlines as lines, pierce markers), the top view when the setup's tool is a beam; `motion.ts` `MOVE_KINDS` + a colour for `mark` | M |
| P3 | **Nesting shown and editable**: the nest's utilisation, min distances proven by camlib's own check, unplaced parts; a form for `NestPart` quantities, rotations, spacing, margin | `forms.py`: fields of `Nest`, `NestPart`; the description carries `nest.check` | a Nest panel in the result; a nest form (`forms.ts`, `ProgramForm.tsx`) | M–L |
| P4 | **Forms** for `ThermalCut` and `ThermalMark` (camlib's fields; `Lead`, `SmallHoles`, `MicroJoints`, `CommonLine` as option objects; parts picked as flat faces or named regions) | `forms.py` `OPERATIONS`/`OPTIONS` + thermal classes | `opSpecs.ts` specs and a `Cutting` group, `forms.ts` (a beam tool is `head(...)`, the T number and register are the operation's own, no `slot`) | M |
| P5 | Examples that show **common-line cutting** (a row of flush rectangles), **marking** (QtPlasmaC materials, or a GRBL laser with `beam_mark="power"`), **wear compensation** (`diameter_register=`), a **laser** (GRBL, `beam_s_max`) | examples and tests only | the `mark` colour of P2 | S each |
| P6 | The **torch drawn** as a nozzle and body (now a 1.5 mm "end mill" with a holder cylinder: `_tool_summary` reads the beam as a rotary tool), and the display stock simulation skipped for a sheet (camlib's grid is the truth: a kerf is one cell wide) | `build/run.py` `_tool_summary`: a `beam` shape with nozzle and body | `playback.ts` `toolProfile`/`simPlan`, `Viewport.tsx` `Tool` | S |

## Milling: more examples

`plate` (face, pocket, contour, drilling, a vise, a material check) and `cover` (adaptive pocket, ramp entry, tabs at
points) show 2D work on one flat part. camlib does much more that needs no new code in the interface, only projects
and the tests that build them:

| # | Example | Shows | What it needs |
|---|---|---|---|
| M1 | `boss` — a CAD solid with a filleted boss on a plate | 3D `Roughing` around the part (`surface(part)` as target), `Parallel` and `Waterline` finishing with a ball end mill split by slope (`slope_from_deg`/`slope_to_deg`), `Pencil` in the fillets, `Flat` on the flats; the material check against the solid with its tolerance | part.py, shop (a ball end mill), program; all forms exist (3D group). Build time is the thing to watch (camlib's `bench/workloads.py` has roughing and finishing workloads on a filleted boss to size it by) | M |
| M2 | `rest` — a pocket roughed with a 10 mm cutter, then `RestPocket` with a 4 mm one; `RestRoughing` on a 3D part | rest machining from the stock as cut (camlib reports where it cut and what it left) | forms exist | S |
| M3 | `adaptive` — a deep L pocket and an open shoulder | `AdaptivePocket` on the default planner with `StockEdgeEntry` and a `HelicalEntry`, its engagement report (already worded by `cam/report.ts`), `travel_clearance_mm` | forms exist | S |
| M4 | `holes` — a drilled, tapped and bored plate | `Drilling` with `peck_mode` and `canned_cycle=True` (G81/G83 posted as cycles), `Tapping` (rigid tap, pitch from the shop's tap), `Bore` with `FineBore`, `Reaming`, `ThreadMilling`, `Chamfer` on the hole edges | shop: tap, reamer, boring bar, thread mill, chamfer mill (helpers exist); forms exist | S |
| M5 | `engrave` — `Trace` on edges, `VCarve` of a region, `Project`/`Morph` on a surface | paths from named edges (`paths(part, ...)`) | forms exist | S |
| M6 | `two-sides` — two setups (top, then flipped in soft jaws), a fixture per setup, `protected(...)` for a neighbour | several setups and machines in one program, `{setup: machine}` | forms exist (second setup) | S |
| M7 | `probe` — `ProbeSurface`, `ProbeOutsideCorner`, `ProbeBore` before cutting, tool setting | camlib plans, simulates and posts probing cycles (camlib `docs/operations.md` "Probing and tool setting"; which posts write them is in `docs/posts.md`: to be checked per post before choosing the example's controller) | `program.py`: a shop probe → `camlib.ProbeTool` mapping (missing); the stream's kinds; no forms (written in code) | M |
| M8 | Other controllers for the same part: Haas NGC, FANUC 0i-MB, Siemens 808D, Centroid | `Program(job, [machine(shop.a, ...), machine(shop.b, ...)])`: one setup posted for several machines, each released or refused on its own | shops only | S |

## Order of work

1. **Lathe, first increment** (this branch): shop helpers, program helpers, stage 2, the turned-stock stream, the
   `shaft` example, the revolved stock and tool in the 3D view, forms for the ten turning operations, tests, docs.
2. **P1** (plasma shop helpers, the `sheet` example, tests): small, because the server path already works.
3. **L4** (bushing example: drill, bore, groove) and **M2–M4** (milling examples that only need project files).
4. **P2** (2D sheet view) and **L2** (lathe view): the two views that make the other machine types read at a glance.
5. **L1** (lathe setup form), **P4** (cutting forms), **P3** (nesting).
6. **M1**, **M7**, **L5–L8**, **P5–P6**.
