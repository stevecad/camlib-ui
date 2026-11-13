/**
 * The milling and turning operations the program forms write (from STEVE Studio's camlibOps.ts), one spec per camlib operation: its
 * label and group, the shop cutters it takes, what geometry it takes from the part, and how each of camlib's fields
 * shows. camlib's own fields (their order, type and default) come from the installed camlib (GET /api/operation-fields,
 * camlib_ui/forms.py), so the forms match the camlib that builds. A required field (no default in camlib) is required in
 * the form too: cutting data is never assumed.
 */

/** Shop cutter types (shop.py's cutters: rotary_cutter cutter_type). */
export type CutterType = 'flat_end_mill' | 'ball_end_mill' | 'bull_end_mill' | 'drill' | 'chamfer_mill' | 'face_mill' | 'reamer' | 'tap' | 'thread_mill' | 'boring_bar' | TurningToolType;
/**
 * A shop turning tool (shop.py's TurningTool) by what it cuts: its insert's kind and, where it matters, the side it
 * cuts on (an outside tool, or a boring tool cutting outward in a hole).
 */
export type TurningToolType = 'turn_outer' | 'turn_inner' | 'groove_outer' | 'groove_inner' | 'thread_outer' | 'thread_inner' | 'face_groove' | 'turn_drill';
/** A shop turning tool's type from its insert's type and its side (null: an insert the forms don't know). */
export function turningToolType(insert: string | undefined, side: string | undefined): TurningToolType | null {
  const inner = side === 'inner';
  if (insert === 'iso' || insert === 'iso_code') return inner ? 'turn_inner' : 'turn_outer';
  if (insert === 'groove') return inner ? 'groove_inner' : 'groove_outer';
  if (insert === 'thread') return inner ? 'thread_inner' : 'thread_outer';
  if (insert === 'face_groove') return 'face_groove';
  if (insert === 'drill') return 'turn_drill';
  return null;
}

/**
 * Geometry an operation takes from the part, and the camlib_ui.program helper each is written as:
 * region (flat faces facing along Z) → region(part, ...); surface → surface(part); holes (hole walls) → hole_centers(part, ...)
 * or typed points; paths (flat edges, or a face's) → paths(part, ...); path (one chain of flat edges) → path(part, ...); point → (x, y).
 */
export type GeometryKind = 'region' | 'surface' | 'holes' | 'paths' | 'path' | 'point';

export type Group = '2D' | 'Holes' | '3D' | 'Turning' | 'Cutting';

export interface OpSpec {
  cls: string;
  label: string;
  group: Group;
  /** What it does, for the menu's tooltip and the form's head. */
  about: string;
  /** Shop cutters that fit it. */
  cutters: CutterType[];
  /** Its geometry fields. */
  geometry: Record<string, GeometryKind>;
  /** The id prefix of a new one. */
  prefix: string;
  /** A lathe setup's operation (camlib.turning): its tool is a turret tool named by its id, with no geometry to pick. */
  turning?: boolean;
  /**
   * A sheet setup's operation (plasma, laser): its tool is the setup's cutting head (the program's head(shop.<machine>,
   * shop.<recipe>)), its parts a flat region the program makes (a PlanarRegion, a nest's region).
   */
  thermal?: boolean;
}

/** What a setup machines, and so which operations it takes. */
export type SetupKind = 'mill' | 'lathe' | 'sheet';
export const kindOfSpec = (spec: OpSpec | undefined): SetupKind => (spec?.turning ? 'lathe' : spec?.thermal ? 'sheet' : 'mill');
export const KIND_NAMES: Record<SetupKind, string> = { mill: 'a milling setup', lathe: 'a lathe setup', sheet: 'a plasma or laser setup' };
export const KIND_OPS: Record<SetupKind, string> = { mill: 'milling', lathe: 'turning', sheet: 'cutting' };

const MILLS: CutterType[] = ['flat_end_mill', 'bull_end_mill', 'face_mill'];
const BALL: CutterType[] = ['ball_end_mill'];

