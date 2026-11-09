"""Part files: the geometry a program machines (`from links import part`) and fixture bodies.

A part is a file in the project:

- ``part.step`` / ``part.stp``: a STEP file, read with CadQuery;
- ``part.py``: a CadQuery script that sets ``result`` (a Workplane, Shape or Assembly). It may also name geometry:
  ``faces = {"pocket_floor": <Face or Workplane selection>}``, ``edges = {...}`` and ``bodies = {"jaw": <solid>}``.

Faces and edges are named ``face<N>`` and ``edge<N>`` (1-based, in the shape's own order: stable for a given file), or by
the names the script gives. The viewer shows each face's name when it is picked. Lengths are millimetres; the part's
coordinates are the work coordinates.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

PART_SUFFIXES = (".step", ".stp", ".py")
INDEXED = re.compile(r"(face|edge)(\d+)\Z")


class PartError(ValueError):
    """A part file that can't be read, or a name that selects nothing."""


def find_part(directory: Path) -> Path | None:
    """The project's part file: part.step, part.stp or part.py."""
    for suffix in PART_SUFFIXES:
        path = directory / f"part{suffix}"
        if path.is_file():
            return path
    return None


def _shape(value):
    """A CadQuery Shape from a script's result (Workplane, Shape or Assembly)."""
    import cadquery as cq
    if isinstance(value, cq.Workplane):
        shapes = [v for v in value.vals() if isinstance(v, cq.Shape)]
        value = shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes) if shapes else None
    if isinstance(value, cq.Assembly):
        value = value.toCompound()
    if not isinstance(value, cq.Shape):
        raise PartError(f"A part's result must be a CadQuery Workplane, Shape or Assembly, not {type(value).__name__}.")
    return value


def _shapes(value, kind):
    """A named selection as a list of Faces or Edges (a Shape, a list of them or a Workplane selection)."""
    import cadquery as cq
    if isinstance(value, cq.Workplane):
        value = value.vals()
    values = list(value) if isinstance(value, (list, tuple)) else [value]
    wanted = cq.Face if kind == "face" else cq.Edge
    if not values or not all(isinstance(v, wanted) for v in values):
        raise PartError(f"Named {kind}s must be CadQuery {wanted.__name__}s.")
    return values


class Part:
    """A part file as camlib-ui's program helpers use it (camlib_ui.program: solid, face, region, ...)."""

    def __init__(self, path: Path, alias: str = "part"):
        self.path = Path(path)
        self.alias = alias
        data = self.path.read_bytes()
        self.source = {"document": alias, "file": self.path.name, "revision": hashlib.sha256(data).hexdigest()[:12]}
        self._result = None
        self._names = {"face": {}, "edge": {}}
        self._bodies = None

    def _load(self):
        if self._result is not None:
            return
        import cadquery as cq
        suffix = self.path.suffix.lower()
        if suffix in (".step", ".stp"):
            self._result = _shape(cq.importers.importStep(str(self.path)))
            return
        if suffix != ".py":
            raise PartError(f"{self.path.name}: a part is a .step, .stp or .py (CadQuery) file.")
        namespace = {"__name__": "__part__", "__file__": str(self.path)}
        exec(compile(self.path.read_text(), str(self.path), "exec"), namespace)
        if "result" not in namespace:
            raise PartError(f"{self.path.name} must set `result` (its CadQuery Workplane, Shape or Assembly).")
        self._result = _shape(namespace["result"])
        for kind in ("face", "edge"):
            for name, value in dict(namespace.get(f"{kind}s") or {}).items():
                self._names[kind][str(name)] = _shapes(value, kind)
        if namespace.get("bodies"):
            self._bodies = {str(k): _shape(v) for k, v in dict(namespace["bodies"]).items()}

    @property
    def result(self):
        """The part as one CadQuery Shape, in its own (work) coordinates."""
        self._load()
        return self._result

    def _select(self, kind, name):
        self._load()
        if name in self._names[kind]:
            return list(self._names[kind][name])
        match = INDEXED.fullmatch(str(name))
        items = self._result.Faces() if kind == "face" else self._result.Edges()
        if match and match.group(1) == kind and 1 <= int(match.group(2)) <= len(items):
            return [items[int(match.group(2)) - 1]]
        named = ", ".join(sorted(self._names[kind])) or "none"
        raise PartError(f"{self.path.name} has no {kind} {name!r}: {kind}s are {kind}1..{kind}{len(items)} "
                        f"(named: {named}).")

    def faces(self, name):
        """The faces a name selects: "face12" or a name the part file gives."""
        return self._select("face", name)

    def edges(self, name):
        """The edges a name selects: "edge7", a name the part file gives, or a face name (its edges)."""
        try:
            return self._select("edge", name)
        except PartError:
            if INDEXED.fullmatch(str(name)) and str(name).startswith("edge"):
                raise
            return [e for f in self.faces(name) for e in f.Edges()]

    def bodies(self):
        """{body id: solid}: the part file's `bodies`, or its solids as solid_1, solid_2, ..."""
        self._load()
        if self._bodies is not None:
            return dict(self._bodies)
        return {f"solid_{i + 1}": s for i, s in enumerate(self._result.Solids())}


