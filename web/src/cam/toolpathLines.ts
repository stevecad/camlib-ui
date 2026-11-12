/**
 * The toolpath as the 3D view draws it: each move as line segments (arcs and helices as chords along them), with its
 * index, kind and length along it, and where each move's vertices are, so one operation's lines can be left out of a
 * draw without building anything again (pathVisibility.ts `drawRanges`). Drawing data only.
 *
 * No runtime imports beyond the motion model, so it runs under plain Node (tests/paths.test.ts).
 */
import { alongMove, type Motion } from './motion.ts';

export interface ToolpathLines {
  /** x, y, z per vertex; two vertices per segment, the moves in order. */
  positions: Float32Array;
  /** Per vertex: its move, its kind (motion.ts MOVE_KINDS) and the length along the move (for the dashes). */
  moves: Float32Array;
  kinds: Float32Array;
  dists: Float32Array;
  /** Move i's vertices are [first[i], first[i + 1]): count + 1 entries. */
  first: Uint32Array;
}

export function toolpathLines(motion: Motion): ToolpathLines {
  const positions: number[] = [], moves: number[] = [], kinds: number[] = [], dists: number[] = [];
  const first = new Uint32Array(motion.count + 1);
  const point: [number, number, number] = [0, 0, 0];
  let px = motion.start[0], py = motion.start[1], pz = motion.start[2];
  const segment = (i: number, x: number, y: number, z: number, d0: number) => {
    positions.push(px, py, pz, x, y, z);
    moves.push(i, i);
    kinds.push(motion.kind[i], motion.kind[i]);
    const d1 = d0 + Math.hypot(x - px, y - py, z - pz);
    dists.push(d0, d1);
    px = x; py = y; pz = z;
    return d1;
  };
  for (let i = 0; i < motion.count; i++) {
    first[i] = moves.length;
    const x = motion.end[i * 3], y = motion.end[i * 3 + 1], z = motion.end[i * 3 + 2];
    // A move that starts elsewhere (after a tool change): nothing is drawn from the previous end to its start.
    const restart = motion.restarts.get(i);
    if (restart) { px = restart[0]; py = restart[1]; pz = restart[2]; }
    const sweep = motion.arcs?.curve[i] ? Math.abs(motion.arcs.sweep[i]) : 0;
    if (!sweep) { segment(i, x, y, z, 0); continue; }
    const start: [number, number, number] = [px, py, pz];
    const steps = Math.max(2, Math.min(96, Math.ceil(sweep / (Math.PI / 24))));
    let d = 0;
    for (let k = 1; k <= steps; k++) {
      alongMove(motion, i, start, k / steps, point);
      d = segment(i, point[0], point[1], point[2], d);
    }
  }
  first[motion.count] = moves.length;
  return { positions: new Float32Array(positions), moves: new Float32Array(moves), kinds: new Float32Array(kinds), dists: new Float32Array(dists), first };
}