export const OP_SPECS: OpSpec[] = [
  { cls: 'Facing', label: 'Face', group: '2D', prefix: 'face', cutters: MILLS, geometry: {}, about: 'Level the whole stock top down to a height.' },
  { cls: 'Pocket', label: 'Pocket', group: '2D', prefix: 'pocket', cutters: ['flat_end_mill', 'bull_end_mill'], geometry: { region: 'region' }, about: 'Clear inside the picked floor faces (their holes stay as islands).' },
  { cls: 'AdaptivePocket', label: 'Adaptive pocket', group: '2D', prefix: 'adaptive', cutters: ['flat_end_mill', 'bull_end_mill'], geometry: { region: 'region' }, about: 'Clear a pocket with the cutter’s engagement held below a limit.' },
  { cls: 'RestPocket', label: 'Rest pocket', group: '2D', prefix: 'rest', cutters: ['flat_end_mill', 'bull_end_mill'], geometry: { region: 'region' }, about: 'Clear only what the operations before left in a pocket, with a smaller cutter.' },
  { cls: 'Roughing', label: 'Rough', group: '2D', prefix: 'rough', cutters: ['flat_end_mill', 'bull_end_mill'], geometry: { target: 'surface' }, about: 'Clear the stock around the part, depth by depth, protecting the whole part.' },
  { cls: 'RestRoughing', label: 'Rest rough', group: '2D', prefix: 'rest_rough', cutters: ['flat_end_mill', 'bull_end_mill'], geometry: { target: 'surface' }, about: 'Rough only what the operations before left around the part.' },
  { cls: 'Contour', label: 'Contour', group: '2D', prefix: 'contour', cutters: ['flat_end_mill', 'bull_end_mill'], geometry: { region: 'region' }, about: 'Cut around the walls of the picked faces, depth by depth, with leads and tabs.' },
  { cls: 'TrochoidalSlot', label: 'Slot', group: '2D', prefix: 'slot', cutters: ['flat_end_mill'], geometry: { start_mm: 'point', end_mm: 'point' }, about: 'A straight slot wider than the cutter, with the engagement held below a limit.' },
  { cls: 'Chamfer', label: 'Chamfer', group: '2D', prefix: 'chamfer', cutters: ['chamfer_mill'], geometry: { region: 'region' }, about: 'Bevel the top edges of the picked faces with a chamfer mill.' },
  { cls: 'Trace', label: 'Trace', group: '2D', prefix: 'trace', cutters: ['chamfer_mill', 'flat_end_mill', 'ball_end_mill'], geometry: { paths: 'paths' }, about: 'Follow the picked edges at depth with the tool centre (engraving, slots along a path).' },
  { cls: 'VCarve', label: 'V-carve', group: '2D', prefix: 'vcarve', cutters: ['chamfer_mill'], geometry: { region: 'region' }, about: 'Carve the picked faces’ shape with a V bit, as deep as each point needs.' },
  { cls: 'Drilling', label: 'Drill', group: 'Holes', prefix: 'drill', cutters: ['drill'], geometry: { centers_mm: 'holes' }, about: 'Drill or peck the picked holes.' },
  { cls: 'Bore', label: 'Bore', group: 'Holes', prefix: 'bore', cutters: ['flat_end_mill', 'bull_end_mill'], geometry: { centers_mm: 'holes' }, about: 'Mill round holes larger than the cutter: helical entry, then widening rings.' },
  { cls: 'Reaming', label: 'Ream', group: 'Holes', prefix: 'ream', cutters: ['reamer', 'boring_bar'], geometry: { centers_mm: 'holes' }, about: 'Ream or single-point bore drilled holes to size (fine boring with a boring bar).' },
  { cls: 'Tapping', label: 'Tap', group: 'Holes', prefix: 'tap', cutters: ['tap'], geometry: { centers_mm: 'holes' }, about: 'Rigid-tap drilled holes.' },
  { cls: 'ThreadMilling', label: 'Thread mill', group: 'Holes', prefix: 'thread', cutters: ['thread_mill'], geometry: { centers_mm: 'holes' }, about: 'Mill a thread helically in a hole or around a boss.' },
  { cls: 'Parallel', label: 'Parallel', group: '3D', prefix: 'parallel', cutters: BALL, geometry: { surface: 'surface' }, about: 'Finish the part’s surface in parallel rows with a ball end mill.' },
  { cls: 'Waterline', label: 'Waterline', group: '3D', prefix: 'waterline', cutters: BALL, geometry: { surface: 'surface' }, about: 'Finish steep walls in constant-height loops with a ball end mill.' },
  { cls: 'Scallop', label: 'Scallop', group: '3D', prefix: 'scallop', cutters: BALL, geometry: { surface: 'surface' }, about: 'Finish with an even stepover along the surface, steep and shallow alike.' },
  { cls: 'Pencil', label: 'Pencil', group: '3D', prefix: 'pencil', cutters: BALL, geometry: { surface: 'surface' }, about: 'Follow the inside corners and valleys where the ball touches two faces.' },
  { cls: 'Spiral', label: 'Spiral', group: '3D', prefix: 'spiral', cutters: BALL, geometry: { surface: 'surface', center_mm: 'point' }, about: 'Finish in one spiral about a centre.' },
  { cls: 'Radial', label: 'Radial', group: '3D', prefix: 'radial', cutters: BALL, geometry: { surface: 'surface', center_mm: 'point' }, about: 'Finish in straight spokes from a centre.' },
  { cls: 'Project', label: 'Project', group: '3D', prefix: 'project', cutters: BALL, geometry: { surface: 'surface', paths: 'paths' }, about: 'Follow the picked edges on the part’s surface with the ball resting on it.' },
  { cls: 'Morph', label: 'Morph', group: '3D', prefix: 'morph', cutters: BALL, geometry: { surface: 'surface', from_path: 'path', to_path: 'path' }, about: 'Passes blended between two edge chains, on the surface.' },
  { cls: 'Flat', label: 'Flat areas', group: '3D', prefix: 'flat', cutters: ['flat_end_mill'], geometry: { surface: 'surface' }, about: 'Finish every flat area of the part at its exact height with a flat end mill.' },
  // Lathe setups (camlib.turning): the part's half-section is the setup's, so none of them takes geometry.
  { cls: 'TurnFace', label: 'Face', group: 'Turning', prefix: 'face', turning: true, cutters: ['turn_outer'], geometry: {}, about: 'Passes across the front of the bar, past the axis, down to a Z.' },
  { cls: 'TurnRough', label: 'Rough', group: 'Turning', prefix: 'rough', turning: true, cutters: ['turn_outer'], geometry: {}, about: 'Axial passes down to the part plus an allowance, with a pass at every diameter of the profile.' },
  { cls: 'TurnFinish', label: 'Finish', group: 'Turning', prefix: 'finish', turning: true, cutters: ['turn_outer'], geometry: {}, about: 'Follow the whole profile from the front face, arcs as arcs, the nose a radius outside it.' },
  { cls: 'TurnGroove', label: 'Groove', group: 'Turning', prefix: 'groove', turning: true, cutters: ['groove_outer', 'groove_inner'], geometry: {}, about: 'Plunge a grooving blade across a groove that is in the profile (or, with a boring-side blade, in the bore).' },
  { cls: 'TurnPartOff', label: 'Part off', group: 'Turning', prefix: 'part_off', turning: true, cutters: ['groove_outer'], geometry: {}, about: 'Plunge a parting blade to the axis at the part’s back face.' },
  { cls: 'TurnThread', label: 'Thread', group: 'Turning', prefix: 'thread', turning: true, cutters: ['thread_outer', 'thread_inner'], geometry: {}, about: 'Single-point threading: spindle-synchronized passes of constant chip area.' },
  { cls: 'TurnDrill', label: 'Drill', group: 'Turning', prefix: 'drill', turning: true, cutters: ['turn_drill'], geometry: {}, about: 'Drill on the spindle axis to a Z, in full-retract pecks if set. The hole must be in the part’s bore.' },
  { cls: 'TurnBoreRough', label: 'Bore rough', group: 'Turning', prefix: 'bore_rough', turning: true, cutters: ['turn_inner'], geometry: {}, about: 'Open the hole already there in axial passes, up to the bore less an allowance.' },
  { cls: 'TurnBoreFinish', label: 'Bore finish', group: 'Turning', prefix: 'bore_finish', turning: true, cutters: ['turn_inner'], geometry: {}, about: 'Follow the bore from the front face to a Z, arcs as arcs.' },
  { cls: 'TurnFaceGroove', label: 'Face groove', group: 'Turning', prefix: 'face_groove', turning: true, cutters: ['face_groove'], geometry: {}, about: 'Axial plunges across an annular groove in the front face (declared on the setup: face_grooves).' },
  // Sheet setups (plasma, laser): the head and its cut chart are the shop's, the parts a flat region of the program.
  { cls: 'ThermalCut', label: 'Cut', group: 'Cutting', prefix: 'cut', thermal: true, cutters: [], geometry: {}, about: 'Cut the parts out of the sheet: holes before outlines, the kerf beside the part, each loop pierced in the scrap and entered over a lead. Feed, heights, pierce and leads are the shop’s cutting recipe.' },
  { cls: 'ThermalMark', label: 'Mark', group: 'Cutting', prefix: 'mark', thermal: true, cutters: [], geometry: {}, about: 'Trace lines on the sheet’s surface without cutting through (part numbers, bend lines), before the parts are cut. The machine’s post must say how it marks.' },
];

