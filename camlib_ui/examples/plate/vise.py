"""A 6 in vise for the shop's fixture: a base and two jaws (separate bodies), its origin at the middle of the base's
bottom front edge. The fixed jaw's clamping face is y = 0, its top z = 100; the moving jaw is modelled with its clamping
face at y = 0 too, and the shop's fixture state places it at the opening."""
import cadquery as cq


def block(x0, y0, z0, x1, y1, z1):
    return cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0, centered=False).translate((x0, y0, z0)).val()


bodies = {
    "base": block(-76.0, -20.0, 0.0, 76.0, 200.0, 55.0),
    "jaw_fixed": block(-76.0, -20.0, 55.0, 76.0, 0.0, 100.0),
    "jaw_moving": block(-76.0, 0.0, 55.0, 76.0, 20.0, 100.0),
}
result = cq.Compound.makeCompound(list(bodies.values()))
