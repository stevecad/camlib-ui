/**
 * A full build's playback stream (cam-playback.bin, version 1; docs/playback-stream.md): every move of every setup with
 * the stock cells it changes, in chunks compressed one by one, with keyframes of the whole stock grid. A port of the
 * reference reader (camlib_ui/stream.py `Reader`): the same checks and the same seeking.
 *
 * Read lazily: the header first, then only the chunks (and keyframes) a seek needs, through `fetch(offset, length)` (HTTP
 * ranges in the app, a file in the tests). A few decoded chunks and keyframes are kept; the stock is a cursor that moves
 * forward from where it is when that is cheaper than starting again from the last keyframe.
 *
 * Display data only: camlib's checks, not this file, decide whether a program is safe. No imports, so it runs under
 * plain Node (tests/stream.test.ts).
 */

export const MAGIC = 'STVCAMP1';
export const VERSION = 1;
export const PREAMBLE = 16;
const MAX_HEADER = 16 * 1024 * 1024;
const MAX_CHUNK_RAW = 256 * 1024 * 1024;
const MOVE = 32, ARC = 32, TAIL = 16, CELL = 12;
export const NONE = 0xffff;

export class StreamError extends Error {}
const need = (condition: unknown, message: string): void => { if (!condition) throw new StreamError(message); };

export interface Block { offset: number; length: number }
export interface ChunkEntry { first_move: number; moves: number; offset: number; length: number; raw_length: number; start_s: number; keyframe: Block | null }
export interface ToolShape { kind: 'flat' | 'ball' | 'bull' | 'drill' | 'chamfer' | string; corner_radius_mm?: number; point_angle_rad?: number; included_angle_rad?: number; tip_diameter_mm?: number }
export interface StreamTool {
  id: string; name: string; shape: ToolShape; diameter_mm: number; cutting_length_mm: number; overall_length_mm: number;
  shank_diameter_mm: number; flutes: number; stickout_mm: number; gauge_length_mm: number;
  holders: { z_min_mm: number; z_max_mm: number; radius_min_mm: number; radius_max_mm: number }[];
}
export interface StreamOperation { id: string; kind: string | null; type?: string | null; tool: string | null; tool_number: number | null; length_register: number | null; spindle_rpm: number | null; feed_mm_min: number | null }
export interface StreamStock { min_mm: number[]; max_mm: number[]; nx: number; ny: number; cell_mm: number[] }
export interface StreamSetup {
  id: string; machine: string; controller: string; post: string; initial_position_mm: number[]; stock: StreamStock;
  tools: StreamTool[]; operations: StreamOperation[]; moves: number; seconds: number; chunks: ChunkEntry[];
  /**
   * Moves that start somewhere other than the previous move's end, [move, x, y, z] in move order: a tool change that
   * leaves the new tool's tip elsewhere (docs/playback-stream.md). Absent in older streams: none.
   */
  restarts?: number[][];
}
export interface StreamHeader {
  format: string; version: number; units: string; camlib?: { version?: string; commit?: string };
  kinds: string[]; curves: string[]; planes: string[]; setups: StreamSetup[];
}

/** One chunk's moves, column by column. `end` and `center` are mm (3 per move); `feed` NaN on a rapid. */
export interface MoveChunk {
  first: number; count: number;
  kind: Uint8Array; curve: Uint8Array; operation: Uint16Array; tool: Uint16Array;
  end: Float64Array; center: Float64Array; sweep: Float32Array; plane: Uint8Array;
  feed: Float32Array; seconds: Float32Array; line: Uint32Array;
  /** Move i's cell changes are cells[cellStart[i] .. cellStart[i + 1]). */
  cellStart: Uint32Array; cellIndex: Uint32Array; cellLower: Float32Array; cellUpper: Float32Array;
}