export const OP_BY_CLASS: Record<string, OpSpec> = Object.fromEntries(OP_SPECS.map((spec) => [spec.cls, spec]));

export interface NestedChoice { classes: string[]; label: (cls: string) => string; none?: string }
const ENTRY_LABELS: Record<string, string> = { HelicalEntry: 'Helix', StockEdgeEntry: 'From outside the stock', RampEntry: 'Ramp along the path' };
const entryLabel = (cls: string) => ENTRY_LABELS[cls] ?? cls;
const POCKET_ENTRIES = ['HelicalEntry', 'StockEdgeEntry'];

/** Option objects an operation's field may hold, by field name (what a form reads: every class the field can hold). */
export const NESTED: Record<string, NestedChoice> = {
  entry: { classes: [...POCKET_ENTRIES, 'RampEntry'], label: entryLabel, none: 'Plunge' },
  side_offset: { classes: ['TraceSideOffset'], label: () => 'Beside the path (cutter radius)', none: 'On the path' },
  clearing: { classes: ['RasterClearing', 'OffsetClearing', 'AdaptiveClearing'], label: (cls) => ({ RasterClearing: 'Raster', OffsetClearing: 'Offset', AdaptiveClearing: 'Adaptive' })[cls] ?? cls },
  tabs: { classes: ['Tabs'], label: () => 'Tabs', none: 'No tabs' },
  fine_bore: { classes: ['FineBore'], label: () => 'Fine bore', none: 'Off' },
  helix: { classes: ['HelicalEntry'], label: () => 'Helix', none: 'Outside the stock only' },
  small_holes: { classes: ['SmallHoles'], label: () => 'Slower, height control off', none: 'Cut like the rest' },
  micro_joints: { classes: ['MicroJoints'], label: () => 'Leave bridges', none: 'None' },
  common_line: { classes: ['CommonLine'], label: () => 'Share one cut', none: 'Off' },
};

