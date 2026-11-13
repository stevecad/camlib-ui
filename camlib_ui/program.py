"""camlib-ui's side of a camlib program (docs/programs.md): the project's part geometry, the shop's tools and machine as
camlib objects, and the `Program` the build posts. Everything else in a program is camlib itself
(github.com/stevecad/camlib): stock, setups, operations, checks. (Ported from STEVE Studio's steve_camlib.)

    from links import part, shop
    from camlib import Job, Setup, Facing, Pocket, Contour, Drilling, StockSpec
    from camlib.verification import StreamChecks, StockContactOptions
    from camlib_ui.program import solid, face, tool, slot, machine, Program

    mill = tool(shop.t_em6)                       # a shop Tool → camlib ToolAssembly (cutter + holder envelope)
    vise = fixture(shop.vise, at=(50, -5, -1))    # a shop fixture placed in work coordinates → camlib Prism bodies
    ...
    program = Program(job, machine(shop.vmc, setup, tooling=shop.rack, work_to_machine=WorkFrame((200, 150, -300)),
                                   fixtures=vise, ...premises))

Nothing here invents a machine value. What the shop declares is mapped; what camlib needs and the shop does not hold
(coolant, the work offset's place, the tool-change pose, the controller's options) is the program's to state, and camlib
refuses a machine with a value missing. A mapping that cannot be exact (a face-mounted cutter, a part-derived holder, an
unknown controller) is refused with what to do instead.

Each machine(...) also carries the setup's scene for camlib's stream checks, as data: the machine's travel from the shop
(its spindle's gauge-line travel; stage 2 turns it into camlib's tip travel with the setup's tools) and the fixtures and
protected parts the program places (camlib Prism bodies). Stage 2 builds camlib's Scene from it for every move of the
posted program.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import importlib
import importlib.util
import math
import re

__all__ = ["solid", "face", "faces", "part_target", "region", "silhouette", "hole_centers", "surface", "paths", "path", "polyline", "dxf_parts", "tool", "slot",
           "station", "turned", "head", "cutting", "fixture", "protected", "machine", "Program", "Target", "POSTS"]

_ID = re.compile(r"[A-Za-z0-9_.-]{1,128}\Z")


class ShopMappingError(ValueError):
    """A shop item that can't be mapped to camlib exactly (the message says what to change)."""


# ---------------------------------------------------------------------------------------------------------- geometry

def _instance(link):
    """A linked document as built (LinkedInstance): `from links import part` gives a Link; calling it builds it."""
    return link() if callable(link) and not hasattr(link, "result") else link


def solid(link):
    """The linked part's solid, as a CadQuery Shape in the part's own coordinates (what camlib.cadquery takes)."""
    import cadquery as cq
    result = getattr(_instance(link), "result", None)
    if isinstance(result, cq.Workplane):
        shapes = [v for v in result.vals() if isinstance(v, cq.Shape)]
        result = shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes) if shapes else None
    if isinstance(result, cq.Assembly):
        result = result.toCompound()
    if not isinstance(result, cq.Shape):
        raise ValueError("solid(link) needs a linked part (a document whose `result` is its solid); "
                         f"got {type(result).__name__}.")
    return result


def faces(link, name):
    """The faces a persistent name selects on the linked part, e.g. faces(bracket, "pocket.floor")."""
    found = _instance(link).faces(name)
    return list(found) if isinstance(found, (list, tuple)) else [found]


def face(link, name):
    """One face of the linked part by persistent name (camlib.cadquery.export_floor_region takes it)."""
    found = faces(link, name)
    if len(found) != 1:
        raise ValueError(f"{name!r} selects {len(found)} faces of the linked part; name one face.")
    return found[0]


def part_target(link, *, max_error_mm=0.005, base_z_mm=None):
    """The linked part as camlib's material-check target, built as camlib proves gouges and leftover material on a CAD
    solid (camlib python/tests/test_cad_inner_patches.py): its surface mesh (`export_surface_mesh`, a bounded
    approximation: camlib's default source_enclosure "bounded") with the solid's own planar faces as inner bounds
    (`export_inner_patches`), so a cut below the part's surface is a definite gouge. camlib protects everything below
    its base plane: by default the solid's lowest point; when the stock stands below the part (held by it, cut through
    into it), `base_z_mm` is the stock's bottom, so cutting through the part into that stock isn't a gouge. Its
    revision is the link's pinned revision. Use it as `StreamChecks(material=(MaterialCheck(part_target(part)),))`."""
    from camlib.cadquery import export_inner_patches, export_surface_mesh
    from camlib.material import SurfaceTarget
    shape = solid(link)
    source = getattr(link, "source", None) or getattr(_instance(link), "source", None) or {}
    revision = str(source.get("revision") or "1")
    lowest = shape.BoundingBox().zmin
    if base_z_mm is not None and not (isinstance(base_z_mm, (int, float)) and math.isfinite(base_z_mm)
                                      and base_z_mm <= lowest):
        raise ValueError(f"part_target(base_z_mm={base_z_mm!r}): the base must be at or below the part's lowest point "
                         f"({lowest:.4f} mm).")
    return SurfaceTarget("part", revision, export_surface_mesh(shape, max_error_mm=max_error_mm),
                         lowest if base_z_mm is None else float(base_z_mm),
                         inner_patches=export_inner_patches(shape, max_error_mm=max_error_mm))


# Geometry picked on the part by name (docs/programs.md "Geometry from the part"): named faces and edges of the part
# ("face12", "edge7" or the names the part file gives), as the camlib geometry each operation takes.

def _alias(link):
    return str(getattr(link, "alias", None) or getattr(_instance(link), "alias", None) or "part")


def _label(text):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(text))[:128] or "region"


def region(link, *names, name=None, max_error_mm=0.005):
    """The planar region of one or more flat faces of the linked part that face along Z (a pocket's floor, the part's
    top or bottom for a contour, a chamfer or a V-carve): camlib.cadquery.export_floor_region of each face, their
    components together as one camlib PlanarRegion, e.g. region(part, "pocket.floor")."""
    from camlib.cadquery import export_floor_region
    from camlib.planar import PlanarRegion
    if not names:
        raise ValueError('region(part, "<face>", ...) names at least one face of the part.')
    source = {"document": _alias(link), "faces": [str(n) for n in names]}
    regions = [export_floor_region(face(link, n), name=_label(n), source=source, max_error_mm=max_error_mm) for n in names]
    if len(regions) == 1 and name is None:
        return regions[0]
    return PlanarRegion(_label(name or "+".join(names)), tuple(c for r in regions for c in r.components),
                        max(r.boundary_error_mm for r in regions), source)


def silhouette(link, z_mm, *, max_error_mm, surface_error_mm=0.001, name=None):
    """The linked part's outline at a depth as a camlib PlanarRegion, for a Contour around the whole part at that floor
    (camlib's Engine.silhouette_region, docs/operations.md "A mesh part's outline"): the plan-view shadow of everything
    of the part at or above `z_mm`, from its surface mesh (tessellated within `surface_error_mm`). At or below the
    part's lowest point it is the whole part's outline. The region is conservative and states its own error
    (boundary_error_mm: the mesh's error and a small reserve), which operations add to their clearance; camlib refuses a
    silhouette whose error is over `max_error_mm` (no default: say what the outline may be off by), or a depth with
    nothing at or above it. Its edges are straight, as fine as the mesh."""
    import camlib
    from camlib.planar import PlanarRegion
    mesh = surface(link, max_error_mm=surface_error_mm)
    with camlib.Engine() as engine:
        found = engine.silhouette_region(mesh, z_mm, max_error_mm=max_error_mm)
    region = PlanarRegion.from_dict(found["region"])
    if name is None:
        return region
    return PlanarRegion(_label(name), region.components, region.boundary_error_mm, region.source)


def hole_centers(link, *names):
    """The (x, y) centres of holes of the linked part, from their wall faces (cylinders along Z), in the order named:
    what Drilling, Bore, Reaming, Tapping and ThreadMilling take as centers_mm. A hole whose wall is several faces
    counts once."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder
    if not names:
        raise ValueError('hole_centers(part, "<hole wall>", ...) names at least one hole wall.')
    centers = []
    for n in names:
        for f in faces(link, n):
            surface = BRepAdaptor_Surface(f.wrapped)
            if surface.GetType() != GeomAbs_Cylinder:
                raise ValueError(f"{n!r} isn't a hole wall (a cylindrical face) of the linked part.")
            axis = surface.Cylinder().Axis()
            direction, at = axis.Direction(), axis.Location()
            if abs(abs(direction.Z()) - 1) > 1e-9:
                raise ValueError(f"{n!r} doesn't run along Z: holes are machined along the spindle.")
            # The axis point is anywhere on the axis: its X and Y are the centre.
            point = (at.X(), at.Y())
            if not any(math.hypot(point[0] - x, point[1] - y) <= 1e-6 for x, y in centers):
                centers.append(point)
    return tuple(centers)


def surface(link, *, max_error_mm=0.005):
    """The linked part's whole surface as camlib's SurfaceMesh (camlib.cadquery.export_surface_mesh of its solid): what
    roughing protects (target) and 3D finishing follows (surface)."""
    from camlib.cadquery import export_surface_mesh
    return export_surface_mesh(solid(link), source={"document": _alias(link)}, max_error_mm=max_error_mm)


def _edge_piece(link, n, edge):
    """One edge of the part as (start, end, arc centre or None, sweep degrees) in XY; the edge lies flat."""
    kind = edge.geomType()
    start, end = edge.startPoint(), edge.endPoint()
    if abs(start.z - end.z) > 1e-6 or (kind == "CIRCLE" and abs(edge.arcCenter().z - start.z) > 1e-6):
        raise ValueError(f"Edge {n!r} doesn't lie flat (in a plane along XY).")
    if kind == "LINE":
        return (start.x, start.y), (end.x, end.y), None, 0.0
    if kind == "CIRCLE":
        c = edge.arcCenter()
        mid = edge.positionAt(0.5)
        a0 = math.atan2(start.y - c.y, start.x - c.x)
        a1 = math.atan2(mid.y - c.y, mid.x - c.x)
        a2 = math.atan2(end.y - c.y, end.x - c.x)
        ccw = ((start.x - c.x) * (mid.y - c.y) - (start.y - c.y) * (mid.x - c.x)) > 0
        span = lambda a, b: (b - a) % math.tau if ccw else -((a - b) % math.tau)
        sweep = span(a0, a1) + span(a1, a2)
        if math.hypot(end.x - start.x, end.y - start.y) <= 1e-9:
            sweep = math.tau if ccw else -math.tau   # A whole circle.
        return (start.x, start.y), (end.x, end.y), (c.x, c.y), math.degrees(sweep)
    raise ValueError(f"Edge {n!r} is a {kind.lower()}: paths follow straight edges and circular arcs.")


def dxf_parts(name, *, unit_mm, join_tolerance_mm, layers=None, ignore=()):
    """The parts drawn in a DXF file of the project (camlib.dxf.read_parts): one PlanarRegion per closed outline, with
    the holes drawn inside it, for camlib's NestPart. `name` is the file's name in the project. `unit_mm` (1 for a
    drawing in millimetres, 25.4 for inches) and `join_tolerance_mm` (how far apart two ends may be and still be one
    corner) are stated, never assumed; a spline, an open outline or a unit that disagrees with the file is refused
    with the entity it is about."""
    import sys
    from pathlib import Path
    from camlib.dxf import read_parts
    if not isinstance(name, str) or "/" in name or "\\" in name or not name.lower().endswith(".dxf"):
        raise ValueError(f"dxf_parts({name!r}): the name of a .dxf file in the project.")
    # The program's own folder (a build's copy of the project).
    folder = Path(sys._getframe(1).f_globals.get("__file__", ".")).parent
    path = folder / name
    if not path.is_file():
        raise ValueError(f"The project has no file {name}: add it (Import DXF), or check the name.")
    return read_parts(path, unit_mm=unit_mm, join_tolerance_mm=join_tolerance_mm, layers=layers, ignore=ignore,
                      name=Path(name).stem)


def polyline(*points):
    """Straight lines through (x, y) points, in millimetres, as a camlib TracePath: a line typed in a form (a mark on
    a sheet). At least two points; two that coincide are refused, as camlib would."""
    from camlib.operations import TraceLine, TracePath
    if len(points) < 2:
        raise ValueError("polyline takes at least two (x, y) points.")
    clean = []
    for p in points:
        if not (isinstance(p, (tuple, list)) and len(p) == 2
                and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in p)):
            raise ValueError(f"polyline point {p!r} isn't an (x, y) pair of numbers.")
        clean.append((float(p[0]), float(p[1])))
    for a, b in zip(clean, clean[1:]):
        if a == b:
            raise ValueError(f"polyline has the point {a} twice in a row.")
    return TracePath(clean[0], tuple(TraceLine(p) for p in clean[1:]))


def paths(link, *names, tolerance_mm=1e-4):
    """Flat edges of the linked part (lines and circular arcs, in XY) as camlib TracePaths: chained end to end in the
    order named (each edge turned around when needed); a new path starts wherever the next edge doesn't join. What
    Trace and Project follow."""
    from camlib.operations import TraceArc, TraceLine, TracePath
    if not names:
        raise ValueError('paths(part, "<edge>", ...) names at least one edge of the part.')
    pieces = [_edge_piece(link, n, e) for n in names for e in _instance(link).edges(n)]
    close = lambda p, q: math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance_mm
    flip = lambda piece: (piece[1], piece[0], piece[2], -piece[3])
    chains = []
    for piece in pieces:
        if chains and close(chains[-1][-1][1], piece[0]):
            chains[-1].append(piece)
        elif chains and close(chains[-1][-1][1], piece[1]):
            chains[-1].append(flip(piece))
        elif chains and len(chains[-1]) == 1 and close(chains[-1][0][0], piece[0]):   # the chain's first edge ran backwards
            chains[-1] = [flip(chains[-1][0]), piece]
        elif chains and len(chains[-1]) == 1 and close(chains[-1][0][0], piece[1]):
            chains[-1] = [flip(chains[-1][0]), flip(piece)]
        else:
            chains.append([piece])
    out = [TracePath(chain[0][0], tuple(TraceLine(end) if centre is None else TraceArc(centre, sweep)
                                         for _, end, centre, sweep in chain)) for chain in chains]
    return tuple(out)


def path(link, *names, tolerance_mm=1e-4):
    """One connected chain of flat edges of the linked part as a camlib TracePath (paths(), which must give one): a
    Morph's from_path and to_path."""
    found = paths(link, *names, tolerance_mm=tolerance_mm)
    if len(found) != 1:
        raise ValueError(f"The edges {', '.join(map(repr, names))} make {len(found)} separate paths; name one connected chain.")
    return found[0]


