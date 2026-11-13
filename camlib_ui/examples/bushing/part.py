"""Bushing: a turned part 36 mm across and 40 mm long, with a stepped blind hole and a groove round its outside.

A camlib-ui part file: a CadQuery script that sets `result`. A turned part is a solid of revolution about its Z axis
with its front face toward +Z; the centre of the front face is the program's zero.
"""
import math

import cadquery as cq

outer_r, length = 18.0, 40.0                            # mm
bore_r, bore_depth, drill_r = 11.0, 25.0, 8.0           # mm: the bore, and the drilled hole left at its bottom
groove_from, groove_to, groove_r = -30.0, -33.0, 15.0   # mm: a 3 mm groove, 3 mm deep
cone = drill_r / math.tan(math.radians(118 / 2))        # the 118 degree drill point's depth

# The half-section, (radius, z): the outside from the front face toward the chuck, then back up the hole.
section = [
    (bore_r, 0), (outer_r, 0), (outer_r, groove_from), (groove_r, groove_from), (groove_r, groove_to), (outer_r, groove_to),
    (outer_r, -length), (0, -length), (0, -bore_depth - cone), (drill_r, -bore_depth), (bore_r, -bore_depth),
]
result = cq.Workplane("XZ").polyline(section).close().revolve(360, (0, 0, 0), (0, 1, 0))