/**
 * The classes one operation's field offers, where camlib takes fewer than the field can hold elsewhere (it refuses the
 * others, naming them): a contour's entry is a ramp around its loop or a plunge (camlib Contour); adaptive pockets, rest
 * pockets and roughing fit a helix or enter from outside the stock, never a ramp (camlib RampEntry).
 */
const NESTED_FOR: Record<string, NestedChoice> = {
  'Contour.entry': { classes: ['RampEntry'], label: entryLabel, none: 'Plunge' },
  'AdaptivePocket.entry': { classes: POCKET_ENTRIES, label: entryLabel, none: 'Plunge' },
  'RestPocket.entry': { classes: POCKET_ENTRIES, label: entryLabel, none: 'Plunge' },
  'Roughing.entry': { classes: POCKET_ENTRIES, label: entryLabel, none: 'Plunge' },
  'RestRoughing.entry': { classes: POCKET_ENTRIES, label: entryLabel, none: 'Plunge' },
};
/** What a field of `cls` offers (an operation's or an option object's class); undefined: not an option object. */
export const nestedOf = (cls: string | null | undefined, key: string): NestedChoice | undefined => NESTED_FOR[`${cls}.${key}`] ?? NESTED[key];

export type Section = 'geometry' | 'heights' | 'passes' | 'cutting' | 'options' | 'advanced';

export interface FieldView {
  label: string;
  unit?: string;
  section: Section;
  help?: string;
  choices?: [string, string][];
}

const v = (label: string, section: Section, unit?: string, help?: string, choices?: [string, string][]): FieldView => ({ label, section, unit, help, choices });
const MM = 'mm', FEED = 'mm/min', DEG = '°';
const SENSE: [string, string][] = [['climb', 'Climb'], ['conventional', 'Conventional']];