# ---------------------------------------------------------------------------------------------------------- tools

def _definition(item, kind):
    definition = getattr(item, "definition", None)
    if not isinstance(definition, dict) or getattr(item, "kind", None) != kind:
        raise ShopMappingError(f"Expected a shop {kind} item (from the linked shop, e.g. shop.t1), got {item!r}.")
    return definition


def _cutter(item):
    """A shop cutter (rotary_cutter) → camlib Cutter, field for field."""
    from camlib import tools
    d = _definition(item, "rotary_cutter")
    key = item.key
    if d.get("mounting") == "face":
        raise ShopMappingError(f"Cutter {key} is face-mounted (a shell mill on an arbor): camlib's tool assemblies hold a "
                               "shanked cutter, so it can't be modelled exactly yet. Use a shanked cutter.")
    kind = d.get("cutter_type")
    common = dict(diameter=d["diameter_mm"], flute_length=d["cutting_length_mm"], overall_length=d["overall_length_mm"],
                  shank_diameter=d.get("shank_diameter_mm", d["diameter_mm"]), flutes=int(d["flute_count"]),
                  center_cutting=bool(d.get("center_cutting", True)), material=str(d.get("material", "")),
                  name=str(d.get("name", key))[:128])
    if d.get("neck_length_mm") is not None or d.get("neck_diameter_mm") is not None:
        if d.get("neck_length_mm") is None or d.get("neck_diameter_mm") is None:
            raise ShopMappingError(f"Cutter {key}: give both neck_length_mm and neck_diameter_mm, or neither.")
        common["neck"] = tools.Neck(d["neck_diameter_mm"], d["neck_length_mm"])
    angle = d.get("included_angle_rad")
    if kind == "flat_end_mill":
        return tools.EndMill(key, **common)
    if kind == "ball_end_mill":
        return tools.BallEndMill(key, **common)
    if kind == "bull_end_mill":
        if not d.get("corner_radius_mm"):
            raise ShopMappingError(f"Cutter {key} is a bull-nose end mill without corner_radius_mm.")
        return tools.BullEndMill(key, corner_radius=d["corner_radius_mm"], **common)
    if kind == "drill":
        if angle is None:
            raise ShopMappingError(f"Drill {key} has no point angle (included_angle_rad).")
        return tools.Drill(key, point_angle=math.degrees(angle), **common)
    if kind == "chamfer_mill":
        if angle is None:
            raise ShopMappingError(f"Chamfer mill {key} has no included angle (included_angle_rad).")
        return tools.ChamferMill(key, angle=math.degrees(angle), tip_diameter=d.get("tip_diameter_mm") or 0, **common)
    if kind == "reamer":
        # camlib models a reamer as a flat cutter of its diameter that doesn't cut at its centre (camlib Reaming).
        if common["center_cutting"]:
            raise ShopMappingError(f"Reamer {key} is marked centre cutting: a reamer cuts at its diameter only.")
        return tools.EndMill(key, **common)
    if kind in ("tap", "thread_mill", "boring_bar"):
        shape = dict(overall_length=common["overall_length"], shank_diameter=common["shank_diameter"],
                     material=common["material"], name=common["name"])
        if kind == "tap":
            if d.get("minor_diameter_mm") is None:
                raise ShopMappingError(f"Tap {key} has no minor_diameter_mm (its tap drill size).")
            return tools.Tap(key, drill_diameter=d["minor_diameter_mm"], thread_length=common["flute_length"],
                             flutes=common["flutes"], **shape)
        if "neck" not in common:
            raise ShopMappingError(f"Cutter {key} ({kind}) needs its neck: neck_length_mm and neck_diameter_mm.")
        neck = common["neck"]
        if kind == "thread_mill":
            return tools.ThreadMill(key, diameter=common["diameter"], tooth_height=common["flute_length"],
                                    neck_diameter=neck.diameter_mm, neck_length=neck.length_mm, flutes=common["flutes"],
                                    **shape)
        return tools.BoringBar(key, diameter=common["diameter"], bar_diameter=neck.diameter_mm,
                               reach=neck.length_mm + common["flute_length"], insert_length=common["flute_length"],
                               **shape)
    if kind == "face_mill":
        inserts = d.get("inserts") or {}
        if inserts.get("lead_angle_deg") == 90 and not inserts.get("corner_radius_mm") and not common["center_cutting"]:
            return tools.EndMill(key, **common)   # A square-shoulder face mill with sharp inserts: a flat cylinder.
        raise ShopMappingError(f"Face mill {key}: camlib models only a square-shoulder face mill with sharp inserts "
                               "(inserts lead_angle_deg 90, corner_radius_mm 0) exactly.")
    raise ShopMappingError(f"Cutter {key} is a {kind}: camlib has no exact model for it.")


def _holder_envelope(key, holders, stickout):
    """The holder stack's outer envelope as camlib HolderSections (tip-relative, ordered tip to gauge, contiguous) and
    the gauge length. Each shop holder profile is coaxial, relative to its machine-side plane, +Z toward the spindle;
    holder i's machine side sits on holder i-1's output frame. Overlapping profiles take the larger radius everywhere
    (pieces split where they cross), a gap is refused: missing holder geometry is never treated as clear."""
    from camlib.tools import HolderSection
    depths, segments = [], []
    for use in holders:
        holder = use.get("holder") if isinstance(use, dict) else None
        d = _definition(holder, "tool_holder")
        if d.get("geometry_source") is not None:
            raise ShopMappingError(f"Tool {key}: holder {holder.key} takes its shape from a part (geometry_source); "
                                   "camlib programs need its outer_profile entered.")
        frame, profile = d.get("output_frame"), d.get("outer_profile")
        if not frame or not profile:
            raise ShopMappingError(f"Tool {key}: holder {holder.key} needs output_frame and outer_profile.")
        depth = -float(frame["origin_mm"][2])
        if depth < 0 or any(abs(float(v)) > 1e-9 for v in frame["origin_mm"][:2]):
            raise ShopMappingError(f"Tool {key}: holder {holder.key}'s output frame must be on its axis, below its "
                                   "machine side.")
        depths.append(depth)
        segments.append((holder.key, profile))
    gauge = stickout + sum(depths)
    pieces = []   # (z0, z1, r0, r1) tip-relative
    offset = gauge   # tip-relative Z of this holder's machine-side plane
    for (holder_key, profile), depth in zip(segments, depths):
        for s in profile:
            if s.get("shape", "frustum") != "frustum":
                raise ShopMappingError(f"Tool {key}: holder {holder_key} has a rounded profile section; camlib holder "
                                       "sections are cylinders and cones.")
            z0, z1 = offset + float(s["z_start_mm"]), offset + float(s["z_end_mm"])
            pieces.append((z0, z1, float(s["radius_start_mm"]), float(s["radius_end_mm"])))
        offset -= depth
    # Below the gauge plane only (above it the taper is inside the spindle).
    pieces = [(max(a, stickout), min(b, gauge), *_clip(a, b, r0, r1, max(a, stickout), min(b, gauge)))
              for a, b, r0, r1 in pieces if min(b, gauge) > max(a, stickout)]
    cuts = sorted({stickout, gauge, *[p[0] for p in pieces], *[p[1] for p in pieces]})
    sections = []
    for lo, hi in zip(cuts, cuts[1:]):
        if hi - lo <= 1e-9:
            continue
        here = [_clip(a, b, r0, r1, lo, hi) for a, b, r0, r1 in pieces if a <= lo + 1e-9 and b >= hi - 1e-9]
        if not here:
            raise ShopMappingError(f"Tool {key}: the holders' profiles leave {lo - stickout:.3f}–{hi - stickout:.3f} mm "
                                   "above the holder mouth undescribed; the envelope must be complete.")
        sections.extend(_upper(lo, hi, here))
    merged = []
    for z0, z1, r0, r1 in sections:
        if merged and abs(merged[-1][3] - r0) < 1e-12 and abs(merged[-1][2] - merged[-1][3]) < 1e-12 and abs(r0 - r1) < 1e-12:
            merged[-1] = (merged[-1][0], z1, r0, r1)
        else:
            merged.append((z0, z1, r0, r1))
    # camlib wants sections exactly contiguous from the stick-out: join on the exact previous end.
    out, end = [], stickout
    for z0, z1, r0, r1 in merged:
        out.append(HolderSection(end, z1, r0, r1))
        end = z1
    return tuple(out), gauge