/** The preamble's header length, from the stream's first 16 bytes. */
export function headerLength(bytes: Uint8Array): number {
  need(bytes.byteLength >= PREAMBLE, 'Too short for a playback stream.');
  need(String.fromCharCode(...bytes.subarray(0, 8)) === MAGIC, 'Not a playback stream (magic).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  need(version === VERSION, `Unsupported playback stream version ${version}.`);
  const length = view.getUint32(12, true);
  need(length <= MAX_HEADER, 'Header length out of range.');
  return length;
}

/** The header, from the preamble and header bytes (at least PREAMBLE + headerLength). */
export function parseHeader(bytes: Uint8Array): StreamHeader {
  const length = headerLength(bytes);
  need(bytes.byteLength >= PREAMBLE + length, 'Header length out of range.');
  let header: StreamHeader;
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(PREAMBLE, PREAMBLE + length))); } catch (error) {
    throw new StreamError(`Header isn't JSON: ${(error as Error).message}`);
  }
  need(header && typeof header === 'object', 'Header isn\'t an object.');
  need(header.format === 'steve-camlib-playback', 'Header format isn\'t steve-camlib-playback.');
  header.kinds ??= []; header.curves ??= []; header.planes ??= []; header.setups ??= [];
  for (const setup of header.setups) {
    const stock = setup.stock;
    need(stock && Number.isInteger(stock.nx) && Number.isInteger(stock.ny) && stock.nx * stock.ny > 0, 'Setup stock grid missing.');
    setup.restarts ??= [];
    need(Array.isArray(setup.restarts) && setup.restarts.every((item, index) => Array.isArray(item) && item.length === 4 && Number.isInteger(item[0]) && item[0] >= 0 && item[0] < setup.moves
      && item.slice(1).every((value) => Number.isFinite(value)) && (index === 0 || item[0] > setup.restarts![index - 1][0])), 'Bad restarts.');
    let first = 0;
    for (const chunk of setup.chunks ?? []) {
      need(chunk.first_move === first, 'Chunks aren\'t contiguous.');
      first += chunk.moves;
    }
    need(first === setup.moves, 'Setup move count doesn\'t match its chunks.');
  }
  return header;
}

/** Inflates one zlib stream (RFC 1950), exactly `expected` bytes long. */
export async function inflate(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let at = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      need(at + value.byteLength <= expected, 'Block size mismatch.');
      out.set(value, at);
      at += value.byteLength;
    }
  } catch (error) {
    if (error instanceof StreamError) throw error;
    throw new StreamError(`Block isn't zlib: ${(error as Error).message}`);
  }
  need(at === expected, 'Block size mismatch.');
  return out;
}

/** A chunk's moves from its decompressed bytes (checked as the reference reader checks them). */
export function decodeMoves(raw: Uint8Array, header: StreamHeader, setup: StreamSetup, entry: ChunkEntry): MoveChunk {
  const count = entry.moves;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const cells = setup.stock.nx * setup.stock.ny;
  const out: MoveChunk = {
    first: entry.first_move, count,
    kind: new Uint8Array(count), curve: new Uint8Array(count), operation: new Uint16Array(count), tool: new Uint16Array(count),
    end: new Float64Array(count * 3), center: new Float64Array(count * 3), sweep: new Float32Array(count), plane: new Uint8Array(count),
    feed: new Float32Array(count), seconds: new Float32Array(count), line: new Uint32Array(count), cellStart: new Uint32Array(count + 1),
    cellIndex: new Uint32Array(0), cellLower: new Float32Array(0), cellUpper: new Float32Array(0),
  };
  // First pass: the moves, and where each one's cells are; the cells are copied in one go after.
  const cellAt: number[] = [];
  let offset = 0, i = 0, total = 0;
  while (offset < raw.byteLength) {
    need(i < count, 'Chunk move count doesn\'t match its header.');
    need(offset + MOVE <= raw.byteLength, 'Truncated move.');
    const kind = view.getUint8(offset), curve = view.getUint8(offset + 1);
    need(kind < header.kinds.length && curve < header.curves.length && view.getUint16(offset + 6, true) === 0, 'Bad move kind or curve.');
    out.kind[i] = kind; out.curve[i] = curve;
    out.operation[i] = view.getUint16(offset + 2, true);
    out.tool[i] = view.getUint16(offset + 4, true);
    for (let a = 0; a < 3; a++) out.end[i * 3 + a] = view.getFloat64(offset + 8 + a * 8, true);
    need(Number.isFinite(out.end[i * 3]) && Number.isFinite(out.end[i * 3 + 1]) && Number.isFinite(out.end[i * 3 + 2]), 'Move end isn\'t finite.');
    offset += MOVE;
    if (header.curves[curve] !== 'line') {
      need(offset + ARC <= raw.byteLength, 'Truncated arc.');
      for (let a = 0; a < 3; a++) out.center[i * 3 + a] = view.getFloat64(offset + a * 8, true);
      out.sweep[i] = view.getFloat32(offset + 24, true);
      out.plane[i] = view.getUint8(offset + 28);
      need(out.plane[i] < header.planes.length && [0, 1, 2].every((a) => Number.isFinite(out.center[i * 3 + a])) && Number.isFinite(out.sweep[i]), 'Bad arc.');
      offset += ARC;
    }
    need(offset + TAIL <= raw.byteLength, 'Truncated move tail.');
    const feed = view.getFloat32(offset, true), seconds = view.getFloat32(offset + 4, true);
    need(Number.isFinite(seconds) && seconds >= 0 && (Number.isNaN(feed) || feed > 0), 'Bad feed or duration.');
    out.feed[i] = feed; out.seconds[i] = seconds;
    out.line[i] = view.getUint32(offset + 8, true);
    const changed = view.getUint32(offset + 12, true);
    offset += TAIL;
    need(offset + changed * CELL <= raw.byteLength, 'Truncated stock change.');
    cellAt.push(offset);
    out.cellStart[i] = total;
    total += changed;
    offset += changed * CELL;
    i++;
  }
  need(i === count, 'Chunk move count doesn\'t match its header.');
  out.cellStart[count] = total;
  out.cellIndex = new Uint32Array(total); out.cellLower = new Float32Array(total); out.cellUpper = new Float32Array(total);
  for (let m = 0; m < count; m++) {
    for (let c = out.cellStart[m], at = cellAt[m]; c < out.cellStart[m + 1]; c++, at += CELL) {
      const index = view.getUint32(at, true);
      need(index < cells, 'Changed cell outside the grid.');
      out.cellIndex[c] = index; out.cellLower[c] = view.getFloat32(at + 4, true); out.cellUpper[c] = view.getFloat32(at + 8, true);
    }
  }
  return out;
}

