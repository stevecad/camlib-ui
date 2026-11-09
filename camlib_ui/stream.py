"""Reads and checks a camlib build's playback stream (cam-playback.bin; written by camlib_ui/build/stream.py,
specified in docs/playback-stream.md). The server checks every stream a build returns before it is served
(`check`); tests and tools replay it (`Reader`). Standard library only: the viewer's own reader follows the same spec.
"""
from __future__ import annotations

from array import array
import json
import math
import struct
import zlib

MAGIC = b"STVCAMP1"
VERSION = 1
PREAMBLE = struct.Struct("<8sII")
MAX_HEADER = 16 * 1024 * 1024
MOVE = struct.Struct("<BBHHHddd")
ARC = struct.Struct("<dddfB3x")
TAIL = struct.Struct("<ffII")
CELL = struct.Struct("<Iff")
MAX_CHUNK_RAW = 256 * 1024 * 1024


class StreamError(ValueError):
    """A playback stream that doesn't follow the spec."""


def _need(condition, message):
    if not condition:
        raise StreamError(message)


class Reader:
    """A playback stream held as bytes (or any object with read(offset, length) via `source`)."""

    def __init__(self, data: bytes):
        self.data = memoryview(data)
        _need(len(data) >= PREAMBLE.size, "Too short for a playback stream.")
        magic, version, length = PREAMBLE.unpack_from(data, 0)
        _need(magic == MAGIC, "Not a camlib playback stream (magic).")
        _need(version == VERSION, f"Unsupported playback stream version {version}.")
        _need(length <= MAX_HEADER and PREAMBLE.size + length <= len(data), "Header length out of range.")
        try:
            self.header = json.loads(bytes(self.data[PREAMBLE.size:PREAMBLE.size + length]))
        except (ValueError, UnicodeDecodeError) as error:
            raise StreamError(f"Header isn't JSON: {error}") from None
        self.body = PREAMBLE.size + length
        self.kinds = self.header.get("kinds") or []
        self.curves = self.header.get("curves") or []
        self.planes = self.header.get("planes") or []

    def setups(self):
        return self.header.get("setups") or []

    def _block(self, entry, limit):
        offset, length = entry.get("offset"), entry.get("length")
        _need(isinstance(offset, int) and isinstance(length, int) and offset >= 0 and length > 0, "Bad block extent.")
        start = self.body + offset
        _need(start + length <= len(self.data), "Block extends past the stream's end.")
        decompressor = zlib.decompressobj()
        try:
            raw = decompressor.decompress(self.data[start:start + length], limit + 1)
        except zlib.error as error:
            raise StreamError(f"Block isn't zlib: {error}") from None
        _need(decompressor.eof and not decompressor.unconsumed_tail and len(raw) <= limit, "Block size mismatch.")
        return raw

    def keyframe(self, setup, chunk):
        """The stock grid (floats: lower, upper per cell) before the chunk's first move, from its keyframe."""
        cells = setup["stock"]["nx"] * setup["stock"]["ny"]
        raw = self._block(chunk["keyframe"], cells * 8)
        _need(len(raw) == cells * 8, "Keyframe size doesn't match the grid.")
        grid = array("f")
        grid.frombytes(raw)
        return grid

    def moves(self, setup, chunk):
        """The chunk's moves, decoded: dicts with kind, curve, operation and tool indexes, end, arc, feed, duration,
        line and the changed cells [(index, lower, upper)]."""
        raw = self._block(chunk, min(chunk.get("raw_length", MAX_CHUNK_RAW), MAX_CHUNK_RAW))
        _need(len(raw) == chunk.get("raw_length"), "Chunk length doesn't match its header.")
        cells = setup["stock"]["nx"] * setup["stock"]["ny"]
        offset, out = 0, []
        while offset < len(raw):
            _need(offset + MOVE.size <= len(raw), "Truncated move.")
            kind, curve, operation, tool, reserved, x, y, z = MOVE.unpack_from(raw, offset)
            offset += MOVE.size
            _need(kind < len(self.kinds) and curve < len(self.curves) and reserved == 0, "Bad move kind or curve.")
            _need(all(math.isfinite(v) for v in (x, y, z)), "Move end isn't finite.")
            move = dict(kind=self.kinds[kind], curve=self.curves[curve], operation=operation, tool=tool, end=(x, y, z))
            if self.curves[curve] != "line":
                _need(offset + ARC.size <= len(raw), "Truncated arc.")
                cx, cy, cz, sweep, plane = ARC.unpack_from(raw, offset)
                offset += ARC.size
                _need(plane < len(self.planes) and all(math.isfinite(v) for v in (cx, cy, cz, sweep)), "Bad arc.")
                move.update(center=(cx, cy, cz), sweep_rad=sweep, plane=self.planes[plane])
            _need(offset + TAIL.size <= len(raw), "Truncated move tail.")
            feed, duration, line, count = TAIL.unpack_from(raw, offset)
            offset += TAIL.size
            _need(math.isfinite(duration) and duration >= 0 and (math.isnan(feed) or feed > 0), "Bad feed or duration.")
            _need(offset + count * CELL.size <= len(raw), "Truncated stock change.")
            changes = [CELL.unpack_from(raw, offset + i * CELL.size) for i in range(count)]
            _need(all(c[0] < cells for c in changes), "Changed cell outside the grid.")
            offset += count * CELL.size
            move.update(feed_mm_min=None if math.isnan(feed) else feed, seconds=duration, line=line or None, changes=changes)
            out.append(move)
        _need(len(out) == chunk.get("moves"), "Chunk move count doesn't match its header.")
        return out

    def initial(self, setup):
        top = float(setup["stock"]["max_mm"][2])
        return array("f", [top]) * (setup["stock"]["nx"] * setup["stock"]["ny"] * 2)

    def stock_at(self, setup, move):
        """The grid after `move` moves (0: the stock before the first), found as the viewer finds it: the chunk that
        holds the move, the last keyframe at or before it, then the chunks from there."""
        chunks = setup["chunks"]
        _need(0 <= move <= setup["moves"], "Move outside the setup.")
        target = max(0, min(len(chunks) - 1, next((i for i, c in enumerate(chunks) if c["first_move"] + c["moves"] >= move), 0)))
        start = max((i for i in range(target + 1) if chunks[i].get("keyframe")), default=None)
        grid = self.keyframe(setup, chunks[start]) if start is not None else self.initial(setup)
        done = chunks[start]["first_move"] if start is not None else 0
        for chunk in chunks[start or 0:target + 1]:
            for item in self.moves(setup, chunk):
                if done >= move:
                    return grid
                for index, lower, upper in item["changes"]:
                    grid[2 * index], grid[2 * index + 1] = lower, upper
                done += 1
        return grid


