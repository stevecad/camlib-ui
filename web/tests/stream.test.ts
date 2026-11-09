/**
 * The viewer's stream reader against the reference reader (camlib_ui/stream.py). tests/test_stream_parity.py builds the
 * plate example and runs this with CAMLIB_UI_STREAM (the stream) and CAMLIB_UI_EXPECTED (what the Python reader read
 * from it: each setup's moves and its stock volume at several moves). Without them only the self-contained tests run.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bytesFetch, curvePoint, headerLength, PlaybackStream, StreamError, volume } from '../src/cam/stream.ts';
import { moveForLine, positionAtTime, timeAtPosition, tipAt, type Motion } from '../src/cam/motion.ts';

const streamPath = process.env.CAMLIB_UI_STREAM;
const expectedPath = process.env.CAMLIB_UI_EXPECTED;

interface Expected {
  setups: { id: string; moves: number; ends: number[][]; lines: number[]; volumes: [number, number, number][] }[];
}

test('the stock at each move matches the reference reader', { skip: !streamPath && 'CAMLIB_UI_STREAM not set' }, async () => {
  const data = new Uint8Array(readFileSync(streamPath!));
  const expected: Expected = JSON.parse(readFileSync(expectedPath!, 'utf8'));
  const stream = await PlaybackStream.open(bytesFetch(data), { chunks: 2, keyframes: 1 });
  assert.deepEqual(stream.header.setups.map((setup) => setup.id), expected.setups.map((setup) => setup.id));
  for (const [s, want] of expected.setups.entries()) {
    const setup = stream.header.setups[s];
    assert.equal(setup.moves, want.moves);
    // Every move's end and first G-code line, chunk by chunk.
    const ends: number[][] = [], lines: number[] = [];
    for (let c = 0; c < setup.chunks.length; c++) {
      const chunk = await stream.chunk(s, c);
      for (let m = 0; m < chunk.count; m++) { ends.push([...chunk.end.subarray(m * 3, m * 3 + 3)]); lines.push(chunk.line[m]); }
    }
    assert.deepEqual(ends, want.ends);
    assert.deepEqual(lines, want.lines);
    // Seeks in an order that goes forward, back and forward again (the cursor, then a restart from a keyframe).
    const order = [...want.volumes].sort((a, b) => ((a[0] * 7919) % 101) - ((b[0] * 7919) % 101));
    for (const [n, upper, lower] of order) {
      const [u, l] = volume(setup, await stream.stockAt(s, n));
      assert.ok(Math.abs(u - upper) < 1e-6 * Math.max(1, upper), `upper volume after ${n} moves: ${u} ≠ ${upper}`);
      assert.ok(Math.abs(l - lower) < 1e-6 * Math.max(1, lower), `lower volume after ${n} moves: ${l} ≠ ${lower}`);
    }
  }
});

test('a stream that isn\'t one is refused', () => {
  assert.throws(() => headerLength(new Uint8Array(16)), StreamError);
  assert.throws(() => headerLength(new Uint8Array(4)), StreamError);
});

test('arcs and helices are followed about their plane', () => {
  // A quarter turn counter-clockwise about (0, 0) in XY, rising 1 mm.
  const half = curvePoint([1, 0, 0], [0, 1, 1], 'helix', [0, 0, 0], Math.PI / 2, 'xy', 0.5);
  assert.ok(Math.abs(half[0] - Math.SQRT1_2) < 1e-12 && Math.abs(half[1] - Math.SQRT1_2) < 1e-12 && Math.abs(half[2] - 0.5) < 1e-12);
  assert.deepEqual(curvePoint([0, 0, 0], [2, 4, 6], 'line', [0, 0, 0], 0, 'xy', 0.5), [1, 2, 3]);
});

test('playback positions, times and lines', () => {
  const motion: Motion = {
    first: 0, count: 2, start: [0, 0, 10], restarts: new Map(), end: new Float32Array([0, 0, 0, 10, 0, 0]),
    kind: new Uint8Array(2), operation: new Uint32Array(2), tool: new Uint32Array(2), rpm: new Float32Array(2), feed: new Float32Array(2),
    line: new Uint32Array([5, 9]),
  };
  assert.deepEqual(tipAt(motion, 0.5), [0, 0, 5]);
  assert.deepEqual(tipAt(motion, 1.5), [5, 0, 0]);
  assert.deepEqual(tipAt(motion, 7), [10, 0, 0]);
  const times = new Float64Array([0, 1, 3]);
  assert.equal(positionAtTime(times, 2), 1.5);
  assert.equal(timeAtPosition(times, 1.5), 2);
  assert.equal(moveForLine(motion, 9), 1);
  assert.equal(moveForLine(motion, 6), 1);
});
