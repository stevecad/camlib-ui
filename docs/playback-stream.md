# The playback stream (`cam-playback.bin`)

A full build writes every move of every setup, with the stock each move removes, to one file the viewer reads by HTTP
range requests: it seeks to any move without reading the whole program. It is display data. camlib's checks, not this
file, decide whether a program is released.

- Writer: `camlib_ui/build/stream.py` (`SetupStream`, `write`), fed by camlib's own replay of the posted, decoded
  G-code (`Job.post` → `stock_state(...).accept(frame)`).
- Reference reader: `camlib_ui/stream.py` (`Reader`, `check`, `volume`). The build checks every stream it returns with
  it before the build is marked done.
- Viewer's reader: `web/src/cam/stream.ts` (`PlaybackStream`), a port of the reference reader with the same checks.
  `tests/test_stream_parity.py` runs it against the reference reader.

The stream holds the first machine of each setup (the playback is the same program whatever the post). All lengths are
millimetres in the setup's work coordinates. Everything is little-endian.

## Layout

```
magic   b"STVCAMP1"        8 bytes
u32     version            1
u32     header length H
H       header             UTF-8 JSON
...     body               zlib streams (RFC 1950) at the offsets the header gives, relative to the body's start
```

## Header

```json
{
  "format": "steve-camlib-playback", "version": 1, "units": "mm",
  "camlib": {"version": "…", "commit": "…", "posts": "…"},
  "kinds": ["rapid", "cut", "plunge", "lead", "link", "retract", "tap", "shift", "thread", "other"],
  "curves": ["line", "arc", "helix"],
  "planes": ["xy", "xz", "yz"],
  "setups": [{
    "id": "top", "machine": "mill", "controller": "control", "post": "linuxcnc",
    "initial_position_mm": [0, 0, 60],
    "stock": {"min_mm": [-5, -5, -6], "max_mm": [105, 65, 21], "nx": 220, "ny": 140, "cell_mm": [0.5, 0.5]},
    "tools": [{"id": "…", "name": "…", "shape": {"kind": "flat"}, "diameter_mm": 10, "cutting_length_mm": 30,
               "overall_length_mm": 75, "shank_diameter_mm": 10, "flutes": 3, "stickout_mm": 45, "gauge_length_mm": 115,
               "holders": [{"z_min_mm": 45, "z_max_mm": 75, "radius_min_mm": 17.5, "radius_max_mm": 17.5}]}],
    "operations": [{"id": "face", "kind": "facing", "tool": "t_em10", "tool_number": 1, "length_register": 1,
                    "spindle_rpm": 9000, "feed_mm_min": 1200}],
    "moves": 318, "seconds": 555.74, "restarts": [],
    "chunks": [{"first_move": 0, "moves": 318, "offset": 265, "length": 9876, "raw_length": 123456,
                "start_s": 0.0, "keyframe": {"offset": 0, "length": 265}}]
  }]
}
```

`kinds`, `curves` and `planes` are the tables a move's byte fields index. Chunks are contiguous: each one's
`first_move` is the previous one's `first_move + moves`, and their moves add up to the setup's `moves`.

## Stock grid

The stock is a grid of `nx × ny` columns over the stock's XY extent (cell `i` is column `i % nx`, row `i // nx`). Each
cell holds two float32 heights: the lower and the upper bound of the stock's top in that column (camlib's own stock
model; the material between them is undecided at the grid's resolution). Before the first move every cell is at the
stock's top, both bounds. The viewer draws the upper bound: the most material that may still be there.

## Turned stock

A lathe setup's stock is camlib's own turned stock (`camlib.turn_state.TurnStockState.stock()`): the bar is cut into
bins along Z, and each bin holds the bounds of the bar's outer radius and of its bore's radius. Its header says so:

```json
"stock": {"kind": "turned", "z_min_mm": -60, "z_max_mm": 2, "outer_radius_mm": 20, "bore_radius_mm": 0,
          "nx": 248, "ny": 2, "cell_mm": [0.25, 0.25], "min_mm": [-20, -20, -60], "max_mm": [20, 20, 2], "rings": []}
```