/** How camlib's fields show, by name (the same name means the same thing in every operation). */
export const FIELD_VIEW: Record<string, FieldView> = {
  // Geometry
  region: v('Faces', 'geometry'), target: v('Part', 'geometry'), surface: v('Part surface', 'geometry'), centers_mm: v('Holes', 'geometry'),
  paths: v('Edges', 'geometry'), from_path: v('From edges', 'geometry'), to_path: v('To edges', 'geometry'),
  center_mm: v('Centre', 'geometry', MM), start_mm: v('Start', 'geometry', MM), end_mm: v('End', 'geometry', MM),
  boundaries: v('Walls', 'geometry', undefined, 'Which walls of the faces it cuts.', [['outer', 'Outside'], ['holes', 'Holes'], ['all', 'All']]),
  diameter_mm: v('Diameter', 'geometry', MM), width_mm: v('Width', 'geometry', MM), pilot_diameter_mm: v('Pilot hole diameter', 'geometry', MM, 'The hole drilled before, open below the depth.'),
  start_diameter_mm: v('Existing diameter', 'geometry', MM, 'The drilled hole, or the boss.'), internal: v('Internal thread', 'geometry'),
  pitch_mm: v('Pitch', 'geometry', MM), right_hand: v('Right hand', 'geometry'),
  hand: v('Thread hand', 'geometry', undefined, 'Left-hand taps turn the spindle counter-clockwise (M4) into the hole.', [['right', 'Right hand'], ['left', 'Left hand']]),
  path_mm: v('Curved path', 'geometry', MM, 'Slot along points (x, y, bulge) instead of from start to end.'),
  // Heights
  clearance_z_mm: v('Clearance height', 'heights', MM, 'Z each pass starts and ends at: above everything, clamps included.'),
  retract_z_mm: v('Retract height', 'heights', MM, 'Z of moves between passes (default: the clearance height).'),
  feed_z_mm: v('Feed height', 'heights', MM, 'Z it rapids down to before feeding (default: the retract height).'),
  top_z_mm: v('Top', 'heights', MM), floor_z_mm: v('Floor', 'heights', MM), bottom_z_mm: v('Bottom', 'heights', MM), depth_z_mm: v('Depth (Z)', 'heights', MM),
  max_depth_mm: v('Deepest', 'heights', MM),
  // Passes
  stepdown_mm: v('Stepdown', 'passes', MM), stepover_mm: v('Stepover', 'passes', MM), radial_stepover_mm: v('Radial stepover', 'passes', MM),
  radial_allowance_mm: v('Stock on walls', 'passes', MM), bottom_allowance_mm: v('Stock on floor', 'passes', MM), stock_to_leave_mm: v('Stock to leave', 'passes', MM),
  axis: v('Direction', 'passes', undefined, undefined, [['x', 'Along X'], ['y', 'Along Y']]),
  one_way: v('One way', 'passes', undefined, 'Every row cut in the same direction (a rapid link back at the retract height) instead of zigzag.'), mode: v('Pattern', 'passes', undefined, undefined, [['zigzag', 'Zigzag'], ['one_way', 'One way']]),
  reverse: v('Reverse', 'passes'), cutting_sense: v('Milling', 'passes', undefined, undefined, SENSE), clockwise: v('Clockwise', 'passes'), outward: v('Outward', 'passes'),
  width_step_mm: v('Width per pass', 'passes', MM), angular_step_deg: v('Angle between spokes', 'passes', DEG), start_angle_deg: v('First spoke', 'passes', DEG),
  inner_radius_mm: v('Inner radius', 'passes', MM), outer_radius_mm: v('Outer radius', 'passes', MM), alternate: v('Alternate directions', 'passes'),
  min_angle_deg: v('Least crease angle', 'passes', DEG), radial_passes: v('Radial passes', 'passes'), spring_passes: v('Spring passes', 'passes'), climb: v('Climb', 'passes'),
  slope_from_deg: v('Slopes from', 'passes', DEG, '0 is flat, 90 vertical.'), slope_to_deg: v('Slopes to', 'passes', DEG),
  rest_threshold_mm: v('Only where more than', 'passes', MM, 'Cut only where the stock left stands more than this above the part.'),
  max_engagement_deg: v('Most engagement', 'passes', DEG), max_radial_engagement_mm: v('Most radial engagement', 'passes', MM),
  ramp: v('Ramp between levels', 'passes'), peck_mm: v('Peck', 'passes', MM), peck_mode: v('Peck mode', 'passes', undefined, undefined, [['full_retract', 'Full retract'], ['chip_break', 'Chip break']]),
  dwell_s: v('Dwell', 'passes', 's'), canned_cycle: v('Canned cycle', 'passes', undefined, 'Post each hole as the controller’s own cycle.'), spindle_stop: v('Stop the spindle at depth', 'passes'),
  depth_reference: v('Depth is at', 'passes', undefined, undefined, [['tip', 'Tip'], ['full_diameter', 'Full diameter']]), allow_breakthrough_mm: v('Break through by', 'passes', MM),
  // Cutting data
  spindle_rpm: v('Spindle speed', 'cutting', 'rpm'), feed_mm_min: v('Feed', 'cutting', FEED), plunge_mm_min: v('Plunge feed', 'cutting', FEED),
  retract_feed_mm_min: v('Retract feed', 'cutting', FEED), entry_feed_mm_min: v('Entry feed', 'cutting', FEED), link_feed_mm_min: v('Link feed', 'cutting', FEED),
  coolant: v('Coolant', 'cutting', undefined, undefined, [['flood', 'Flood'], ['mist', 'Mist'], ['off', 'Off']]),
  // Options
  side_offset: v('Cutter position', 'options', undefined, 'Beside the path: a flat end mill runs its radius to one side of each open path.'),
  side: v('Side', 'options', undefined, 'Of the direction of travel.', [['left', 'Left'], ['right', 'Right']]),
  positions_mm: v('At points', 'options', MM, 'Tabs at these (x, y) points on the part’s outline instead of a count or spacing. A loop without a point gets no tab.'),
  position_tolerance_mm: v('Point tolerance', 'options', MM, 'How far a point may be from the outline.'),
  min_length_mm: v('Shortest ramp span', 'options', MM, 'The shortest stretch a ramp may reverse on (a pocket’s short pass).'),
  entry: v('Entry', 'options'), clearing: v('Clearing', 'options'), tabs: v('Tabs', 'options'), fine_bore: v('Fine boring', 'options'), helix: v('Helix', 'options'),
  lead_in_mm: v('Lead in', 'options', MM), lead_out_mm: v('Lead out', 'options', MM), compensation: v('Compensation', 'options', undefined, 'Wear: posted with G41/G42 (needs both leads).', [['computer', 'In the program'], ['wear', 'Wear (G41/G42)']]),
  entry_air_gap_mm: v('Entry air gap', 'options', MM), edge_overlap_mm: v('Edge overlap', 'options', MM), tip_clearance_mm: v('Tip clearance', 'options', MM),
  bottom_clearance_mm: v('Clearance below', 'options', MM), chip_break_lift_mm: v('Chip-break lift', 'options', MM), reentry_clearance_mm: v('Re-entry clearance', 'options', MM),
  max_stay_down_mm: v('Longest link at depth', 'options', MM), orbit_radius_mm: v('Orbit radius', 'options', MM), boundary_clockwise: v('Boundary clockwise', 'options'),
  require_part_at_first_depth: v('Part at the first depth', 'options'), omit_empty_cuts: v('Skip empty cuts', 'options'), sample_mm: v('Sample every', 'options', MM),
  // Turning (camlib.turning): radii are from the spindle axis, Z along it.
  z_mm: v('At Z', 'heights', MM, 'Facing: the Z it faces down to. Parting: the part’s back face.'),
  z_from_mm: v('From Z', 'heights', MM), z_to_mm: v('To Z', 'heights', MM), z_start_mm: v('Starts at Z', 'heights', MM, 'Where the thread’s diameter starts.'),
  z_end_mm: v('Ends at Z', 'heights', MM), bottom_radius_mm: v('Bottom radius', 'heights', MM, 'The groove’s bottom, as a radius from the axis.'),
  major_radius_mm: v('Major radius', 'geometry', MM, 'Half the thread’s major diameter.'), depth_mm: v('Thread depth', 'geometry', MM, 'Radial, from the major radius to the root.'),
  depth_of_cut_mm: v('Depth of cut', 'passes', MM), allowance_mm: v('Allowance', 'passes', MM, 'Stock left on the part.'), retract_mm: v('Retract', 'passes', MM, 'How far each pass pulls off at 45° before it returns.'),
  overlap_mm: v('Overlap of plunges', 'passes', MM), passes: v('Passes', 'passes'), infeed_angle_deg: v('Infeed angle', 'passes', DEG, 'The flank the passes feed down (29.5° for a 60° thread).'),
  feed_mm_rev: v('Feed', 'cutting', 'mm/rev'), rpm: v('Spindle speed', 'cutting', 'rpm', 'With a surface speed set: the spindle’s limit (G50).'),
  surface_speed_m_min: v('Surface speed', 'cutting', 'm/min', 'Constant surface speed (G96). Needs the setup’s feed_per_rev=True.'),
  // Option objects' own fields
  angle_deg: v('Ramp angle', 'options', DEG), radius_mm: v('Radius', 'options', MM), height_mm: v('Height', 'options', MM), count: v('Count', 'options'),
  spacing_mm: v('Spacing', 'options', MM), shape: v('Shape', 'options', undefined, undefined, [['triangle', 'Triangle'], ['rectangle', 'Rectangle']]),
  shift_mm: v('Shift', 'options', MM), edge_angle_deg: v('Edge angle', 'options', DEG), routing: v('Routing', 'options'), coverage_margin_mm: v('Coverage margin', 'options', MM),
  path_strategy: v('Path', 'options', undefined, 'Follow the stock: passes along the edge of the uncut material, engagement proven. Orbits: the earlier planner.',
    [['engagement_front', 'Follow the stock'], ['disk_front', 'Orbits'], ['stock_front', 'Stock front (development)']]),
  // Advanced
  tolerance_mm: v('Tolerance', 'advanced', MM), boundary_tolerance_mm: v('Boundary tolerance', 'advanced', MM), path_error_mm: v('Path error', 'advanced', MM),
  contour_error_mm: v('Contour error', 'advanced', MM), safety_margin_mm: v('Safety margin', 'advanced', MM), level_tolerance_mm: v('Level tolerance', 'advanced', MM),
  rest_tolerance_mm: v('Rest tolerance', 'advanced', MM), clearing_tolerance_mm: v('Clearing tolerance', 'advanced', MM), simplify: v('Simplify', 'advanced'),
  contour_method: v('Contour method', 'advanced'), min_orbit_radius_mm: v('Smallest orbit', 'advanced', MM), local_orbit_tolerance_mm: v('Orbit tolerance', 'advanced', MM),
};

