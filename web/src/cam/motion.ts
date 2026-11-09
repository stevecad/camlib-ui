/**
 * The player's motion model (from STEVE Studio's CAM player): a program's moves as columns, where the tool tip is at a
 * playback position (move i spans [i, i + 1)), and playback in nominal machine time. Drawing data only: camlib checked
 * every move at full precision, so nothing here decides anything.
 *
 * No imports, so it runs under plain Node (tests/).
 */

/** Move kinds as the player colours them (camlib's cuts are `feed`; taps, threads and others draw as cuts). */
export const MOVE_KINDS = ['rapid', 'feed', 'plunge', 'lead', 'link', 'retract'] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];
/** `operation` on a move of no operation (between operations). */
export const UNASSIGNED = 4294967295;
export const ARC_PLANES = ['xy', 'xz', 'yz'] as const;
const PLANE_AXES: [number, number, number][] = [[0, 1, 2], [2, 0, 1], [1, 2, 0]];

/** A program's moves, column by column (cheap to draw and to scrub). */
export interface Motion {
  first: number;
  count: number;
  /** Where the tool tip starts. */
  start: [number, number, number];
  /** Tool-tip endpoints: x, y, z per move. */
  end: Float32Array;
  kind: Uint8Array;
  operation: Uint32Array;
  tool: Uint32Array;
  rpm: Float32Array;
  /** mm/min; 0 on rapids. */
  feed: Float32Array;
  /** The move's first line in the posted program (1-based; 0: none). */
  line: Uint32Array;
  /**
   * Curved moves: per move its curve (0 line, 1 arc, 2 helix), and for an arc or helix its centre (mm), sweep (radians,
   * counter-clockwise about the plane's normal) and plane (ARC_PLANES). Absent: every move is a line.
   */
  arcs?: { curve: Uint8Array; center: Float32Array; sweep: Float32Array; plane: Uint8Array };
  /** Moves not read yet (1). Absent: all are. */
  pending?: Uint8Array;
  /** Moves that start somewhere other than the previous endpoint (none in a camlib stream; kept for the model). */
  restarts: Map<number, [number, number, number]>;
}

/**
 * A point a fraction of the way along move `index` from `start` (its start): straight for a line; for an arc or helix
 * around its centre in its plane, and along the plane's normal for a helix (camlib's curve_position).
 */
export function alongMove(motion: Motion, index: number, start: [number, number, number], fraction: number, out: [number, number, number]): [number, number, number] {
  const at = index * 3;
  const arcs = motion.arcs;
  if (!arcs || !arcs.curve[index] || fraction <= 0 || fraction >= 1) {
    const f = Math.min(1, Math.max(0, fraction));
    const x = start[0], y = start[1], z = start[2];
    out[0] = x + (motion.end[at] - x) * f; out[1] = y + (motion.end[at + 1] - y) * f; out[2] = z + (motion.end[at + 2] - z) * f;
    return out;
  }
  const [u, v, w] = PLANE_AXES[arcs.plane[index]] ?? PLANE_AXES[0];
  const cu = arcs.center[at + u], cv = arcs.center[at + v];
  const radius = Math.hypot(start[u] - cu, start[v] - cv);
  const angle = Math.atan2(start[v] - cv, start[u] - cu) + fraction * arcs.sweep[index];
  const sw = start[w];
  out[0] = start[0]; out[1] = start[1]; out[2] = start[2];
  out[u] = cu + radius * Math.cos(angle);
  out[v] = cv + radius * Math.sin(angle);
  out[w] = sw + fraction * (motion.end[at + w] - sw);
  return out;
}

/** Where move `index` starts: the previous endpoint, or the program's initial tool-tip position. */
export function moveStart(motion: Motion, index: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (index <= 0) { out[0] = motion.start[0]; out[1] = motion.start[1]; out[2] = motion.start[2]; return out; }
  const restart = motion.restarts.get(index);
  if (restart && index < motion.count) { out[0] = restart[0]; out[1] = restart[1]; out[2] = restart[2]; return out; }
  const at = (index - 1) * 3;
  out[0] = motion.end[at]; out[1] = motion.end[at + 1]; out[2] = motion.end[at + 2];
  return out;
}

/**
 * The tool tip at playback position `t`, where move i spans [i, i + 1): interpolated along the move (a line, or an
 * arc or helix), for drawing only. t ≤ 0 is the start pose; t ≥ count is the last endpoint.
 */
export function tipAt(motion: Motion, t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!motion.count || t <= 0) return moveStart(motion, 0, out);
  if (t >= motion.count) return moveStart(motion, motion.count, out);
  const index = Math.floor(t), f = t - index;
  return alongMove(motion, index, moveStart(motion, index, [0, 0, 0]), f, out);
}

/** The move playing at position t (clamped to the program), or -1 when there are no moves. */
export const moveAt = (motion: Motion, t: number) => (motion.count ? Math.min(motion.count - 1, Math.max(0, Math.floor(t))) : -1);

/** The first move whose posted line is `line` (or the nearest following one), for click-a-line → seek. */
export function moveForLine(motion: Motion, line: number): number {
  let best = -1;
  for (let i = 0; i < motion.count; i++) {
    if (motion.line[i] === line) return i;
    if (motion.line[i] > line && (best < 0 || motion.line[i] < motion.line[best])) best = i;
  }
  return best;
}

/** Playback position (move units) at time `seconds` along a cumulative time table (times[i]: when move i starts). */
export function positionAtTime(times: Float64Array, seconds: number): number {
  const count = times.length - 1;
  if (count <= 0 || seconds <= 0) return 0;
  if (seconds >= times[count]) return count;
  let lo = 0, hi = count;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= seconds) lo = mid; else hi = mid; }
  const span = times[lo + 1] - times[lo];
  return lo + (span > 0 ? (seconds - times[lo]) / span : 1);
}

export const timeAtPosition = (times: Float64Array, t: number) => {
  const count = times.length - 1;
  if (count <= 0 || t <= 0) return 0;
  if (t >= count) return times[count];
  const index = Math.floor(t);
  return times[index] + (times[index + 1] - times[index]) * (t - index);
};