/** Applies moves [from, to) of a chunk (indexes within it) to a grid of (lower, upper) pairs. */
export function applyMoves(grid: Float32Array, chunk: MoveChunk, from: number, to: number) {
  for (let c = chunk.cellStart[from], end = chunk.cellStart[to]; c < end; c++) {
    const index = chunk.cellIndex[c] * 2;
    grid[index] = chunk.cellLower[c];
    grid[index + 1] = chunk.cellUpper[c];
  }
}

/** The stock before any move: every cell's both bounds at the stock's top. */
export function initialGrid(setup: StreamSetup): Float32Array {
  return new Float32Array(setup.stock.nx * setup.stock.ny * 2).fill(setup.stock.max_mm[2]);
}

/** The chunk that holds move n − 1 (the first whose first_move + moves ≥ n; chunk 0 for n = 0). */
export function chunkFor(setup: StreamSetup, n: number): number {
  const chunks = setup.chunks;
  let lo = 0, hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].first_move + chunks[mid].moves >= n) hi = mid; else lo = mid + 1;
  }
  return Math.max(0, Math.min(chunks.length - 1, lo));
}

/** The last chunk at or before `c` with a keyframe, or −1 (start from the initial stock). */
export function keyframeFor(setup: StreamSetup, c: number): number {
  for (let k = c; k >= 0; k--) if (setup.chunks[k].keyframe) return k;
  return -1;
}

/** Remaining stock volume (mm³) of a grid by each cell's upper and lower top height: [upper, lower]. */
export function volume(setup: StreamSetup, grid: Float32Array): [number, number] {
  const bottom = setup.stock.min_mm[2], area = setup.stock.cell_mm[0] * setup.stock.cell_mm[1];
  let upper = 0, lower = 0;
  for (let i = 0; i < grid.length; i += 2) { lower += Math.max(0, grid[i] - bottom); upper += Math.max(0, grid[i + 1] - bottom); }
  return [upper * area, lower * area];
}

/** Reads `length` bytes at `offset` of the stream. */
export type Fetch = (offset: number, length: number) => Promise<Uint8Array>;

class Lru<V> {
  private readonly map = new Map<string, Promise<V>>();
  private readonly size: number;
  constructor(size: number) { this.size = size; }
  get(key: string, make: () => Promise<V>): Promise<V> {
    let value = this.map.get(key);
    if (value) { this.map.delete(key); this.map.set(key, value); return value; }
    value = make();
    value.catch(() => this.map.delete(key));
    this.map.set(key, value);
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value!);
    return value;
  }
}

/**
 * An open stream: its header, a few decoded chunks and keyframes, and one stock cursor per setup. `stockAt` calls are
 * served one after another (the cursor is shared); the grid it returns is the cursor's own, valid until the next call.
 */
export class PlaybackStream {
  readonly header: StreamHeader;
  private readonly fetch: Fetch;
  private readonly body: number;
  private readonly chunks: Lru<MoveChunk>;
  private readonly keyframes: Lru<Float32Array>;
  private readonly cursors = new Map<number, { n: number; grid: Float32Array }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(fetch: Fetch, header: StreamHeader, headerBytes: number, { chunks = 4, keyframes = 3 } = {}) {
    this.fetch = fetch;
    this.header = header;
    this.body = PREAMBLE + headerBytes;
    this.chunks = new Lru(chunks);
    this.keyframes = new Lru(keyframes);
  }

  /** Opens a stream: its preamble and header (one read, a second if the header is longer than the first read). */
  static async open(fetch: Fetch, options?: { chunks?: number; keyframes?: number }): Promise<PlaybackStream> {
    let bytes = await fetch(0, 64 * 1024);
    const length = headerLength(bytes);
    if (bytes.byteLength < PREAMBLE + length) bytes = await fetch(0, PREAMBLE + length);
    return new PlaybackStream(fetch, parseHeader(bytes), length, options);
  }