The grid is `nx` bins by two rows, in the same cells and changes as a milling grid: cell `i` (row 0) is bin `i`'s outer
radius, cell `nx + i` (row 1) its bore radius, each a lower and an upper bound (float32, mm). Bin `i` spans
`z_min_mm + i × cell_mm[0]` to one bin length further. Before the first move every bin is the bar: the outer radius at
`outer_radius_mm`, the bore at `bore_radius_mm`, both bounds. `min_mm` and `max_mm` are the bar's box about the axis.
camlib's lathe run gives the whole stock after each move rather than a delta, so a move's changes are the cells that
differ from the move before. The viewer draws the most material that may be there (the outer radius' upper bound around
the bore's lower bound), revolved about Z.

`rings` lists the rings camlib records as certainly removed inside the material (face grooves): `[moves, z0, z1, r0,
r1]`, each there once `moves` moves are done. The viewer doesn't draw them yet.

Lathe coordinates are the work's: X is the radius from the spindle axis, Z runs along it, every move has Y 0 and arcs
are in the `xz` plane.

### Turning tools

A lathe setup's tools are described for drawing only (`camlib_ui/build/turning.py`):

```json
{"id": "t_part", "name": "t_part", "number": 4, "offset": 4,
 "turning": {"insert": "groove", "side": "outer", "hand": "right", "nose_radius_mm": 0.2,
             "insert_outline": [[0, 0], [0, 3], [22, 3], [22, 0]], "holder_outline": [[22, 0], …], "holder_y_mm": [-10, 2]}}
```

`insert_outline` and `holder_outline` are (x, z) points relative to the point the program moves (the setup's
`controlled_point`: each tool's imaginary tip, or its nose centre), mirrored as camlib mirrors them (x for a boring
tool, z for a left-hand one); `holder_y_mm` is the holder's extent across the centre plane. Arcs are chords of at most
10°. camlib checked every move with its own model of the insert, holder and body, never with these outlines. A turning
operation carries `feed_mm_rev` (and `surface_speed_m_min`); its `feed_mm_min` is null, its `kind` is camlib's with a
`turn_` prefix, and its `tool_number` and `length_register` are its tool's turret station and offset.

## Chunks

A chunk is up to 1024 moves, compressed together. Decompressed, it is the moves one after the other:

| Field | Type | |
|---|---|---|
| kind | u8 | index into `kinds` |
| curve | u8 | index into `curves` |
| operation | u16 | index into the setup's `operations` (0xFFFF: none, a move between operations) |
| tool | u16 | index into the setup's `tools` (0xFFFF: none) |
| reserved | u16 | 0 |
| end | 3 × f64 | where the tool tip is at the move's end |
| *arc or helix only:* center | 3 × f64 | the arc's centre |
| sweep | f32 | radians, positive counter-clockwise about the plane's normal |
| plane | u8 | index into `planes`, then 3 bytes of padding |
| feed | f32 | mm/min; NaN for a rapid |
| duration | f32 | the move's nominal seconds |
| line | u32 | the move's first line in the posted G-code (1-based; 0: none) |
| changed | u32 | how many stock cells the move changes |
| changes | changed × (u32, f32, f32) | each cell's index and its new lower and upper heights |

A move starts where the previous one ended (the first at `initial_position_mm`), unless the setup's header lists it in
`restarts`: `[[move, x, y, z], …]`, in move order, each the point that move (0-based) starts at instead. A tool change
makes one when it leaves the new tool's tip somewhere else: a change in place moves the tip along Z by the difference
of the two gauge lengths, a change that goes to a position leaves the tip there. camlib models no move between the
previous end and a restart, so a viewer draws and cuts nothing there. A stream without `restarts` has none. A helix
moves along its plane's normal from its start to its end while it turns.

## Keyframes

A chunk may carry a keyframe: the whole grid (`nx × ny × 2` float32, lower then upper per cell) as it is before the
chunk's first move, compressed on its own. The first chunk of a setup has one, and another is written whenever the
cells changed since the last keyframe add up to more bytes than a keyframe.

A turned stock's keyframe is the same: its `nx × 2` cells, lower then upper per cell.

## Seeking

The stock after `n` moves (0: before the first): find the chunk holding move `n − 1`, take the last keyframe at or
before it (or the initial grid), then apply the changes of every move from that keyframe's chunk up to move `n − 1`.
A reader that already sits between that keyframe and `n` can carry on from where it is instead.