_LOADED: dict[tuple[str, str], Part] = {}


def load_part(path: Path, alias: str = "part") -> Part:
    """A part file, loaded once per build process."""
    key = (str(Path(path).resolve()), alias)
    if key not in _LOADED:
        _LOADED[key] = Part(path, alias)
    return _LOADED[key]


def _face_geometry(face) -> dict:
    """What picking a face needs: a plane's normal (outward), a cylinder's axis, a point on it and its radius."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane
    surface = BRepAdaptor_Surface(face.wrapped)
    kind = surface.GetType()
    r = lambda v: round(v, 6)
    if kind == GeomAbs_Plane:
        normal = face.normalAt()
        return {"normal": [r(normal.x), r(normal.y), r(normal.z)]}
    if kind == GeomAbs_Cylinder:
        cylinder = surface.Cylinder()
        axis, at = cylinder.Axis().Direction(), cylinder.Axis().Location()
        return {"axis": [r(axis.X()), r(axis.Y()), r(axis.Z())], "center": [r(at.X()), r(at.Y()), r(at.Z())], "radius": r(cylinder.Radius())}
    return {}


def tessellate(part: Part, tolerance: float = 0.02, angular: float = 0.2) -> dict:
    """The part for the viewer: triangles with the face each belongs to, and every edge as a polyline, in mm.

    {"positions": [x, y, z, ...], "indices": [...], "triangle_faces": [face number per triangle (1-based)],
     "faces": [{"name": "face1", "names": [...], "type": "PLANE", "area_mm2": ..., "normal": [...]} or a cylinder's
               "axis", "center" and "radius"],
     "edges": [[x, y, z, ...], ...], "edge_info": [{"name": "edge1", "names": [...], "type": "LINE", "flat": true}, ...],
     "bounds": {"min": [...], "max": [...]}}

    Faces and edges are numbered in the shape's own order, as Part.faces and Part.edges select them ("face12").
    """
    shape = part.result
    named = {"face": {}, "edge": {}}
    for kind in named:
        for name, items in part._names[kind].items():
            for item in items:
                named[kind].setdefault(item.hashCode(), []).append(name)
    positions, indices, triangle_faces, faces = [], [], [], []
    for number, face in enumerate(shape.Faces(), start=1):
        vertices, triangles = face.tessellate(tolerance, angular)
        base = len(positions) // 3
        for v in vertices:
            positions.extend((round(v.x, 5), round(v.y, 5), round(v.z, 5)))
        for a, b, c in triangles:
            indices.extend((base + a, base + b, base + c))
            triangle_faces.append(number)
        faces.append({"name": f"face{number}", "names": named["face"].get(face.hashCode(), []), "type": face.geomType(),
                      "area_mm2": round(face.Area(), 4), **_face_geometry(face)})
    edges, edge_info = [], []
    for number, edge in enumerate(shape.Edges(), start=1):
        kind = edge.geomType()
        if kind == "LINE":
            points = [edge.startPoint(), edge.endPoint()]
        else:
            count = max(8, min(96, int(edge.Length() / 0.5)))
            points = [edge.positionAt(t / count) for t in range(count + 1)]
        edges.append([round(c, 5) for p in points for c in (p.x, p.y, p.z)])
        # Flat: in a plane along XY (what paths() follows: lines and circular arcs).
        flat = max(p.z for p in points) - min(p.z for p in points) <= 1e-6 and kind in ("LINE", "CIRCLE")
        edge_info.append({"name": f"edge{number}", "names": named["edge"].get(edge.hashCode(), []), "type": kind, "flat": flat})
    box = shape.BoundingBox()
    return {"positions": positions, "indices": indices, "triangle_faces": triangle_faces, "faces": faces, "edges": edges,
            "edge_info": edge_info, "bounds": {"min": [box.xmin, box.ymin, box.zmin], "max": [box.xmax, box.ymax, box.zmax]}}


def main(argv):
    """python -m camlib_ui.parts <part file> <out.json>: the part tessellated for the viewer (tessellate)."""
    import json
    import sys
    try:
        data = {"ok": True, **tessellate(Part(Path(argv[0])))}
    except Exception as error:  # noqa: BLE001  The part's own error is the answer.
        import traceback
        data = {"ok": False, "error": f"{type(error).__name__}: {error}", "trace": traceback.format_exc()[-6000:]}
    Path(argv[1]).write_text(json.dumps(data, separators=(",", ":")))
    sys.exit(0)


if __name__ == "__main__":
    import sys
    main(sys.argv[1:])
