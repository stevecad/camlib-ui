"""Plate: 100 x 60 x 20 mm with a 50 x 30 x 8 mm pocket in its top and four 6.6 mm through holes.

A camlib-ui part file: a CadQuery script that sets `result`. `faces` names the faces the program machines by name
(every face is also face1, face2, ... and every edge edge1, edge2, ...).
"""
import cadquery as cq

length, width, thickness = 100.0, 60.0, 20.0   # mm
pocket_depth, hole_d = 8.0, 6.6                 # mm
holes = [(10.0, 10.0), (90.0, 10.0), (10.0, 50.0), (90.0, 50.0)]

plate = cq.Workplane("XY").box(length, width, thickness, centered=False)
pocket = cq.Workplane("XY").box(50.0, 30.0, pocket_depth, centered=False).translate((25.0, 15.0, thickness - pocket_depth))
drills = cq.Workplane("XY").pushPoints(holes).circle(hole_d / 2).extrude(thickness)
result = plate.cut(pocket).cut(drills)

faces = {
    "top": result.faces(">Z"),
    "pocket_floor": result.faces(cq.selectors.NearestToPointSelector((50.0, 30.0, thickness - pocket_depth))),
    "bottom": result.faces("<Z"),
}