def volume(setup, grid):
    """Remaining stock volume (mm³) of a grid, by each cell's upper and lower top height: (upper, lower) bounds."""
    stock = setup["stock"]
    bottom = float(stock["min_mm"][2])
    area = stock["cell_mm"][0] * stock["cell_mm"][1]
    lower = sum(max(0.0, grid[i] - bottom) for i in range(0, len(grid), 2)) * area
    upper = sum(max(0.0, grid[i] - bottom) for i in range(1, len(grid), 2)) * area
    return upper, lower


def check(data: bytes) -> dict:
    """Checks a whole stream (header, every block and move); returns a summary {setups: [{id, moves, chunks}]}."""
    reader = Reader(data)
    _need(reader.header.get("format") == "steve-camlib-playback", "Header format isn't steve-camlib-playback.")
    summary = []
    for setup in reader.setups():
        stock = setup.get("stock") or {}
        _need(isinstance(stock.get("nx"), int) and isinstance(stock.get("ny"), int) and stock["nx"] * stock["ny"] > 0,
              "Setup stock grid missing.")
        first, keyframes = 0, 0
        for chunk in setup.get("chunks") or []:
            _need(chunk.get("first_move") == first, "Chunks aren't contiguous.")
            if chunk.get("keyframe"):
                reader.keyframe(setup, chunk)
                keyframes += 1
            reader.moves(setup, chunk)
            first += chunk["moves"]
        _need(first == setup.get("moves"), "Setup move count doesn't match its chunks.")
        summary.append(dict(id=setup.get("id"), moves=first, chunks=len(setup.get("chunks") or []), keyframes=keyframes))
    return dict(setups=summary)