/** Fields a form never shows: written from the tool and the setup (slot() and the setup's work offset). */
export const HIDDEN = new Set(['id', 'tool', 'tool_number', 'length_register', 'work_offset']);
/** A sheet operation's parts are chosen with its head, above the sections. */
export const THERMAL_HIDDEN = new Set([...HIDDEN, 'parts']);

export type Kind = 'number' | 'integer' | 'bool' | 'choice' | 'text' | 'point' | 'points' | 'lines' | 'geometry' | 'nested';
/** Fields holding a list of (x, y) points. */
const POINT_LISTS = new Set(['positions_mm']);

export interface FieldInfo extends FieldView {
  key: string;
  kind: Kind;
  /** camlib requires it (no default): the form does too. */
  required: boolean;
  /** camlib's default as Python source (null: required), shown as the placeholder. */
  initial: string | null;
  /** None is allowed (an optional value left out). */
  optional: boolean;
  geometry?: GeometryKind;
  index: number;
}

/** camlib's fields per class, [name, type, default as Python source or null when required, keyword only]. */
export type CamlibField = [name: string, type: string, initial: string | null, keyword: boolean];
let FIELDS: Record<string, CamlibField[]> = {};
/** Sets camlib's fields (from the server, once). */
export const setFields = (fields: Record<string, CamlibField[]>) => { FIELDS = fields; };
export const fieldsLoaded = () => Object.keys(FIELDS).length > 0;
/** The operations the installed camlib has (a camlib without one leaves it out of the menus). */
export const availableSpecs = () => OP_SPECS.filter((spec) => FIELDS[spec.cls]);

