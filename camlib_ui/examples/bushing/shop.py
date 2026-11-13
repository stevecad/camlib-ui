"""The shop: a two-axis lathe with a Centroid CNC12 control, and a drill, a boring bar and two outside tools in its turret.

Example values, not a real machine's or a tool maker's: every value camlib checks against comes from here (the spindle
and axis rates, each insert, its holder and its body off the centre plane) or from the program (the chuck face, the
control's options). Nothing is assumed. Replace these with your own.
"""
from camlib_ui.shop import *

shop = Shop()
model = shop.add(MachineModel.lathe("lathe_model", "Example lathe", x_travel=(0, 150), z_travel=(-400, 50),
                                    max_rpm=4000, stations=8, rapid=8000))
control = shop.add(Controller("control", "Centroid CNC12 lathe", dialect="centroid_lathe_v1", processes=("turning",),
                              linear_resolution_mm=0.001))
lathe = shop.add(Machine("lathe", "Example lathe", model=model, controller=control))

# Outside turning and facing: a positive 80 degree insert on a 95 degree holder (ISO designations: the insert's shape,
# thickness and clearance are its code's), on a flat seat.
t_turn = shop.add(TurningTool("t_turn", "CCMT 12 04 08 on SCLCR 2525", side="outer", hand="right",
                              insert=TurningInsert.iso_code("CCMT120408", holder="SCLCR2525M12"),
                              holder=TurningHolder.rectangle(width=25, length=150, offset=0, y=(-25, 3)), seat=(0, 0)))
# A 16 mm drill with a 118 degree point, on the spindle axis: 50 mm of flutes, a 40 mm chuck behind them.
t_drill = shop.add(TurningTool("t_drill", "16 mm drill", side="outer", hand="right", nose_radius=0,
                               insert=TurningInsert.drill(diameter=16, point_angle=118, flute_length=50),
                               holder=TurningHolder.rectangle(width=40, length=60, offset=0, y=(-10, 10))))
# A boring bar: a 55 degree insert with a 0.4 mm nose cutting outward in the hole, on a 10 mm bar.
t_bore = shop.add(TurningTool("t_bore", "10 mm boring bar, 55° insert", side="inner", hand="right",
                              insert=TurningInsert.iso(included_angle=55, approach_angle=95, edge_length=6, nose_radius=0.4),
                              holder=TurningHolder.rectangle(width=10, length=80, offset=1, y=(-1.5, 1)),
                              seat=(0, 0), insert_thickness=1.5, insert_clearance=11))
# A 3 mm grooving and parting blade reaching 22 mm (past the bar's 20 mm radius).
t_groove = shop.add(TurningTool("t_groove", "3 mm grooving blade", side="outer", hand="right", nose_radius=0.2,
                                insert=TurningInsert.groove(width=3, depth=22),
                                holder=TurningHolder.rectangle(width=3, length=60, offset=0, y=(-10, 2)),
                                seat=(0, 0), insert_thickness=3, insert_clearance=7))
turret = shop.add(Turret("turret", "Turret", tools={1: t_turn, 2: t_drill, 3: t_bore, 4: t_groove}))