def _clip(a, b, r0, r1, lo, hi):
    """A frustum (a..b, radius r0..r1) cut to lo..hi: its radii there."""
    at = lambda z: r0 + (r1 - r0) * (z - a) / (b - a)
    return (at(lo), at(hi)) if (lo, hi) != (a, b) else (r0, r1)


def _upper(lo, hi, radii):
    """The upper envelope of linear radius functions over lo..hi, as linear pieces (split where they cross)."""
    points = {lo, hi}
    for i, (a0, a1) in enumerate(radii):
        for b0, b1 in radii[i + 1:]:
            da, db = a1 - a0, b1 - b0
            if abs(da - db) > 1e-15:
                t = (b0 - a0) / (da - db)
                if 0 < t < 1:
                    points.add(lo + t * (hi - lo))
    points = sorted(points)
    value = lambda z: max(r0 + (r1 - r0) * (z - lo) / (hi - lo) for r0, r1 in radii)
    return [(p, q, value(p), value(q)) for p, q in zip(points, points[1:]) if q - p > 1e-12]


def tool(item):
    """A shop Tool (tool_assembly: cutter, holder stack, stick-out) → camlib ToolAssembly with the same key as its id:
    the cutter field for field, the gauge length from the stick-out and the holders' output frames, the holder
    envelope from their outer profiles. A shop TurningTool (turning_tool) → camlib TurningTool with the same key as its
    id, field for field (its insert, side, hand, holder and body off the centre plane)."""
    from camlib.tools import ToolAssembly
    if getattr(item, "kind", None) == "turning_tool":
        return _turning_tool(item)
    d = _definition(item, "tool_assembly")
    if not _ID.fullmatch(item.key):
        raise ShopMappingError(f"Tool key {item.key!r} isn't a camlib id (letters, digits, _ . - only).")
    cutter = _cutter(d["cutter"])
    if d.get("stickout_mm") is None:
        raise ShopMappingError(f"Tool {item.key} has no stickout_mm.")
    holders, gauge = _holder_envelope(item.key, d.get("holders") or [], float(d["stickout_mm"]))
    if not holders:
        raise ShopMappingError(f"Tool {item.key} has no holder: camlib never treats missing holder geometry as clear.")
    return ToolAssembly(item.key, cutter, float(d["stickout_mm"]), gauge, holders)


def _assignment(tooling, assembly):
    d = _definition(tooling, "tool_setup")
    key = assembly.id if hasattr(assembly, "id") else getattr(assembly, "key", assembly)
    found = [a for a in d.get("assignments") or [] if getattr(a.get("assembly"), "key", None) == key]
    if len(found) != 1:
        raise ShopMappingError(f"Tool setup {tooling.key} loads tool {key} {len(found)} times; it must load it once.")
    return found[0]


def slot(tooling, assembly):
    """The T number and H register a shop ToolSetup gives a tool: dict(tool_number=, length_register=), to pass to an
    operation (Pocket(..., **slot(shop.rack, mill))). The tool setup must give the length register."""
    a = _assignment(tooling, assembly)
    offsets = a.get("offsets") or {}
    register = offsets.get("length_register", a.get("length_register"))
    if register is None:
        raise ShopMappingError(f"Tool setup {tooling.key}: T{a['tool_number']} has no length register; give it "
                               "(ToolSetup(..., tools={n: (tool, {\"offsets\": {\"length_register\": n}})})).")
    return dict(tool_number=int(a["tool_number"]), length_register=int(register))


# ---------------------------------------------------------------------------------------------------------- turning
# Lathes (camlib's Setup(turning=TurningSetup(...)), docs/operations.md "Turning"): the shop's turning tools as camlib's,
# their turret stations, and the part's half-section. Every tool value is the shop's; camlib refuses a tool with a value
# missing, by name.

def _insert(key, d):
    """A shop turning tool's insert as camlib's (camlib.turning), and its nose radius where the insert states it."""
    import camlib
    insert = d.get("insert") or {}
    kind = insert.get("type")
    try:
        if kind == "iso_code":
            if "holder_code" in insert:
                return camlib.TurningInsert.iso_code(insert["code"], holder=insert["holder_code"])
            return camlib.TurningInsert.iso_code(insert["code"], approach_angle_deg=insert["approach_angle_deg"])
        if kind == "iso":
            return camlib.TurningInsert.iso(included_angle_deg=insert["included_angle_deg"],
                                            approach_angle_deg=insert["approach_angle_deg"],
                                            edge_length_mm=insert["edge_length_mm"], nose_radius_mm=insert["nose_radius_mm"])
        if kind == "groove":
            return camlib.GrooveInsert(insert["width_mm"], insert["depth_mm"])
        if kind == "face_groove":
            return camlib.FaceGrooveInsert(insert["width_mm"], insert["depth_mm"])
        if kind == "thread":
            return camlib.ThreadInsert(insert["profile_angle_deg"], insert["depth_mm"])
        if kind == "drill":
            return camlib.DrillInsert(insert["diameter_mm"], insert["point_angle_deg"], insert["flute_length_mm"])
    except KeyError as error:
        raise ShopMappingError(f"Turning tool {key}: its {kind} insert has no {error.args[0]}.") from None
    raise ShopMappingError(f"Turning tool {key}: insert type {kind!r} isn't one of camlib's (iso_code, iso, groove, "
                           "face_groove, thread, drill).")


def _turning_tool(item):
    """A shop TurningTool → camlib TurningTool (id = the shop key): every value the shop's, none assumed."""
    import camlib
    d = _definition(item, "turning_tool")
    key = item.key
    if not _ID.fullmatch(key):
        raise ShopMappingError(f"Tool key {key!r} isn't a camlib id (letters, digits, _ . - only).")
    insert = _insert(key, d)
    # An ISO insert states its nose radius (its corner's); a blade, threading insert or drill takes the shop's.
    nose = d.get("nose_radius_mm", getattr(insert, "nose_radius_mm", None) if isinstance(insert, camlib.InsertOutline) else None)
    if nose is None:
        raise ShopMappingError(f"Turning tool {key} has no nose_radius_mm (a blade's or threading insert's corner radius; "
                               "0 for a drill).")
    h = d.get("holder") or {}
    missing = [k for k in ("width_mm", "length_mm", "offset_mm", "y_mm") if h.get(k) is None]
    if h.get("shape") != "rectangle" or missing:
        raise ShopMappingError(f"Turning tool {key}: its holder needs TurningHolder.rectangle(width=, length=, offset=, y=)"
                               + (f" (missing {', '.join(missing)})." if missing else "."))
    holder = camlib.TurningHolder.rectangle(insert=insert, nose_radius_mm=nose, side=d["side"], width_mm=h["width_mm"],
                                            length_mm=h["length_mm"], offset_mm=h["offset_mm"], y_mm=tuple(h["y_mm"]))
    body = {}
    if d.get("seat") is not None:
        body["seat"] = camlib.TurningSeat(d["seat"]["rake_deg"], d["seat"]["inclination_deg"])
    for name in ("insert_thickness_mm", "insert_clearance_deg", "insert_front_clearance_deg", "insert_side_clearance_deg"):
        if d.get(name) is not None:
            body[name] = d[name]
    for name in ("curved_for_diameter_mm", "insert_size_tolerance_mm"):
        if d.get(name) is not None:
            body[name] = tuple(d[name])
    try:
        return camlib.TurningTool(key, insert=insert, nose_radius_mm=nose, side=d["side"], hand=d["hand"], holder=holder,
                                  **body)
    except (TypeError, ValueError) as error:
        raise ShopMappingError(f"Turning tool {key}: {error}") from error


def station(turret, tool):
    """A turning tool's station in a shop Turret as camlib's TurnToolSetting(tool, number, offset): what a lathe
    Setup's tools are (Setup(tools=(station(shop.turret, cnmg), ...), turning=...)). The T word is T<station><offset>."""
    import camlib
    d = _definition(turret, "turret_setup")
    key = getattr(tool, "id", tool)
    found = [s for s in d.get("stations") or [] if getattr(s.get("tool"), "key", None) == key]
    if len(found) != 1:
        raise ShopMappingError(f"Turret {turret.key} holds tool {key} {len(found)} times; it must hold it once.")
    if not isinstance(tool, camlib.TurningTool):
        raise ShopMappingError(f"station(shop.{turret.key}, tool) takes the camlib tool, tool(shop.{key}).")
    return camlib.TurnToolSetting(tool, int(found[0]["station"]), int(found[0]["offset"]))


def turned(link):
    """The linked part's half-section as camlib reads it (camlib.cadquery.turning_section): its `profile`, `bore` and
    `face_grooves`, lines and arcs exact, for TurningSetup.from_section(turned(part), chuck_z_mm=..., ...). The part is
    a solid of revolution about its Z axis, its front face toward +Z (the lathe's Z; work X is the radius); camlib
    refuses any other solid (flats, cross holes, undercuts) and says why."""
    from camlib.cadquery import turning_section
    return turning_section(solid(link))


# ---------------------------------------------------------------------------------------------------------- cutting
# Plasma and laser (camlib's ThermalCut): the head from the shop's machine model, the process values from the shop's
# cutting recipe (library kind sheet_cutting_recipe). camlib's Torch and LaserHead defaults are never used.

HEAD_SHAPE = ("nozzle_diameter_mm", "nozzle_length_mm", "body_diameter_mm", "body_length_mm")


def _head_id(entry):
    return str(entry.get("id"))


def _operations(setup):
    """A setup's operations (OperationNode or bare)."""
    return [getattr(node, "op", node) for node in getattr(setup, "operations", ()) or ()]


def _head(item, head):
    """(machine model key, the model's cutting head entry) for a shop machine and an optional head id."""
    d = _definition(item, "machine_instance")
    model = _definition(d.get("model"), "machine_model")
    heads = list(model.get("cutting_heads") or [])
    chosen = [h for h in heads if head is None or _head_id(h) == head]
    if len(chosen) != 1:
        raise ShopMappingError(f"Machine {item.key}: " + (f"name its cutting head with head= ({', '.join(map(_head_id, heads))})."
                               if heads and head is None else f"its model {d['model'].key} has no cutting head "
                               f"{head!r} (heads: {', '.join(map(_head_id, heads)) or 'none'})."))
    return d["model"].key, chosen[0]


def _recipe(recipe, process):
    r = _definition(recipe, "sheet_cutting_recipe")
    settings = r.get("settings") or {}
    if settings.get("process") != process:
        raise ShopMappingError(f"Cutting recipe {recipe.key} is for {settings.get('process')}; the head cuts {process}.")
    return r, settings