const kindOf = (name: string, type: string, geometry: GeometryKind | undefined): Kind => {
  if (geometry === 'point') return 'point';
  if (geometry) return 'geometry';
  if (NESTED[name]) return 'nested';
  if (POINT_LISTS.has(name)) return 'points';
  if (type.startsWith('float')) return 'number';
  if (type.startsWith('int')) return 'integer';
  if (type.startsWith('bool')) return 'bool';
  if (type === 'tuple') return 'point';
  if (type.startsWith('str')) return FIELD_VIEW[name]?.choices ? 'choice' : 'text';
  return 'text';
};

/**
 * A ThermalCut's fields the shop's cutting recipe gives (camlib_ui.program.cutting(recipe, machine, ...)): a form doesn't
 * show them, the cut chart is the shop's. `lead_in` and `lead_out` are the recipe's lengths with the arc radii below.
 */
export const RECIPE_FIELDS = new Set(['feed_mm_min', 'cut_height_mm', 'lead_in', 'lead_out', 'pierce_height_mm', 'travel_height_mm', 'pierce_delay_s', 'power_percent', 'pierce_clearance_mm']);
/** cutting()'s own arguments, shown as the cut's fields: [name, type, default, keyword only]. */
const CUTTING_ARGUMENTS: CamlibField[] = [['lead_in_radius_mm', 'float', null, true], ['lead_out_radius_mm', 'float', null, true]];
export const CUTTING_KEYS = ['height_mode', 'lead_in_radius_mm', 'lead_out_radius_mm'];

/** How a plasma or laser operation shows its fields. */
const THERMAL_VIEW: Record<string, FieldView> = {
  height_mode: v('Heights', 'heights', undefined, 'The controller’s: the program keeps one Z and the controller sets the height itself. In the program: the program moves Z to its own heights (a cut’s are the recipe’s).', [['fixed', 'The controller’s'], ['program', 'In the program']]),
  lead_in_radius_mm: v('Lead-in arc radius', 'passes', MM, 'The arc a cut is entered over, after the recipe’s straight lead-in (0: straight only).'),
  lead_out_radius_mm: v('Lead-out arc radius', 'passes', MM, 'The arc a cut is left over, before the recipe’s straight lead-out (0: straight only).'),
  overcut_mm: v('Overcut', 'passes', MM, 'How far a loop’s cut runs past its start. Negative: it stops that far short (holes).'),
  reverse: v('Reverse direction', 'passes'),
  height_control: v('Torch height control', 'options', undefined, 'On for each loop (never over leads, nor in small holes).'),
  small_holes: v('Small holes', 'options'), micro_joints: v('Micro-joints', 'options'), common_line: v('Common lines', 'options'),
  compensation: v('Kerf compensation', 'options', undefined, 'Wear: posted with G41/G42, so the kerf is trimmed at the controller.', [['computer', 'In the program'], ['wear', 'Wear (G41/G42)']]),
  plunge_mm_min: v('Plunge feed', 'advanced', FEED, 'With heights in the program: the feed down to the pierce and cut heights.'),
  feed_percent: v('Feed', 'options', '%', 'Of the cut’s feed.'), max_diameter_mm: v('Up to diameter', 'options', MM, 'Empty: 1.5 × the sheet’s thickness.'),
  height_control_off: v('Height control off', 'options'), holes: v('On holes too', 'options'), min_length_mm: v('Shortest shared edge', 'options', MM),
  width_mm: v('Width', 'options', MM), count: v('Per outline', 'options'), spacing_mm: v('Or one every', 'options', MM),
  // Marking
  paths: v('Lines', 'geometry', MM, 'One line per row, as its points on the sheet: (x, y), (x, y), …'),
  feed_mm_min: v('Feed', 'cutting', FEED), mark_height_mm: v('Mark height', 'heights', MM, 'The nozzle above the sheet’s top.'),
  travel_height_mm: v('Travel height', 'heights', MM, 'With heights in the program: between lines.'),
  power_percent: v('Power', 'cutting', '%', 'A laser’s marking power. A plasma torch marks at the current its controller’s marking process sets.'),
  mark_width_mm: v('Mark width', 'cutting', MM, 'The width of the marked line in this material.'),
  edge_clearance_mm: v('Clearance to edges', 'options', MM, 'Material kept between a mark and its part’s edges.'),
  allow_off_part: v('Allow marks off the parts', 'options', undefined, 'Skips the proof that every mark is inside one part (marks on the scrap); the result says so.'),
};
const THERMAL_OPTIONS = new Set(['SmallHoles', 'MicroJoints', 'CommonLine']);

