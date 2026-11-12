"""Cover: 90 x 50 x 8 mm with a 40 x 26 x 5 mm pocket and a 20 x 30 x 3 mm recess in its top.

A camlib-ui part file: a CadQuery script that sets `result`. `faces` names the faces the program machines by name
(every face is also face1, face2, ... and every edge edge1, edge2, ...).
"""
import cadquery as cq

length, width, thickness = 90.0, 50.0, 8.0   # mm
pocket_depth, recess_depth = 5.0, 3.0         # mm

plate = cq.Workplane("XY").box(length, width, thickness, centered=False)
pocket = cq.Workplane("XY").box(40.0, 26.0, pocket_depth, centered=False).translate((8.0, 12.0, thickness - pocket_depth))
recess = cq.Workplane("XY").box(20.0, 30.0, recess_depth, centered=False).translate((58.0, 10.0, thickness - recess_depth))
result = plate.cut(pocket).cut(recess)

faces = {
    "top": result.faces(">Z"),
    "pocket_floor": result.faces(cq.selectors.NearestToPointSelector((28.0, 25.0, thickness - pocket_depth))),
    "recess_floor": result.faces(cq.selectors.NearestToPointSelector((68.0, 25.0, thickness - recess_depth))),
    "bottom": result.faces("<Z"),
}
