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
    "moves": 318, "seconds": 555.74,
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

A move starts where the previous one ended (the first at `initial_position_mm`). A helix moves along its plane's
normal from its start to its end while it turns.

## Keyframes

A chunk may carry a keyframe: the whole grid (`nx × ny × 2` float32, lower then upper per cell) as it is before the
chunk's first move, compressed on its own. The first chunk of a setup has one, and another is written whenever the
cells changed since the last keyframe add up to more bytes than a keyframe.

## Seeking

The stock after `n` moves (0: before the first): find the chunk holding move `n − 1`, take the last keyframe at or
before it (or the initial grid), then apply the changes of every move from that keyframe's chunk up to move `n − 1`.
A reader that already sits between that keyframe and `n` can carry on from where it is instead.