def head(item, recipe, *, head=None):
    """A shop machine's plasma torch or laser head (its model's cutting_heads entry) as camlib's Torch or LaserHead,
    with the recipe's kerf: kerf_width = the recipe's kerf_mm, the nozzle and body from the head's nozzle_diameter_mm,
    nozzle_length_mm, body_diameter_mm and body_length_mm (refused when the shop doesn't give them). Its id is the head's
    id. `recipe` is a shop cutting recipe (sheet_cutting_recipe) of the head's process."""
    from camlib import tools
    model_key, entry = _head(item, head)
    process = entry.get("process")
    if process not in BEAM_PROCESSES:
        raise ShopMappingError(f"Cutting head {_head_id(entry)} is a {process} head: camlib cuts with plasma torches and "
                               "laser heads only.")
    missing = [f for f in HEAD_SHAPE if not isinstance(entry.get(f), (int, float)) or isinstance(entry.get(f), bool)]
    if missing:
        raise ShopMappingError(f"Cutting head {_head_id(entry)} of machine model {model_key} has no "
                               + ", ".join(f"cutting_heads[{_head_id(entry)}].{f}" for f in missing)
                               + ": add them to the shop's machine model (the maker's drawing or a measurement); camlib "
                               "checks the head's nozzle and body against the work and never assumes them.")
    if not _ID.fullmatch(_head_id(entry)):
        raise ShopMappingError(f"Cutting head id {_head_id(entry)!r} isn't a camlib id.")
    _, settings = _recipe(recipe, process)
    if not isinstance(settings.get("kerf_mm"), (int, float)):
        raise ShopMappingError(f"Cutting recipe {recipe.key} has no kerf_mm: the head's kerf in this material.")
    make = tools.Torch if process == "plasma" else tools.LaserHead
    return make(_head_id(entry), kerf_width=float(settings["kerf_mm"]), nozzle_diameter=float(entry["nozzle_diameter_mm"]),
                nozzle_length=float(entry["nozzle_length_mm"]), body_diameter=float(entry["body_diameter_mm"]),
                body_length=float(entry["body_length_mm"]), name=str(entry.get("id"))[:128])


def cutting(recipe, item, *, height_mode, lead_in_radius_mm, lead_out_radius_mm, head=None):
    """A ThermalCut's process values from the shop's cutting recipe, as keyword arguments:
    feed_mm_min, cut_height_mm, pierce_delay_s (pierce_seconds), pierce_clearance_mm (the recipe's pierce_radius_mm
    less half the kerf: camlib keeps a pierce that far beyond half a kerf from every part), lead_in and lead_out
    (camlib Leads: the recipe's lead_in_mm and lead_out_mm with the arc radii the program states), height_mode, and
    with height_mode "program" pierce_height_mm and travel_height_mm (the recipe's clearance_mm), and power_percent:
    a laser's power_w as a percentage of the head's max_power_w; a plasma torch is fired at full power (the plasma posts'
    S1). The program adds parts, leads it changes, tool_number and length_register; a value it gives replaces one here."""
    from camlib.operations import Lead
    _, entry = _head(item, head)
    process = entry.get("process")
    r, s = _recipe(recipe, process)
    if height_mode not in ("fixed", "program"):
        raise ShopMappingError("height_mode is 'fixed' (the controller handles pierce and cut heights) or 'program'.")
    dialect = (_definition(_definition(item, "machine_instance").get("controller"), "controller")).get("dialect")
    post = next((p for p in POSTS.values() if dialect in p.dialects and p.implicit), None)
    owns = post.owns if post is not None else ()
    if "heights" in owns and height_mode != "fixed":
        raise ShopMappingError(f"Post {post.name}: the controller sets the pierce and cut heights itself (its material "
                               "setup); plan with height_mode='fixed'.")
    needed = ["feed_mm_min", "cut_height_mm", "pierce_seconds", "pierce_radius_mm", "kerf_mm", "lead_in_mm", "lead_out_mm",
              *(["pierce_height_mm", "clearance_mm"] if height_mode == "program" else [])]
    missing = [k for k in needed if not isinstance(s.get(k), (int, float)) or isinstance(s.get(k), bool)]
    if missing:
        raise ShopMappingError(f"Cutting recipe {recipe.key} has no {', '.join(missing)}"
                               + (" (the program moves Z itself with height_mode=\"program\")" if height_mode == "program"
                                  else "") + ": add them to the shop's recipe (the torch's cut chart); none is assumed.")
    values = dict(feed_mm_min=float(s["feed_mm_min"]), cut_height_mm=float(s["cut_height_mm"]),
                  pierce_delay_s=float(s["pierce_seconds"]),
                  pierce_clearance_mm=float(s["pierce_radius_mm"]) - float(s["kerf_mm"]) / 2,
                  lead_in=Lead(float(s["lead_in_mm"]), float(lead_in_radius_mm)),
                  lead_out=Lead(float(s["lead_out_mm"]), float(lead_out_radius_mm)), height_mode=height_mode)
    if height_mode == "program":
        values.update(pierce_height_mm=float(s["pierce_height_mm"]), travel_height_mm=float(s["clearance_mm"]))
    if "pierce_delay" in owns:
        values["pierce_delay_s"] = 0.0   # the controller's material setup pierces (the post refuses a program dwell)
    if "height_control" in owns:
        values["height_control"] = False   # the controller's material setup switches torch height control
    if process == "laser":
        if not entry.get("max_power_w"):
            raise ShopMappingError(f"Cutting head {_head_id(entry)} has no max_power_w: a laser's power is posted as a "
                                   "share of it; add the maker's value to the shop's machine model.")
        if float(s["power_w"]) > float(entry["max_power_w"]):
            raise ShopMappingError(f"Recipe {recipe.key} asks {s['power_w']} W of head {_head_id(entry)} "
                                   f"({entry['max_power_w']} W at most).")
        values["power_percent"] = 100 * float(s["power_w"]) / float(entry["max_power_w"])
    else:
        values["power_percent"] = 100.0
    return values


# ---------------------------------------------------------------------------------------------------------- fixtures
# Frames: p_parent = origin + [x y z] · p_local, axes the columns.

def _frame(value, where):
    """A frame as (origin, (x, y, z)) from a frame dict (missing fields: the identity's) or camlib WorkFrame."""
    get = value.get if isinstance(value, dict) else (lambda k, d=None: getattr(value, k, d))
    try:
        origin = tuple(float(v) for v in get("origin_mm", (0.0, 0.0, 0.0)))
        axes = tuple(tuple(float(v) for v in get(k, d)) for k, d in (("x", (1, 0, 0)), ("y", (0, 1, 0)), ("z", (0, 0, 1))))
    except (TypeError, ValueError):
        raise ShopMappingError(f"{where} isn't a frame (origin_mm, x, y, z).") from None
    if len(origin) != 3 or any(len(a) != 3 for a in axes) or not all(math.isfinite(v) for v in (*origin, *sum(axes, ()))):
        raise ShopMappingError(f"{where} isn't a frame of finite 3-vectors.")
    dot = lambda a, b: sum(p * q for p, q in zip(a, b))
    if any(abs(dot(a, b) - (i == j)) > 1e-9 for i, a in enumerate(axes) for j, b in enumerate(axes)) or abs(
            dot((axes[0][1] * axes[1][2] - axes[0][2] * axes[1][1], axes[0][2] * axes[1][0] - axes[0][0] * axes[1][2],
                 axes[0][0] * axes[1][1] - axes[0][1] * axes[1][0]), axes[2]) - 1) > 1e-9:
        raise ShopMappingError(f"{where} must be a rigid, right-handed frame.")
    return origin, axes


def _compose(outer, inner):
    """outer ∘ inner: inner maps local → middle, outer middle → parent."""
    (o1, a1), (o2, a2) = outer, inner
    apply = lambda v: tuple(sum(a1[j][i] * v[j] for j in range(3)) for i in range(3))
    return tuple(o + d for o, d in zip(o1, apply(o2))), tuple(apply(axis) for axis in a2)


def _placement(at, rotation_deg, where):
    """`at` (x, y, z), turned rotation_deg about work Z, or a camlib WorkFrame / frame dict: local → work."""
    if isinstance(at, (list, tuple)) and len(at) == 3 and all(isinstance(v, (int, float)) and not isinstance(v, bool)
                                                              for v in at):
        turns = float(rotation_deg) % 360.0
        exact = {0.0: (1.0, 0.0), 90.0: (0.0, 1.0), 180.0: (-1.0, 0.0), 270.0: (0.0, -1.0)}
        c, s = exact.get(turns) or (math.cos(math.radians(turns)), math.sin(math.radians(turns)))
        return _frame(dict(origin_mm=at, x=(c, s, 0.0), y=(-s, c, 0.0), z=(0.0, 0.0, 1.0)), where)
    if rotation_deg:
        raise ShopMappingError(f"{where}: rotation_deg turns an (x, y, z) placement; a frame carries its own axes.")
    if at is None:
        raise ShopMappingError(f"{where} needs at=(x, y, z): where it sits in the setup's work coordinates (the part's).")
    return _frame(at, where)


def _inverse(frame):
    """The frame's inverse, as camlib's WorkFrame (export_fixture's work_frame maps work coordinates to model ones)."""
    from camlib.motion import WorkFrame
    origin, axes = frame
    rows = tuple(tuple(axes[j][i] for j in range(3)) for i in range(3))   # Aᵀ's columns are A's rows.
    back = tuple(-sum(axes[i][k] * origin[k] for k in range(3)) for i in range(3))
    return WorkFrame(back, *rows)


def _pinned(item, pin, where):
    """A fixture component's geometry (its geometry_source {"file": ..., "body": ...}): the part file, found next to
    the shop file that made the fixture."""
    from pathlib import Path
    from .parts import load_part
    name = pin.get("file")
    if not isinstance(name, str) or not name:
        raise ShopMappingError(f"{where}: its geometry_source needs \"file\": a part file (.step, .stp or .py) next to "
                               "the shop file.")
    path = (Path(item.file).parent / name).resolve()
    if not path.is_file():
        raise ShopMappingError(f"{where}: its geometry file {name!r} isn't there ({path}).")
    return load_part(path, alias=path.stem)


def _bodies(instance, instances, body, where):
    """[(path, body id, solid)] for the selected body of a part (all bodies when body is None and there's one), its
    bodies named as the part file names them (`bodies = {...}`) or solid_1, solid_2, ..."""
    if instances:
        raise ShopMappingError(f"{where}: instances= selects inside an assembly; a part file's bodies are named with body=.")
    found = instance.bodies()
    chosen = [("part", k, v) for k, v in found.items() if body is None or k == body]
    if body is None and len(chosen) > 1:
        raise ShopMappingError(f"{where} has several bodies ({', '.join(found)}); name one with body=.")
    if not chosen:
        raise ShopMappingError(f"{where}: no body {body!r}. Bodies: {', '.join(sorted(found)) or 'none'}.")
    return chosen


def _prism(shape, frame, body_id, revision, role, enclose, source, where):
    """One CAD solid (its own coordinates) placed in work coordinates by `frame`, as camlib's Prism (export_fixture):
    a proven vertical prism, or with `enclose` its outer box when it isn't one."""
    from camlib.cadquery import export_fixture
    if not _ID.fullmatch(body_id):
        raise ShopMappingError(f"{where}: {body_id!r} isn't a camlib id (letters, digits, _ . - only).")
    try:
        return export_fixture(shape, id=body_id, revision=revision, source=source, role=role, work_frame=_inverse(frame),
                              unsupported="enclose" if enclose else "reject")
    except ValueError as error:
        hint = (" camlib checks fixtures as vertical prisms: model it as one, or pass enclose=True to check its outer "
                "box (more than the body: moves near it may be refused)." if "not a supported solid prism" in str(error)
                else "")
        raise ShopMappingError(f"{where}: {error}.{hint}") from error


