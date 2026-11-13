"""The shop: a two-axis lathe with a FANUC control (G-code system A) and four tools in its turret.

Example values, not a real machine's or a tool maker's: every value camlib checks against comes from here (the spindle
and axis rates, each insert, its holder and its body off the centre plane) or from the program (the chuck face, the
control's options). Nothing is assumed. Replace these with your own.
"""
from camlib_ui.shop import *

shop = Shop()
model = shop.add(MachineModel.lathe("lathe_model", "Example lathe", x_travel=(0, 150), z_travel=(-400, 50),
                                    max_rpm=4000, stations=8, rapid=8000))
control = shop.add(Controller("control", "FANUC 0i-TF (system A)", dialect="fanuc_lathe_system_a_v1",
                              processes=("turning",), linear_resolution_mm=0.001))
lathe = shop.add(Machine("lathe", "Example lathe", model=model, controller=control))

# Inserts by their ISO 1832 designation on holders by their ISO 5608 one: the insert's shape, size tolerance, thickness
# and 7 degree clearance are its code's, the approach angle the holder's. Each holder: its shank's width and length, its
# height below the cutting face and above it, and its seat's rake and inclination (0, 0: its catalogue page's).
# Roughing and facing: a positive 80 degree insert on a 95 degree screw-clamp holder.
t_rough = shop.add(TurningTool("t_rough", "CCMT 12 04 08 on SCLCR 2525", side="outer", hand="right",
                               insert=TurningInsert.iso_code("CCMT120408", holder="SCLCR2525M12"),
                               holder=TurningHolder.rectangle(width=25, length=150, offset=0, y=(-25, 3)), seat=(0, 0)))
# Finishing: a 35 degree insert on a 93 degree holder, which follows the relief's slope down and its shoulder up.
t_finish = shop.add(TurningTool("t_finish", "VCMT 16 04 04 on SVJCR 2020", side="outer", hand="right",
                                insert=TurningInsert.iso_code("VCMT160404", holder="SVJCR2020K16"),
                                holder=TurningHolder.rectangle(width=20, length=125, offset=0, y=(-20, 3)), seat=(0, 0)))
# A 60 degree threading insert (metric) standing 8 mm out of its holder, its tip radius 0.1 mm.
t_thread = shop.add(TurningTool("t_thread", "60° threading insert", side="outer", hand="right", nose_radius=0.1,
                                insert=TurningInsert.thread(profile_angle=60, depth=8),
                                holder=TurningHolder.rectangle(width=16, length=60, offset=0, y=(-10, 2)),
                                seat=(0, 0), insert_thickness=3, insert_clearance=7))
# A 3 mm parting blade reaching 22 mm (past the bar's 20 mm radius).
t_part = shop.add(TurningTool("t_part", "3 mm parting blade", side="outer", hand="right", nose_radius=0.2,
                              insert=TurningInsert.groove(width=3, depth=22),
                              holder=TurningHolder.rectangle(width=3, length=60, offset=0, y=(-10, 2)),
                              seat=(0, 0), insert_thickness=3, insert_clearance=7))
turret = shop.add(Turret("turret", "Turret", tools={1: t_rough, 2: t_finish, 3: t_thread, 4: t_part}))