/** How a turning operation shows fields whose names milling uses for something else. */
const TURNING_VIEW: Record<string, FieldView> = {
  inner_radius_mm: v('Inner radius', 'heights', MM), outer_radius_mm: v('Outer radius', 'heights', MM), bottom_z_mm: v('Bottom Z', 'heights', MM),
  depth_z_mm: v('Depth (Z)', 'heights', MM, 'Where the drill’s tip stops.'), pitch_mm: v('Pitch', 'geometry', MM),
  compensation: v('Nose compensation', 'options', undefined, 'Wear: posted with G41/G42, so the control applies the wear in the offset’s nose radius.', [['computer', 'In the program'], ['wear', 'Wear (G41/G42)']]),
};

/** A camlib class's fields as the form shows them (an operation's, or an option object's). */
export function fieldsOf(cls: string): FieldInfo[] {
  const spec = OP_BY_CLASS[cls];
  const thermal = !!spec?.thermal || THERMAL_OPTIONS.has(cls);
  // A cut's process values are the shop's recipe (cutting(...)), whose own arguments stand in for them.
  const own = cls === 'ThermalCut' ? [...(FIELDS[cls] ?? []).filter(([key]) => !RECIPE_FIELDS.has(key)), ...CUTTING_ARGUMENTS] : FIELDS[cls] ?? [];
  return own.map(([key, type, initial], index) => {
    const geometry = spec?.geometry[key];
    const view = (spec?.turning ? TURNING_VIEW[key] : thermal ? THERMAL_VIEW[key] : undefined) ?? FIELD_VIEW[key] ?? v(key, 'advanced');
    const kind = thermal && key === 'paths' ? 'lines' : thermal && view.choices ? 'choice' : kindOf(key, type, geometry);
    return { ...view, key, kind, required: initial === null, initial, optional: type.endsWith('| None') || initial === 'None', geometry, index };
  });
}

/** The class's field names in camlib's order (positional arguments map onto them). */
export const fieldNames = (cls: string): string[] => (FIELDS[cls] ?? []).map(([name]) => name);

// ── What a planner doesn't take ──────────────────────────────────────────

const unquoted = (src: string) => src.trim().replace(/^["']|["']$/g, '');
const ORBITS = ['orbit_radius_mm', 'min_orbit_radius_mm', 'local_orbit_tolerance_mm'];
/**
 * Per class with a `path_strategy` and per strategy: the fields camlib refuses when they are set (its own rules:
 * camlib's AdaptivePocket and AdaptiveClearing, src/pocket_front.rs and src/adaptive.rs), and why.
 */
const NOT_TAKEN: Record<string, Record<string, [fields: string[], why: string][]>> = {
  AdaptivePocket: {
    engagement_front: [[ORBITS, 'Following the stock uses no orbits'], [['max_stay_down_mm', 'rest_tolerance_mm'], 'Following the stock links through its own proven-clear moves and plans from the stock as cut']],
    disk_front: [[['cutting_sense'], 'Orbits take their direction from Clockwise'], [['max_stay_down_mm'], 'An adaptive pocket relinks through its own re-entries']],
    stock_front: [[['max_stay_down_mm'], 'An adaptive pocket relinks through its own re-entries']],
  },
  AdaptiveClearing: { engagement_front: [[ORBITS, 'Following the stock uses no orbits']] },
};

/**
 * The fields of `cls` its chosen path doesn't take, with why: camlib refuses the program when one is set, so a form
 * hides them while empty and marks one that holds a value. The path is the form's value, else camlib's own default
 * (from the installed camlib, so an older camlib's default planner keeps its fields).
 */
export function notTaken(cls: string | null | undefined, values: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const rules = cls ? NOT_TAKEN[cls] : undefined;
  if (!rules) return out;
  const initial = (FIELDS[cls!] ?? []).find(([name]) => name === 'path_strategy')?.[2];
  const strategy = unquoted(values.path_strategy || initial || '');
  for (const [fields, why] of rules[strategy] ?? []) for (const field of fields) out.set(field, why);
  return out;
}