def _placed(item, at, rotation_deg, *, role, state, mount, body, instances, id, enclose):
    from .shop import Item
    shop_item = isinstance(item, Item)
    name = item.key if shop_item else item.__dict__.get("alias", item) if hasattr(item, "__dict__") else item
    where = f"{'fixture' if role == 'fixture' else 'protected'}({name!r})"
    placement = _placement(at, rotation_deg, where)
    if shop_item:
        if body is not None or instances:
            raise ShopMappingError(f"{where}: a shop fixture places all its components; body= and instances= select "
                                   "a linked document's body.")
        d = _definition(item, "fixture")
        prefix = id or item.key
        states = [s for s in d.get("states") or [] if state is None or s.get("id") == state]
        milling = [s for s in states if "milling" in (s.get("permitted_processes") or [])]
        if state is None and len(milling) != 1:
            raise ShopMappingError(f"{where}: name its state with state= (milling states: "
                                   f"{', '.join(s.get('id') for s in milling) or 'none'}).")
        if not milling:
            raise ShopMappingError(f"{where}: state {state!r} " + ("doesn't permit milling." if states else
                                   f"isn't one of its states ({', '.join(s.get('id') for s in d.get('states') or [])})."))
        chosen = milling[0]
        frames = d.get("mounting_frames") or {}
        if mount is None and len(frames) != 1:
            raise ShopMappingError(f"{where}: name its mounting frame with mount= ({', '.join(frames) or 'none'}).")
        mount = mount if mount is not None else next(iter(frames))
        if mount not in frames:
            raise ShopMappingError(f"{where}: mounting frame {mount!r} isn't one of its own ({', '.join(frames)}).")
        base = _compose(placement, _frame(frames[mount], f"{where} mounting frame {mount}"))
        out = []
        for component in d.get("components") or []:
            cid, pin = component.get("id"), component.get("geometry_source") or {}
            if component.get("motion", "stationary") != "stationary":
                raise ShopMappingError(f"{where}: component {cid} moves with the spindle; a milling fixture is stationary.")
            placed = (chosen.get("component_frames") or {}).get(cid)
            if placed is None:
                raise ShopMappingError(f"{where}: state {chosen.get('id')} doesn't place component {cid}; a fixture state "
                                       "places every component (component_frames).")
            frame = _compose(base, _frame(placed, f"{where} component {cid}"))
            instance = _pinned(item, pin, f"{where} component {cid}")
            (_, body_id, shape), = _bodies(instance, (), pin.get("body"), f"{where} component {cid}")
            out.append(_prism(shape, frame, f"{prefix}_{cid}", f"{pin.get('file')}@{instance.source['revision']}", role,
                              enclose, dict(shop_item=item.key, component=cid, state=chosen.get("id"), mount=mount,
                                            file=str(pin.get("file")), revision=instance.source["revision"],
                                            body=body_id), f"{where} component {cid}"))
        if not out:
            raise ShopMappingError(f"{where} has no components.")
        return tuple(out)
    if state is not None or mount is not None:
        raise ShopMappingError(f"{where}: state= and mount= are a shop fixture's; a linked document is placed as is.")
    instance = _instance(item)
    if not hasattr(instance, "result"):
        raise ShopMappingError(f"{where}: place a shop fixture (shop.<key>) or a linked part or design, not {item!r}.")
    source = getattr(instance, "source", None) or {}
    prefix = id or getattr(instance, "alias", None) or "body"
    out = []
    chosen = _bodies(instance, tuple(instances), body, where)
    for name, body_id, shape in chosen:
        out.append(_prism(shape, placement, prefix if len(chosen) == 1 else f"{prefix}_{body_id}",
                          f"{source.get('document_id')}@{source.get('revision')}", role, enclose,
                          dict(document_id=str(source.get("document_id")), revision=source.get("revision"),
                               instance=name, body=body_id), where))
    return tuple(out)


def fixture(item, at, rotation_deg=0, *, state=None, mount=None, body=None, instances=(), id=None, enclose=False):
    """Workholding placed in the setup's work coordinates, as camlib Prism bodies (role "fixture") for machine(...,
    fixtures=...): every move of the posted program is checked against them (camlib's FixtureContact).

    `item` is a shop fixture (shop.<key>, library kind fixture: its components in the milling `state` — name it when
    there are several — on its mounting frame `mount`) or a linked part or design (`body=`, `instances=` select one
    body). `at` is where the fixture's mounting frame (a linked document's origin) sits in work coordinates: (x, y, z),
    turned `rotation_deg` about Z, or a camlib WorkFrame. Each body is exported by camlib's CadQuery adapter
    (`export_fixture`): a proven vertical prism; another shape is refused unless `enclose=True` checks its outer box.
    A fixture's design must be in this build: the shop (or the program) links it at the revision the fixture pins."""
    return _placed(item, at, rotation_deg, role="fixture", state=state, mount=mount, body=body, instances=instances,
                   id=id, enclose=enclose)


def protected(item, at, rotation_deg=0, *, body=None, instances=(), id=None, enclose=False):
    """Another part on the table that no move may touch (camlib role "protected_target"), placed like fixture(): a
    linked part or design (or a shop fixture's components) at `at` in work coordinates."""
    return _placed(item, at, rotation_deg, role="protected_target", state=None, mount=None, body=body,
                   instances=instances, id=id, enclose=enclose)


def _scene_bodies(fixtures):
    """machine(fixtures=...) as camlib Prisms: fixture()/protected() results, camlib Prisms, or lists of them."""
    from camlib.verification import Prism
    out = []
    pending = [fixtures] if not isinstance(fixtures, (list, tuple)) else list(fixtures)
    while pending:
        value = pending.pop(0)
        if isinstance(value, (list, tuple)):
            pending[:0] = list(value)
        elif isinstance(value, Prism):
            out.append(value)
        else:
            raise ShopMappingError(f"machine(fixtures=...) takes fixture(...)/protected(...) results or camlib Prisms, "
                                   f"not {type(value).__name__}.")
    ids = [p.id for p in out]
    if len(set(ids)) != len(ids):
        raise ShopMappingError(f"machine(fixtures=...) names a body twice ({sorted({i for i in ids if ids.count(i) > 1})}); "
                               "give each placement its own id=.")
    return out


# ---------------------------------------------------------------------------------------------------------- machines

@dataclass(frozen=True)
class Post:
    """A camlib controller post: its module (camlib's examples/<name>_post.py, from CAMLIB_POSTS: post_module), the
    dialects it serves, and how a machine is defined and posted with it."""
    name: str
    module: str | None              # None: camlib's own GCodePost with GCodeDialect.linuxcnc()
    dialects: frozenset
    post: str
    decoder: str
    implicit: bool = True           # chosen for its dialect without naming it (one post per dialect)
    linear_default: bool = False    # the example's post_* writes curves as lines unless told otherwise
    reference: str = ""
    process: str = "milling"        # milling, plasma, laser or turning: what its machines do
    single_tool: bool = False       # its define_machine takes the one tool's ToolSetting, not a tuple
    beam_s_max: float | None = None # the S its beam is fully on at, fixed by the post (None: the program states it)
    fixed: tuple = ()               # (key, value) its define_machine sets itself: the shop must agree, nobody passes them
    owns: tuple = ()                # what the controller does itself, never the program: "heights" (Z, pierce and
                                    # cut height), "pierce_delay", "height_control" (THC), per the post's docs


POSTS = {p.name: p for p in (
    Post("linuxcnc", None, frozenset({"linuxcnc_cartesian_linear_v1"}), "GCodePost", "NativeGCodeDecoder",
         reference="camlib GCodeDialect.linuxcnc(): LinuxCNC 2.9 (camlib docs/posts.md)"),
    Post("centroid_cnc12", "camlib_posts.centroid_post", frozenset({"centroid_milling_v1"}), "CentroidPost",
         "CentroidDecoder", linear_default=True, reference="camlib examples/centroid_post.py (docs/centroid-post.md)"),
    Post("siemens_808d", "camlib_posts.siemens808d_post", frozenset({"siemens_808d_milling_v1"}), "Siemens808DPost",
         "Siemens808DDecoder", linear_default=True, reference="camlib examples/siemens808d_post.py"),
    Post("siemens_808d_iso", "camlib_posts.siemens808d_iso_post", frozenset({"siemens_808d_iso_milling_v1"}),
         "Siemens808DISOPost", "Siemens808DISODecoder", linear_default=True,
         reference="camlib examples/siemens808d_iso_post.py"),
    # Declared ISO controls (iso_declared_milling_v1) name their post: one dialect, several controllers.
    Post("haas_ngc", "camlib_posts.haas_ngc_post", frozenset({"iso_declared_milling_v1"}), "HaasNGCPost", "HaasNGCDecoder",
         implicit=False, linear_default=True, reference="camlib examples/haas_ngc_post.py (Haas 96-8210 RevN)"),
    Post("fanuc_0i_mb", "camlib_posts.fanuc_0imb_post", frozenset({"iso_declared_milling_v1"}), "Fanuc0iMBPost",
         "Fanuc0iMBDecoder", implicit=False, linear_default=True, reference="camlib examples/fanuc_0imb_post.py"),
    # Thermal cutting (ThermalCut): one torch or laser head; the controller dialects are camlib-only
    # (manufacturing/dialects/camlib_only.py). Plasma posts fire the torch at S1 (beam_s_max 1: full power).
    Post("qtplasmac", "camlib_posts.qtplasmac_post", frozenset({"linuxcnc_qtplasmac_v1"}), "QtPlasmaCPost",
         "QtPlasmaCDecoder", linear_default=True, process="plasma", single_tool=True, beam_s_max=1,
         owns=("heights", "pierce_delay"), fixed=(("flood", False), ("mist", False), ("tool_change_position_mode", "preserve_tip")),
         reference="camlib examples/qtplasmac_post.py (docs/qtplasmac-post.md)"),
    Post("centroid_plasma", "camlib_posts.centroid_plasma_post", frozenset({"centroid_plasma_v1"}), "CentroidPlasmaPost",
         "CentroidPlasmaDecoder", linear_default=True, process="plasma", single_tool=True, beam_s_max=1,
         owns=("heights", "pierce_delay", "height_control"),
         fixed=(("flood", False), ("mist", False), ("planes", ("xy",)), ("tool_change_position_mode", "preserve_tip")),
         reference="camlib examples/centroid_plasma_post.py (docs/centroid-plasma-post.md)"),
    Post("wincnc_plasma", "camlib_posts.wincnc_plasma_post", frozenset({"wincnc_plasma_v1"}), "WinCNCPlasmaPost",
         "WinCNCPlasmaDecoder", linear_default=True, process="plasma", single_tool=True, beam_s_max=1,
         owns=("heights", "pierce_delay", "height_control"),
         fixed=(("flood", False), ("mist", False), ("planes", ("xy",)), ("max_sweep_rad", math.pi), ("tool_change_position_mode", "preserve_tip")),
         reference="camlib examples/wincnc_plasma_post.py (docs/wincnc-plasma-post.md)"),
    Post("grbl_laser", "camlib_posts.grbl_post", frozenset({"grbl_laser_v1"}), "GrblPost", "GrblDecoder",
         linear_default=True, process="laser", single_tool=True,
         fixed=(("planes", ("xy",)), ("arcs", False), ("helices", False), ("max_sweep_rad", math.tau),
                ("tool_changes", False), ("max_tool_number", 255), ("max_length_register", 1), ("tool_change_position_mode", "preserve_tip")),
         reference="camlib examples/grbl_post.py (GRBL 1.1h, laser mode $32=1, beam_s_max = $30)"),
    # Lathes: XZ arcs, diameter X words, T<station><offset>. Both posts' machines change tools "table" (each tool's
    # place after its change is declared: the setup's start position, where the turret indexes) and write G18 only.
    Post("fanuc_lathe", "camlib_posts.fanuc_lathe_post", frozenset({"fanuc_lathe_system_a_v1"}), "FanucLathePost",
         "FanucLatheDecoder", process="turning", fixed=(("tool_change_position_mode", "table"), ("planes", ("xz",))),
         reference="camlib examples/fanuc_lathe_post.py (docs/fanuc-lathe-post.md)"),
    Post("centroid_lathe", "camlib_posts.centroid_lathe_post", frozenset({"centroid_lathe_v1"}), "CentroidLathePost",
         "CentroidLatheDecoder", process="turning", fixed=(("tool_change_position_mode", "table"), ("planes", ("xz",))),
         reference="camlib examples/centroid_lathe_post.py (docs/centroid-lathe-post.md)"),
)}
BEAM_PROCESSES = ("plasma", "laser")


