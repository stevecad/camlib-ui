"""The camlib playback stream (cam-playback.bin): every move of every setup with the stock it removes, compact and
seekable, for the viewer. The format is specified in docs/playback-stream.md; camlib_ui/stream.py reads and
checks it. Display data only: camlib's checks, not this file, decide whether a program is safe.

Layout (little-endian):

    magic  b"STVCAMP1"            8 bytes
    u32    version (1)
    u32    header length H
    H      header, UTF-8 JSON
    ...    body: zlib streams (RFC 1950) at the offsets the header gives, relative to the body's start

Each setup's moves are cut into chunks of at most CHUNK_MOVES moves, each compressed on its own. A chunk may start with
a keyframe (the whole stock grid as it is before the chunk's first move); one is written at the first chunk of a setup
and whenever the stock changes since the last keyframe add up to more bytes than a keyframe. Seeking to move n: the
chunk that holds it, the last keyframe at or before that chunk, then the chunks from there, in order.
"""
from __future__ import annotations

import json
import math
import os
import struct
import zlib

import numpy

MAGIC = b"STVCAMP1"
VERSION = 1
CHUNK_MOVES = 1024
# camlib's motion kinds, in its own order (camlib.simulation _Decoder.motion); one it adds later is "other".
KINDS = ("rapid", "cut", "plunge", "lead", "link", "retract", "tap", "shift", "thread", "other")
CURVES = ("line", "arc", "helix")
PLANES = ("xy", "xz", "yz")
MOVE = struct.Struct("<BBHHHddd")      # kind, curve, operation, tool, reserved 0, end x y z (mm)
ARC = struct.Struct("<dddfB3x")        # centre x y z (mm), sweep (rad, + counter-clockwise about the plane normal), plane
TAIL = struct.Struct("<ffII")          # feed mm/min (NaN: rapid), duration s, first G-code line (0: none), changed cells
CELL = numpy.dtype([("index", "<u4"), ("lower", "<f4"), ("upper", "<f4")])   # 12 bytes
# camlib's packed stock delta (36 bytes a cell): index u32, old lower f64, old upper f64, new lower f64, new upper f64.
DELTA = numpy.dtype([("index", "<u4"), ("old_lower", "<f8"), ("old_upper", "<f8"), ("lower", "<f8"), ("upper", "<f8")])
LEVEL = 6
NO_INDEX = 0xFFFF


class SetupStream:
    """Collects one setup's moves into chunks, written to `body` (a binary file) as they fill."""

    def __init__(self, body, setup_id, state, *, tools, operations, machine, controller, post):
        self.body, self.setup_id = body, setup_id
        self.nx, self.ny = state.nx, state.ny
        self.min_mm, self.max_mm = tuple(state.min_mm), tuple(state.max_mm)
        self.tools, self.operations = list(tools), list(operations)
        self.tool_index = {t["id"]: i for i, t in enumerate(self.tools)}
        self.operation_index = {o["id"]: i for i, o in enumerate(self.operations)}
        self.meta = dict(id=setup_id, machine=machine, controller=controller, post=post,
                         initial_position_mm=[float(v) for v in state.position])
        # The grid as the viewer keeps it: each cell's lower and upper bound of the stock's top height (float32),
        # starting as camlib's stock does (full block: both at the stock top).
        self.grid = numpy.full((self.nx * self.ny, 2), self.max_mm[2], dtype="<f4")
        self.keyframe_raw = self.grid.nbytes
        self.since_keyframe = math.inf
        self.chunks, self.pending, self.pending_bytes = [], [], 0
        self.moves, self.seconds = 0, 0.0
        self.chunk_first, self.chunk_start_s, self.chunk_keyframe = 0, 0.0, None

    def add(self, motion, changes, count, duration_s, line):
        """One move: camlib's motion dict, its packed stock delta (`count` cells), nominal duration and first G-code line."""
        if not self.pending:
            self._start_chunk()
        curve = motion["curve"]
        shape = curve.get("kind", "line")
        record = [MOVE.pack(KINDS.index(motion["kind"]) if motion.get("kind") in KINDS else KINDS.index("other"),
                            CURVES.index(shape) if shape in CURVES else 0,
                            self.operation_index.get(motion.get("operation"), NO_INDEX),
                            self.tool_index.get(motion.get("tool"), NO_INDEX), 0, *map(float, curve["end"]))]
        if shape in ("arc", "helix"):
            record.append(ARC.pack(*map(float, curve["center"]), float(curve["sweep_rad"]),
                                   PLANES.index(curve.get("plane", "xy"))))
        feed = motion.get("feed_mm_min")
        record.append(TAIL.pack(math.nan if feed is None else float(feed), float(duration_s), int(line or 0), int(count)))
        if count:
            delta = numpy.frombuffer(changes, dtype=DELTA, count=count)
            cells = numpy.empty(count, dtype=CELL)
            cells["index"], cells["lower"], cells["upper"] = delta["index"], delta["lower"], delta["upper"]
            self.grid[delta["index"], 0] = cells["lower"]
            self.grid[delta["index"], 1] = cells["upper"]
            record.append(cells.tobytes())
        data = b"".join(record)
        self.pending.append(data)
        self.pending_bytes += len(data)
        self.since_keyframe += count * CELL.itemsize
        self.moves += 1
        self.seconds += float(duration_s)
        if len(self.pending) >= CHUNK_MOVES:
            self._finish_chunk()

    def _start_chunk(self):
        self.chunk_keyframe = None
        if self.since_keyframe >= self.keyframe_raw:
            packed = zlib.compress(self.grid.tobytes(), LEVEL)
            self.chunk_keyframe = dict(offset=self.body.tell(), length=len(packed))
            self.body.write(packed)
            self.since_keyframe = 0
        self.chunk_first, self.chunk_start_s = self.moves, self.seconds

    def _finish_chunk(self):
        if not self.pending:
            return
        packed = zlib.compress(b"".join(self.pending), LEVEL)
        self.chunks.append(dict(first_move=self.chunk_first, moves=len(self.pending), offset=self.body.tell(),
                                length=len(packed), raw_length=self.pending_bytes, start_s=round(self.chunk_start_s, 6),
                                keyframe=self.chunk_keyframe))
        self.body.write(packed)
        self.pending, self.pending_bytes = [], 0

    def finish(self):
        self._finish_chunk()
        stock = dict(min_mm=list(self.min_mm), max_mm=list(self.max_mm), nx=self.nx, ny=self.ny,
                     cell_mm=[(self.max_mm[0] - self.min_mm[0]) / self.nx, (self.max_mm[1] - self.min_mm[1]) / self.ny])
        return dict(self.meta, stock=stock, tools=self.tools, operations=self.operations, moves=self.moves,
                    seconds=round(self.seconds, 6), chunks=self.chunks)


def write(path, setups, body_path, *, camlib):
    """Writes the stream: the header (each setup as SetupStream.finish() gave it) and then the body file's bytes."""
    header = dict(format="steve-camlib-playback", version=VERSION, units="mm", camlib=camlib, kinds=list(KINDS),
                  curves=list(CURVES), planes=list(PLANES), setups=setups)
    text = json.dumps(header, allow_nan=False, separators=(",", ":")).encode()
    with open(path, "wb") as out, open(body_path, "rb") as body:
        out.write(MAGIC + struct.pack("<II", VERSION, len(text)) + text)
        while block := body.read(1 << 20):
            out.write(block)
    os.unlink(body_path)
