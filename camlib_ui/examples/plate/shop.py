"""The shop: a LinuxCNC vertical mill, a BT30 ER20 holder, three tools in a rack and a vise.

Every value camlib checks against comes from here (travel, feeds, spindle, tool and holder geometry) or from the
program (where the work sits, coolant, the control's options): nothing is assumed. Replace these with your own.
"""
from camlib_ui.shop import *

IDENTITY = {"x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "z": [0.0, 0.0, 1.0]}

shop = Shop()
model = shop.add(MachineModel.mill("vmc_model", "Example VMC", travel=(500, 400, 400),
                                   spindle=Spindle(interface="bt30", max_rpm=12000),
                                   changer=Changer.magazine(pockets=12, interface="bt30"), rapid=10000))
control = shop.add(Controller("control", "LinuxCNC", dialect="linuxcnc_cartesian_linear_v1", rapid_behavior="linear",
                              tool_length_compensation="offset_table", feed_modes=["units_per_minute"],
                              work_offsets=[1, 2, 3, 4, 5, 6], linear_resolution_mm=0.001))
mill = shop.add(Machine("mill", "Example VMC", model=model, controller=control))

er20 = shop.add(Holder("bt30_er20", "BT30 ER20", input_interface="bt30", output_interface="cylindrical_shank",
                       output_frame={"origin_mm": [0.0, 0.0, -70.0], **IDENTITY},
                       outer_profile=[{"shape": "frustum", "z_start_mm": -70.0, "z_end_mm": -40.0,
                                       "radius_start_mm": 17.5, "radius_end_mm": 17.5},
                                      {"shape": "frustum", "z_start_mm": -40.0, "z_end_mm": 0.0,
                                       "radius_start_mm": 19.5, "radius_end_mm": 23.0}],
                       clamp={"min_diameter_mm": 1.0, "max_diameter_mm": 13.0, "min_engagement_mm": 12.0,
                              "max_engagement_mm": 30.0}))
em10 = shop.add(EndMill("em10", "10 mm end mill", diameter=10, flutes=3, flute_length=30, overall_length=75))
em6 = shop.add(EndMill("em6", "6 mm end mill", diameter=6, flutes=3, flute_length=18, overall_length=60))
dr66 = shop.add(Drill("dr66", "6.6 mm drill", diameter=6.6, flute_length=60, overall_length=100, material="hss"))
t_em10 = shop.add(Tool("t_em10", "10 mm end mill", cutter=em10, holders=[er20], stickout=45))
t_em6 = shop.add(Tool("t_em6", "6 mm end mill", cutter=em6, holders=[er20], stickout=30))
t_drill = shop.add(Tool("t_drill", "6.6 mm drill", cutter=dr66, holders=[er20], stickout=70))
rack = shop.add(ToolSetup("rack", "Rack", tools={1: (t_em10, {"offsets": {"length_register": 1}}),
                                                 2: (t_em6, {"offsets": {"length_register": 2}}),
                                                 3: (t_drill, {"offsets": {"length_register": 3}})}))

# The vise: its bodies are vise.py's, its mounting frame the fixed jaw's clamping face (top, middle).
vise = shop.add(Record("fixture", "vise", {
    "name": "6 in vise",
    "components": [{"id": "base", "name": "Base", "role": "base", "geometry_source": {"file": "vise.py", "body": "base"}},
                   {"id": "jaw_fixed", "name": "Fixed jaw", "role": "jaw",
                    "geometry_source": {"file": "vise.py", "body": "jaw_fixed"}},
                   {"id": "jaw_moving", "name": "Moving jaw", "role": "jaw",
                    "geometry_source": {"file": "vise.py", "body": "jaw_moving"}}],
    "mounting_frames": {"jaw": {"origin_mm": [0.0, 0.0, -100.0], **IDENTITY}},
    "states": [{"id": "open_70", "name": "Open 70 mm", "permitted_processes": ["milling"],
                "component_frames": {"base": {"origin_mm": [0.0, 0.0, 0.0], **IDENTITY},
                                     "jaw_fixed": {"origin_mm": [0.0, 0.0, 0.0], **IDENTITY},
                                     "jaw_moving": {"origin_mm": [0.0, 70.0, 0.0], **IDENTITY}}}]}))