@dataclass(frozen=True)
class Target:
    """One machine a setup is posted for: the camlib Machine, its post and decoder, the curve lowering, and the shop
    keys it came from (the G-code artifact is named <setup>-<machine key>.nc). `data` is the same machine as plain data
    (the post by name, the declared values, the tool table, the scene): what the build's second stage rebuilds it from.
    `scene`: the machine's gauge-line travel in machine coordinates (`travel_mm`, from the shop) and the bodies placed on
    it (`bodies`, camlib Prism dicts in work coordinates)."""
    key: str
    controller: str
    post: str
    machine: object
    post_class: object
    decoder_class: object
    lowering: object = None
    derived: dict = field(default_factory=dict)
    data: dict = field(default_factory=dict)
    scene: dict = field(default_factory=dict)


def camlib_version():
    """The installed camlib's version, or None when it isn't installed as a package. camlib is published as
    `cam-engine` (PyPI's `camlib` is another project) and was installed as `camlib` before that."""
    from importlib.metadata import PackageNotFoundError, version
    for name in ("cam-engine", "camlib"):
        try:
            return version(name)
        except PackageNotFoundError:
            continue
    return None


def posts_directory():
    """Where camlib's controller posts are: $CAMLIB_POSTS, a directory holding camlib's examples/*_post.py (camlib ships
    them as examples, not in its package; a camlib checkout's examples/ directory), or None."""
    import os
    from pathlib import Path
    value = os.environ.get("CAMLIB_POSTS")
    return Path(value).expanduser() if value else None


