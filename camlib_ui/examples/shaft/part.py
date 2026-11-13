"""Shaft: a turned part, 30 mm across and 40 mm long, with an M20 x 2.5 thread at its front and a thread relief.

A camlib-ui part file: a CadQuery script that sets `result`. A turned part is a solid of revolution about its Z axis
with its front face toward +Z: the lathe's Z is the part's Z, and the lathe's X (the radius) the part's X. Its origin
(the centre of the front face) is the program's zero.
"""
import math

import cadquery as cq

thread_r, thread_end, chamfer = 10.0, -16.0, 1.5        # mm: M20's major radius, where the thread's land ends, its chamfer
relief_r, shoulder_z, fillet = 8.2, -23.0, 1.5          # mm: the thread relief, down a 30 degree slope, up a fillet
body_r, length = 15.0, 40.0                             # mm

relief_z = thread_end - (thread_r - relief_r) / math.tan(math.radians(30))   # where the slope reaches the relief
corner = (relief_r + fillet, shoulder_z + fillet)                            # the fillet's centre
# The half-section, (radius, z) from the front face on the axis toward the chuck.
result = (
    cq.Workplane("XZ").moveTo(0, 0).lineTo(thread_r - chamfer, 0).lineTo(thread_r, -chamfer).lineTo(thread_r, thread_end)
    .lineTo(relief_r, relief_z).lineTo(relief_r, shoulder_z + fillet)
    .threePointArc((corner[0] - fillet * math.sqrt(0.5), corner[1] - fillet * math.sqrt(0.5)), (relief_r + fillet, shoulder_z))
    .lineTo(body_r, shoulder_z).lineTo(body_r, -length).lineTo(0, -length).close()
    .revolve(360, (0, 0, 0), (0, 1, 0))
)