  private async block(entry: Block, expected: number): Promise<Uint8Array> {
    need(Number.isInteger(entry.offset) && Number.isInteger(entry.length) && entry.offset >= 0 && entry.length > 0, 'Bad block extent.');
    const data = await this.fetch(this.body + entry.offset, entry.length);
    need(data.byteLength === entry.length, 'Block extends past the stream\'s end.');
    return inflate(data, expected);
  }

  /** Chunk `c` of setup `s`, decoded (kept among the last few). */
  chunk(s: number, c: number): Promise<MoveChunk> {
    const setup = this.header.setups[s], entry = setup.chunks[c];
    return this.chunks.get(`${s}:${c}`, async () => {
      need(entry.raw_length <= MAX_CHUNK_RAW, 'Chunk too large.');
      return decodeMoves(await this.block(entry, entry.raw_length), this.header, setup, entry);
    });
  }

  /** The stock grid before chunk `c`'s first move, from its keyframe. */
  keyframe(s: number, c: number): Promise<Float32Array> {
    const setup = this.header.setups[s], entry = setup.chunks[c];
    need(!!entry.keyframe, 'That chunk has no keyframe.');
    const cells = setup.stock.nx * setup.stock.ny;
    return this.keyframes.get(`${s}:${c}`, async () => {
      const raw = await this.block(entry.keyframe!, cells * 8);
      return new Float32Array(raw.buffer, raw.byteOffset, cells * 2);
    });
  }

  /** The stock of setup `s` after `n` moves (0: before the first), as (lower, upper) per cell. */
  stockAt(s: number, n: number): Promise<Float32Array> {
    const next = this.queue.then(() => this.seek(s, n));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async seek(s: number, n: number): Promise<Float32Array> {
    const setup = this.header.setups[s];
    need(setup && n >= 0 && n <= setup.moves && Number.isInteger(n), 'Move outside the setup.');
    const target = chunkFor(setup, n);
    const k = keyframeFor(setup, target);
    const start = k >= 0 ? setup.chunks[k].first_move : 0;
    let cursor = this.cursors.get(s);
    // Forward from where the cursor is when it is past the keyframe's start (less to apply than from the keyframe).
    if (!cursor || cursor.n > n || cursor.n < start) {
      const grid = k >= 0 ? new Float32Array(await this.keyframe(s, k)) : initialGrid(setup);
      cursor = { n: start, grid };
      this.cursors.set(s, cursor);
    }
    if (!setup.chunks.length) return cursor.grid;
    for (let c = chunkFor(setup, cursor.n + 1); c <= target && cursor.n < n; c++) {
      const entry = setup.chunks[c];
      const chunk = await this.chunk(s, c);
      const from = cursor.n - entry.first_move, to = Math.min(entry.moves, n - entry.first_move);
      if (to > from) applyMoves(cursor.grid, chunk, from, to);
      cursor.n = entry.first_move + to;
    }
    return cursor.grid;
  }
}

/** Ranges of a whole stream already in memory (the tests, or a server that answered a range request with every byte). */
export const bytesFetch = (data: Uint8Array): Fetch => async (offset, length) => data.subarray(offset, Math.min(data.byteLength, offset + length));

// ── Curves ──────────────────────────────────────────────────────────────────

const AXES: Record<string, [number, number, number]> = { xy: [0, 1, 2], xz: [2, 0, 1], yz: [1, 2, 0] };

/**
 * A point a fraction of the way along a move (camlib's curve_position): a line, or an arc or helix about `center` in
 * `plane` (sweep positive counter-clockwise about the plane's normal; a helix also moves along the normal).
 */
export function curvePoint(start: ArrayLike<number>, end: ArrayLike<number>, curve: string, center: ArrayLike<number>, sweep: number, plane: string, fraction: number,
  out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (curve === 'line' || fraction <= 0 || fraction >= 1) {
    const f = Math.min(1, Math.max(0, fraction));
    for (let a = 0; a < 3; a++) out[a] = start[a] + f * (end[a] - start[a]);
    return out;
  }
  const [u, v, w] = AXES[plane] ?? AXES.xy;
  const radius = Math.hypot(start[u] - center[u], start[v] - center[v]);
  const angle = Math.atan2(start[v] - center[v], start[u] - center[u]) + fraction * sweep;
  out[0] = start[0]; out[1] = start[1]; out[2] = start[2];
  out[u] = center[u] + radius * Math.cos(angle);
  out[v] = center[v] + radius * Math.sin(angle);
  out[w] = start[w] + fraction * (end[w] - start[w]);
  return out;
}