def post_module(name):
    """A controller post's module ("camlib_posts.<file>") loaded from posts_directory(), once."""
    import sys
    if name in sys.modules:
        return sys.modules[name]
    directory = posts_directory()
    file = name.rpartition(".")[2] + ".py"
    if directory is None or not (directory / file).is_file():
        raise ShopMappingError(f"The {file} post isn't available: set CAMLIB_POSTS to a directory holding camlib's "
                               "controller posts (a camlib checkout's examples/ directory). Only the linuxcnc post is "
                               "built into camlib.")
    spec = importlib.util.spec_from_file_location(name, directory / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[name]
        raise
    return module


def build_machine(post, name, settings, values):
    """(camlib Machine, post class, decoder class) for a post of POSTS by name, from the configured posts only."""
    from camlib.post import GCodeDialect, Machine
    import camlib.post as camlib_post
    chosen = POSTS[post]
    if chosen.module is None:
        return (Machine(name, tuple(settings), dialect=GCodeDialect.linuxcnc(), **values),
                getattr(camlib_post, chosen.post), getattr(camlib_post, chosen.decoder))
    module = post_module(chosen.module)
    if chosen.single_tool:
        if len(settings) != 1:
            raise ValueError(f"post {chosen.name} takes one tool (its machine has one torch or head); the setup has "
                             f"{len(settings)}.")
        return (module.define_machine(name, settings[0], **values), getattr(module, chosen.post),
                getattr(module, chosen.decoder))
    return (module.define_machine(name, tuple(settings), **values), getattr(module, chosen.post),
            getattr(module, chosen.decoder))


# ---------------------------------------------------------------------------------------------------------- as data
# A machine's declared values cross from the program's stage to the build's as JSON: plain values, tuples (as lists:
# camlib's machines take tuples) and these camlib value types only (a machine's crash_model is a camlib.machine
# MachineModel). Anything else (a post object, a callable) is refused.

def _value_types():
    from camlib import machine as crash
    from camlib.dynamics import MotionPolicy
    from camlib.motion import WorkFrame
    from camlib.post import LoweringOptions
    from camlib.verification import StockContactOptions
    return {"WorkFrame": WorkFrame, "LoweringOptions": LoweringOptions, "MotionPolicy": MotionPolicy,
            "StockContactOptions": StockContactOptions,
            **{kind.__name__: kind for kind in (crash.MachineModel, crash.Axis, crash.Box, crash.ConvexMesh,
                                                crash.MachineBody, crash.ToolCalibration, crash.AllowedContact,
                                                crash.ToolChangeRoute, crash.MachineCheckOptions)}}


def encode(value, where="value"):
    """A declared machine value as JSON data (see decode)."""
    import dataclasses
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ShopMappingError(f"{where} must be a finite number.")
        return value
    if isinstance(value, (list, tuple)):
        return [encode(v, where) for v in value]
    if isinstance(value, dict):
        if not all(isinstance(k, str) for k in value):
            raise ShopMappingError(f"{where}: keys must be text.")
        return {"$dict": {k: encode(v, f"{where}.{k}") for k, v in value.items()}}
    name = type(value).__name__
    if name in _value_types() and isinstance(value, _value_types()[name]) and dataclasses.is_dataclass(value):
        return {"$type": name, "fields": {f.name: encode(getattr(value, f.name), f"{where}.{f.name}")
                                          for f in dataclasses.fields(value) if f.init}}
    raise ShopMappingError(f"{where} is a {name}: a machine takes numbers, text, lists and camlib's "
                           f"{', '.join(sorted(_value_types()))} only.")


def decode(value, depth=0):
    """encode's inverse: lists become tuples, {"$dict": …} dicts, {"$type": name, "fields": …} the named camlib type."""
    if depth > 16:
        raise ValueError("machine value nests too deep")
    if value is None or isinstance(value, (bool, str, int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("machine values must be finite")
        if isinstance(value, str) and len(value) > 2000:
            raise ValueError("machine text value too long")
        return value
    if isinstance(value, list):
        if len(value) > 200_000:
            raise ValueError("machine list value too long")
        return tuple(decode(v, depth + 1) for v in value)
    if isinstance(value, dict) and set(value) == {"$dict"} and isinstance(value["$dict"], dict):
        return {str(k): decode(v, depth + 1) for k, v in value["$dict"].items()}
    if isinstance(value, dict) and set(value) == {"$type", "fields"} and isinstance(value["fields"], dict):
        kind = _value_types().get(value["$type"])
        if kind is None:
            raise ValueError(f"machine value type {value['$type']!r} isn't allowed")
        return kind(**{str(k): decode(v, depth + 1) for k, v in value["fields"].items()})
    raise ValueError("machine value isn't plain data")


def _axes(model):
    nodes = {n.get("id"): n for n in model.get("nodes") or []}
    out = {}
    for axis in ("X", "Y", "Z"):
        limits = (nodes.get(axis) or {}).get("limits")
        if not limits or limits.get("unit") != "mm" or nodes[axis].get("kind") != "linear":
            raise ShopMappingError(f"Machine model has no linear {axis} axis in mm: camlib programs are 3-axis.")
        out[axis] = limits
    return out


IDENTITY_AXES = {"X": (1.0, 0.0, 0.0), "Y": (0.0, 1.0, 0.0), "Z": (0.0, 0.0, 1.0)}


def _identity(frame):
    if frame is None:
        return True
    origin, axes = _frame(frame, "frame")
    return all(abs(v) < 1e-12 for v in origin) and all(abs(a - (i == j)) < 1e-12 for i, axis in enumerate(axes)
                                                         for j, a in enumerate(axis))


def _travel(model, key, axes, carrier=None):
    """The spindle's gauge-line travel in machine coordinates, [(min x, y, z), (max x, y, z)], from the model's X, Y and
    Z limits (after the instance's joint_overrides). Machine coordinates are the joints' own: exact for a Cartesian mill
    whose X, Y and Z move the spindle along +X, +Y and +Z on identity frames, with the work on the fixed frame
    (MachineModel.mill); any other arrangement is refused rather than mapped approximately."""
    nodes = {n.get("id"): n for n in model.get("nodes") or []}
    low, high = [], []
    for axis in "XYZ":
        limits = axes[axis]
        for bound in ("minimum", "maximum"):
            value = limits.get(bound)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ShopMappingError(f"Machine model {key} has no {axis} travel: add nodes[{axis}].limits.{bound} (mm, "
                                       "machine coordinates) to the shop's machine model; camlib checks every move "
                                       "against the machine's travel and never assumes one.")
        if not limits["minimum"] < limits["maximum"]:
            raise ShopMappingError(f"Machine model {key}: {axis} travel {limits['minimum']}..{limits['maximum']} mm is empty.")
        low.append(float(limits["minimum"]))
        high.append(float(limits["maximum"]))
    spindle = next((s for s in model.get("spindles") or [] if s.get("role", "cutting") == "cutting"), {})
    attachments = {a.get("id"): a for a in model.get("attachments") or []}
    tool_side = attachments.get(carrier or spindle.get("attachment"))   # the spindle's, or a cutting head's
    chain, node = [], (tool_side or {}).get("node")
    while node is not None and node in nodes and node not in chain and len(chain) < 64:
        chain.append(node)
        node = nodes[node].get("parent")
    moving = [n for n in chain if nodes[n].get("kind") != "fixed"]
    work = [a for a in attachments.values() if a.get("role") == "workpiece"]
    problem = None
    if tool_side is None or sorted(moving) != ["X", "Y", "Z"]:
        problem = "its spindle or cutting head isn't carried by exactly the X, Y and Z joints"
    elif any(tuple(float(v) for v in nodes[a].get("axis") or ()) != IDENTITY_AXES[a] for a in "XYZ"):
        problem = "its X, Y and Z joints don't move along +X, +Y and +Z"
    elif not all(_identity(nodes[n].get("frame")) for n in chain) or not _identity(tool_side.get("frame")):
        problem = "the frames between its base and its spindle aren't the identity"
    else:
        for attachment in work:
            node, seen = attachment.get("node"), 0
            while node is not None and node in nodes and seen < 64:
                if nodes[node].get("kind") != "fixed":
                    problem = "its work table moves with a joint"
                node, seen = nodes[node].get("parent"), seen + 1
    if problem:
        raise ShopMappingError(f"Machine model {key}: {problem}, so its travel can't be mapped to camlib's machine "
                               "coordinates exactly. camlib programs map Cartesian mills as MachineModel.mill models them.")
    return [low, high]


def _decimals(resolution):
    if resolution is None:
        return None
    exponent = -math.log10(float(resolution))
    if abs(exponent - round(exponent)) > 1e-9:
        raise ShopMappingError(f"linear_resolution_mm {resolution} isn't a power of ten.")
    return int(round(exponent))


LOWERED_LIMITS = ("max_feed_mm_min", "max_spindle_rpm", "rapid_mm_min")   # a program may lower these, never raise them


def _choose_post(controller, post):
    """The camlib post of a shop controller: the one its dialect has, or the one named (a dialect several posts serve)."""
    c = _definition(controller, "controller")
    dialect = c.get("dialect")
    candidates = [p for p in POSTS.values() if dialect in p.dialects]
    if post is not None:
        chosen = POSTS.get(post)
        if chosen is None or dialect not in chosen.dialects:
            names = ", ".join(p.name for p in candidates) or "none"
            raise ShopMappingError(f"Post {post!r} doesn't serve controller {controller.key} (dialect {dialect}); "
                                   f"its posts: {names}.")
    else:
        implicit = [p for p in candidates if p.implicit]
        if len(implicit) != 1:
            names = ", ".join(p.name for p in candidates)
            raise ShopMappingError(f"Controller {controller.key} (dialect {dialect}) has "
                                   + (f"several camlib posts ({names}): name one with post=." if candidates else
                                      "no camlib post. Posts: " + ", ".join(f"{p.name} ({', '.join(sorted(p.dialects))})"
                                                                            for p in POSTS.values()) + "."))
        chosen = implicit[0]
    if chosen.process not in (c.get("processes") or ["milling"]):
        raise ShopMappingError(f"Controller {controller.key} doesn't declare the {chosen.process} process its post "
                               f"{chosen.name} is for: add it to the controller's processes.")
    return chosen


def _merge(item, chosen, derived, premises):
    """The machine's values: what the shop gives (`derived`) with what the program states (`premises`). A value the post
    sets itself is nobody's to pass; a program may lower the shop's limits, never raise or contradict them."""
    derived = {k: v for k, v in derived.items() if v is not None}
    for key, value in chosen.fixed:
        if key in premises:
            raise ShopMappingError(f"Post {chosen.name} sets {key} itself ({value!r}): leave it out of machine(...).")
        if key in derived:
            if derived[key] != value:
                raise ShopMappingError(f"Machine {item.key}: the shop gives {key}={derived[key]!r}, but post {chosen.name}'s "
                                       f"machine has {key}={value!r} ({chosen.reference}); change the shop.")
            del derived[key]
    for key, value in premises.items():
        if key in derived:
            if key in LOWERED_LIMITS and isinstance(value, (int, float)) and value <= derived[key]:
                derived[key] = value
                continue
            if value != derived[key]:
                raise ShopMappingError(f"{key}={value!r} disagrees with the shop ({derived[key]!r}); change the shop, "
                                       + ("or give a lower value." if key in LOWERED_LIMITS else "not the program."))
    return derived, {k: v for k, v in premises.items() if k not in derived}


def _lathe_machine(item, setup, post, *, tooling, work_to_machine, fixtures, lowering, position_after_mm,
                   diameter_register, premises):
    """machine() for a lathe (its docstring): the shop's lathe as a camlib Machine for a lathe setup, with its post."""
    import camlib
    from camlib.motion import WorkFrame
    from camlib.post import ToolSetting
    d = _definition(item, "machine_instance")
    model, controller = d.get("model"), d.get("controller")
    m, c = _definition(model, "machine_model"), _definition(controller, "controller")
    chosen = _choose_post(controller, post)
    where = f"Machine {item.key} (post {chosen.name})"
    if getattr(setup, "turning", None) is None:
        raise ShopMappingError(f"{where} is a lathe: its setup is a lathe setup, Setup(stock=TurnStockSpec(...), "
                               "tools=(station(shop.<turret>, tool), ...), operations=(Turn...), turning=TurningSetup(...)).")
    if "turning" not in (m.get("processes") or []):
        raise ShopMappingError(f"{where}: machine model {model.key} isn't a lathe (MachineModel.lathe).")
    for name, value, why in (("tooling", tooling, "each tool's station and offset are the setup's (station(shop.<turret>, tool))"),
                             ("fixtures", fixtures or None, "a lathe setup's workholding is its chuck face "
                                                            "(TurningSetup(chuck_z_mm=...)), which every move is checked against"),
                             ("diameter_register", diameter_register, "a turret offset holds the nose radius"),
                             ("position_after_mm", position_after_mm, "a turret indexes at the setup's start position")):
        if value is not None:
            raise ShopMappingError(f"{where}: give no {name}= ({why}).")
    nodes = {n.get("id"): n for n in m.get("nodes") or []}
    rates = []
    for axis in "XZ":
        limits = (nodes.get(axis) or {}).get("limits") or {}
        rate = limits.get("max_velocity_per_minute")
        if nodes.get(axis, {}).get("kind") != "linear" or limits.get("unit") != "mm" or not isinstance(rate, (int, float)):
            raise ShopMappingError(f"Machine model {model.key} has no linear {axis} axis in mm with its rate "
                                   f"(nodes[{axis}].limits.max_velocity_per_minute).")
        rates.append(float(rate))
    spindles = [s for s in m.get("spindles") or [] if s.get("role") == "work"]
    if len(spindles) != 1 or not isinstance(spindles[0].get("max_rpm"), (int, float)):
        raise ShopMappingError(f"Machine model {model.key} needs its one work spindle with max_rpm.")
    stations = len((m.get("tool_change") or {}).get("stations") or [])
    derived = dict(output_units=c.get("output_units"), max_spindle_rpm=float(spindles[0]["max_rpm"]),
                   max_feed_mm_min=min(rates), rapid_mm_min=min(rates), tool_changes=stations > 0,
                   decimals=_decimals(c.get("linear_resolution_mm")))
    if work_to_machine is not None:
        if isinstance(work_to_machine, (list, tuple)):
            work_to_machine = WorkFrame(tuple(work_to_machine))
        if not isinstance(work_to_machine, WorkFrame):
            raise ShopMappingError("work_to_machine is a camlib WorkFrame (camlib.motion) or (x, y, z).")
        _frame(work_to_machine, "work_to_machine")
        premises = {**premises, "work_to_machine": work_to_machine}
    derived, premises = _merge(item, chosen, derived, premises)
    # camlib's lathe run posts stand-in tool assemblies (id and gauge length for the program header); each one's T
    # station and offset are its TurnToolSetting's, and its change leaves it at the setup's start (the turret pose).
    header = camlib.Job("header", "1", (setup,)).compile().setup(setup.id).program_header()
    numbers = {s.tool.id: s for s in setup.tools}
    settings = []
    for proxy in header.tools:
        s = numbers[proxy.id]
        if stations and not 1 <= s.number <= stations:
            raise ShopMappingError(f"{where}: tool {proxy.id} is in station {s.number}; model {model.key}'s turret has "
                                   f"{stations}.")
        settings.append(ToolSetting.for_tool(proxy, number=s.number, length_register=s.offset,
                                             position_after_mm=tuple(header.initial_position_mm)))
    name = str(d.get("name") or item.key)[:128]
    values = {**derived, **premises}
    try:
        built, post_class, decoder_class = build_machine(chosen.name, name, settings, values)
    except TypeError as error:
        raise ShopMappingError(f"{where}: {error}. The shop gives {', '.join(sorted(derived))}; give the rest to "
                               f"machine(...) ({chosen.reference}).") from error
    data = dict(key=item.key, controller=controller.key, post=chosen.name, name=name,
                values={k: encode(v, f"machine({k}=...)") for k, v in values.items()},
                tools=[dict(tool=t.tool, number=t.number, length_register=t.length_register,
                            position_after_mm=list(t.position_after_mm), diameter_register=t.diameter_register)
                       for t in settings],
                lowering=encode(lowering, "lowering"), derived=sorted(derived), scene=dict(travel_mm=None, bodies=[]))
    return Target(item.key, controller.key, chosen.name, built, post_class, decoder_class, lowering, derived, data,
                  data["scene"])


_REQUIRED = object()


def machine(item, setup, *, tooling=None, work_to_machine=_REQUIRED, fixtures=(), post=None, lowering=None,
            position_after_mm=None, diameter_register=None, **premises):
    """A shop Machine (machine_instance: model + controller) as a camlib Machine for `setup`'s tools, with its post, and
    the setup's scene on it for camlib's checks.

    From the shop: the name, the tool table (T numbers and H/D registers from `tooling`, a ToolSetup, with each tool's
    gauge length), output units, decimals (the controller's linear_resolution_mm), the spindle's max rpm, the axes'
    velocity limits (max feed, per-axis feeds and rapid rate, after the machine's joint_overrides), whether tools change,
    the axes' travel (after joint_overrides), and the post (the controller's dialect; a declared ISO controller names it:
    post="haas_ngc" or "fanuc_0i_mb").

    `work_to_machine` (required: the shop doesn't hold it) is where the work coordinates sit in the machine's: the work
    offset's values (e.g. G54 X Y Z) in machine coordinates as the shop's machine model counts them, a camlib WorkFrame
    or (x, y, z). `fixtures` are the fixture(...) and protected(...) bodies the setup has on this machine (or camlib
    Prisms). Every move of the posted program is checked against the travel and them.

    `premises` are everything else camlib's Machine or the post's define_machine requires that the shop does not hold:
    flood, mist, tool_change_position_mode, work_offset, and each controller post's own options; a missing one is refused
    by camlib. `position_after_mm` is where a tool change leaves the tip (tool_change_position_mode "table"). A program
    may lower the shop's feed, spindle and rapid limits, never raise them.

    A plasma or laser machine (a controller whose dialect has a camlib cutting post, a model with a cutting head) takes
    no `tooling`: its one tool is the setup's head(...) and the T number and length register its ThermalCut operations
    give; the head's attachment carries the travel. `diameter_register` is the controller's D register holding the
    head's kerf wear, for ThermalCut(compensation="wear") (G41/G42): stated by the program, never assumed (a milling
    machine's tools take theirs from the tool setup's radius_register).

    A lathe (a controller whose dialect has a camlib lathe post, a MachineModel.lathe) takes a lathe `setup`
    (Setup(stock=TurnStockSpec(...), tools=(station(shop.turret, tool), ...), turning=TurningSetup(...))) and no
    `tooling`: each tool's station and offset are the setup's own (station()). From the shop: the spindle's top speed,
    the X and Z rates, the units and decimals. camlib checks a lathe setup's every move against its part, bore, chuck
    face and stock; the machine's travel and bodies are checked only with a machine crash model (camlib
    docs/machine.md), which the build's result lists as not checked."""
    from camlib.motion import WorkFrame
    from camlib.post import ToolSetting

    process = _choose_post(_definition(item, "machine_instance").get("controller"), post).process
    if process == "turning":
        return _lathe_machine(item, setup, post, tooling=tooling,
                              work_to_machine=None if work_to_machine is _REQUIRED else work_to_machine, fixtures=fixtures,
                              lowering=lowering, position_after_mm=position_after_mm, diameter_register=diameter_register,
                              premises=premises)
    if getattr(setup, "turning", None) is not None:
        raise ShopMappingError(f"Setup {setup.id} is a lathe setup, but machine {item.key}'s controller posts {process}: "
                               "post it for a shop lathe (MachineModel.lathe with a lathe controller, e.g. dialect "
                               "\"fanuc_lathe_system_a_v1\").")
    if work_to_machine is _REQUIRED or work_to_machine is None:
        raise ShopMappingError(f"machine({getattr(item, 'key', item)!r}, ...) needs work_to_machine=: where the work "
                               "zero (the part's origin) sits in the machine's coordinates, i.e. the work offset's X Y Z "
                               "values, as WorkFrame((x, y, z)) (camlib.motion). The shop doesn't hold it and nothing is "
                               "assumed: ask the person where the part is clamped.")
    if isinstance(work_to_machine, (list, tuple)):
        work_to_machine = WorkFrame(tuple(work_to_machine))
    if not isinstance(work_to_machine, WorkFrame):
        raise ShopMappingError("work_to_machine is a camlib WorkFrame (camlib.motion) or (x, y, z).")
    _frame(work_to_machine, "work_to_machine")
    premises["work_to_machine"] = work_to_machine
    bodies = _scene_bodies(fixtures)
    if getattr(getattr(setup, "verification", None), "scene", None) is not None:
        raise ShopMappingError(f"Setup {setup.id} configures its own camlib Scene: its machine's travel and fixtures come "
                               "from machine(..., work_to_machine=..., fixtures=...) instead; leave scene out of "
                               "StreamChecks.")

    d = _definition(item, "machine_instance")
    model, controller = d.get("model"), d.get("controller")
    m = _definition(model, "machine_model")
    c = _definition(controller, "controller")
    chosen = _choose_post(controller, post)
    beam = chosen.process in BEAM_PROCESSES
    head_entry = None
    if beam:
        found = [h for h in m.get("cutting_heads") or [] if any(_head_id(h) == t.id for t in setup.tools)]
        if len(found) != 1:
            raise ShopMappingError(f"Machine {item.key} (post {chosen.name}): the setup's tool must be one of machine "
                                   f"model {model.key}'s cutting heads, made with head(shop.{item.key}, recipe) "
                                   f"(its heads: {', '.join(_head_id(h) for h in m.get('cutting_heads') or []) or 'none'}).")
        head_entry = found[0]
        if head_entry.get("process") != chosen.process:
            raise ShopMappingError(f"Cutting head {_head_id(head_entry)} is a {head_entry.get('process')} head; post "
                                   f"{chosen.name} posts {chosen.process}.")

    axes = _axes(m)
    for override in d.get("joint_overrides") or []:
        joint, limits = override.get("joint"), override.get("limits") or {}
        if joint in axes:
            merged = {**axes[joint], **{k: v for k, v in limits.items() if v is not None}}
            if any(isinstance(merged.get(b), (int, float)) and isinstance(axes[joint].get(b), (int, float))
                   and (merged[b] - axes[joint][b]) * sign > 0 for b, sign in (("minimum", -1), ("maximum", 1))):
                raise ShopMappingError(f"Machine {item.key}: joint_overrides for {joint} extend the model's travel; they "
                                       "may only restrict it.")
            axes[joint] = merged
    travel = _travel(m, model.key, axes, head_entry.get("attachment") if beam else None)
    velocities = tuple(float(axes[a]["max_velocity_per_minute"]) for a in "XYZ")
    changer = (m.get("tool_change") or {}).get("mode")
    if beam:
        # No spindle: camlib's Machine still bounds every S word by max_spindle_rpm. A beam machine's only S is the
        # beam's, at most beam_s_max (fixed by the plasma posts; GRBL's $30, stated by the program), as camlib's own
        # beam-post docs declare it (max_spindle_rpm = 1 with beam_s_max 1).
        s_max = chosen.beam_s_max if chosen.beam_s_max is not None else premises.get("beam_s_max")
        if s_max is None:
            raise ShopMappingError(f"Machine {item.key} (post {chosen.name}) needs beam_s_max=: the S value of full beam "
                                   "power the controller is set to (GRBL's $30).")
        spindle_limit = float(s_max)
    else:
        spindles = [s for s in m.get("spindles") or [] if s.get("role", "cutting") == "cutting"]
        if not spindles:
            raise ShopMappingError(f"Machine model {model.key} has no cutting spindle.")
        spindle_limit = float(spindles[0]["max_rpm"])
    derived = dict(output_units=c.get("output_units"), max_spindle_rpm=spindle_limit,
                   max_feed_mm_min=min(velocities), max_axis_feed_mm_min=velocities, rapid_mm_min=min(velocities),
                   tool_changes=changer not in (None, "none"))
    decimals = _decimals(c.get("linear_resolution_mm"))
    if decimals is not None:
        derived["decimals"] = decimals
    if premises.get("tool_change_position_mode") == "z_home":
        # M6 sends Z home: the gauge line's machine Z there is the model's home pose (MachineModel.mill: the top of Z).
        home = next((p for p in m.get("poses") or [] if p.get("id") == m.get("home_pose")), None)
        z = next((q.get("value") for q in (home or {}).get("positions") or [] if q.get("joint") == "Z"), None)
        if z is not None:
            derived["tool_change_home_z_mm"] = float(z)
    if chosen.name == "grbl_laser":
        # GRBL has no length offsets: its work offset holds the head's length (camlib examples/grbl_post.py). Both its
        # positions follow from the program's work_to_machine, the head's gauge length and the setup's start, exactly.
        frame = _frame(work_to_machine, "work_to_machine")
        if frame[1] != ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)):
            raise ShopMappingError("GRBL's work offset is a translation: give work_to_machine as WorkFrame((x, y, z)).")
        if len(setup.tools) != 1:
            raise ShopMappingError(f"GRBL has one preloaded tool; setup {setup.id} has {len(setup.tools)}.")
        gauge = float(setup.tools[0].gauge_length_mm)
        offset = (frame[0][0], frame[0][1], frame[0][2] + gauge)
        start = tuple(o + p for o, p in zip(offset, setup.initial_position_mm))
        derived.update(work_offset_machine_mm=offset, initial_machine_mm=start)
    derived, premises = _merge(item, chosen, derived, premises)
    offsets = c.get("work_offsets")
    if premises.get("work_offset") is not None and offsets and premises["work_offset"] not in offsets:
        raise ShopMappingError(f"Work offset {premises['work_offset']} isn't one controller {controller.key} offers "
                               f"({offsets}).")

    settings = []
    if beam:
        if tooling is not None:
            raise ShopMappingError(f"Machine {item.key} cuts with its head: give no tooling= (the T number and length "
                                   "register are the ThermalCut operation's).")
        for assembly in setup.tools:
            numbers = {(o.tool_number, o.length_register) for o in _operations(setup) if getattr(o, "tool", None) is assembly
                       or getattr(o, "tool", None) == assembly.id}
            if len(numbers) != 1:
                raise ShopMappingError(f"Head {assembly.id}: its operations give {len(numbers)} different T number / "
                                       "length register pairs; give one (tool_number=, length_register=).")
            (number, register), = numbers
            wear = [o.id for o in _operations(setup) if getattr(o, "compensation", None) == "wear"
                    and (getattr(o, "tool", None) is assembly or getattr(o, "tool", None) == assembly.id)]
            if wear and diameter_register is None:
                raise ShopMappingError(f"ThermalCut {wear[0]!r} has compensation=\"wear\": pass machine(..., "
                                       "diameter_register=<n>), the controller's D register that holds the head's kerf "
                                       "wear (G41/G42 D<n>).")
            after = position_after_mm if position_after_mm is not None else setup.initial_position_mm
            settings.append(ToolSetting.for_tool(assembly, number=number, length_register=register,
                                                 position_after_mm=tuple(after), diameter_register=diameter_register))
    elif tooling is None:
        raise ShopMappingError(f"machine({item.key!r}, ...) needs tooling=: the shop's tool setup (shop.<key>) giving "
                               "each tool's T number and registers.")
    if not beam and diameter_register is not None:
        raise ShopMappingError(f"Machine {item.key} holds tools: each tool's D register comes from the tool setup "
                               "(offsets.radius_register), not machine(diameter_register=...).")
    for assembly in () if beam else setup.tools:
        a = _assignment(tooling, assembly)
        numbers = slot(tooling, assembly)
        radius = (a.get("offsets") or {}).get("radius_register")
        after = position_after_mm if position_after_mm is not None else setup.initial_position_mm
        if isinstance(after, dict):
            after = after[assembly.id]
        settings.append(ToolSetting.for_tool(assembly, number=numbers["tool_number"],
                                             length_register=numbers["length_register"],
                                             position_after_mm=tuple(after), diameter_register=radius))
    name = str(d.get("name") or item.key)[:128]
    values = {**derived, **premises}
    try:
        built, post_class, decoder_class = build_machine(chosen.name, name, settings, values)
    except TypeError as error:
        raise ShopMappingError(f"Machine {item.key} with post {chosen.name}: {error}. The shop gives "
                               f"{', '.join(sorted(derived))}; give the rest to machine(...) "
                               f"({chosen.reference}).") from error
    if lowering is None and chosen.linear_default and getattr(built, "curve_policy", "linear") == "linear":
        from camlib.post import LoweringOptions
        lowering = LoweringOptions()   # As the post's own post_* function does for a linear curve policy.
    data = dict(key=item.key, controller=controller.key, post=chosen.name, name=name,
                values={k: encode(v, f"machine({k}=...)") for k, v in values.items()},
                tools=[dict(tool=t.tool, number=t.number, length_register=t.length_register,
                            position_after_mm=list(t.position_after_mm), diameter_register=t.diameter_register)
                       for t in settings],
                lowering=encode(lowering, "lowering"), derived=sorted(derived),
                scene=dict(travel_mm=travel, bodies=[b.to_dict() for b in bodies]))
    return Target(item.key, controller.key, chosen.name, built, post_class, decoder_class, lowering, derived, data,
                  data["scene"])


# ---------------------------------------------------------------------------------------------------------- program

@dataclass(frozen=True)
class Program:
    """What a camlib program's program.py makes as `program`: the camlib Job, the machine(s) each setup is posted for (one
    Target for every setup, a list, or {setup id: Target or [Targets]}), and the finding kinds accepted on purpose
    (camlib's `accept`, camlib.export.ACCEPTABLE: "uncertain", "violation", "unchecked_machine"; empty by default, so
    any finding refuses the G-code)."""
    job: object
    machines: object
    accept: frozenset = frozenset()
    # Drawings the build hands out beside its G-code: {"remnant.dxf": text} (camlib.dxf.write_regions's text). They
    # are the program's own; camlib-ui serves them as they are.
    outputs: dict = field(default_factory=dict)

    def __post_init__(self):
        from camlib.export import accepted
        from camlib.jobs import Job
        if not isinstance(self.job, Job):
            raise TypeError("Program(job, machines): job must be a camlib Job.")
        object.__setattr__(self, "accept", accepted(self.accept))

    def targets(self, setup_id):
        value = self.machines
        if isinstance(value, dict):
            if setup_id not in value:
                raise ValueError(f"Program.machines names no machine for setup {setup_id!r}.")
            value = value[setup_id]
        value = list(value) if isinstance(value, (list, tuple)) else [value]
        if not value or not all(isinstance(v, Target) for v in value):
            raise TypeError("Program.machines takes machine(...) results.")
        keys = [v.key for v in value]
        if len(set(keys)) != len(keys):
            raise ValueError(f"Setup {setup_id!r} lists machine {keys} more than once.")
        return value


def export_program(program):
    """The program as plain data, all the build's second stage takes from it (docs/programs.md, "Two stages"): the
    compiled Job (camlib's own compiled setup configurations: stock, tools, operations with their regions and surfaces,
    checks), each setup's machines as data, and the accepted finding kinds."""
    import json
    compiled = program.job.compile()
    setups = []
    for setup in compiled.setups:
        frame = setup.frame
        setups.append(dict(id=setup.id, config=json.loads(setup._config_json),
                           frame={k: list(getattr(frame, k)) for k in ("origin_mm", "x", "y", "z")},
                           dependencies=[list(item) for item in setup._dependencies],
                           provenance=json.loads(setup._provenance_json)))
    targets = {setup.id: [t.data for t in program.targets(setup.id)] for setup in compiled.setups}
    if not all(t for ts in targets.values() for t in ts):
        raise ValueError("Program.machines must be machine(...) results.")
    return dict(version=1, job=dict(id=compiled.id, revision=compiled.revision, setups=setups), targets=targets,
                accept=sorted(program.accept), outputs=dict(program.outputs))
