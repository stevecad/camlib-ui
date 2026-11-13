"""The shop: a plasma table with a LinuxCNC QtPlasmaC control, its torch, and a cutting recipe for 6 mm mild steel.

Example values, not a real machine's or a torch maker's cut chart: every value camlib checks against or cuts with comes
from here (the table's travel and rates, the torch's nozzle and body, the recipe's kerf, feed, heights and leads) or
from the program (where the sheet lies, the control's options). Nothing is assumed. Replace these with your own.
"""
from camlib_ui.shop import *

shop = Shop()
model = shop.add(MachineModel.table("table_model", "Example plasma table", travel=(1300, 650, 100), rapid=15000,
                                    head=CuttingHead.plasma("torch", nozzle_diameter=12, nozzle_length=20,
                                                            body_diameter=35, body_length=120)))
control = shop.add(Controller("control", "LinuxCNC QtPlasmaC", dialect="linuxcnc_qtplasmac_v1", processes=("plasma",),
                              linear_resolution_mm=0.001))
table = shop.add(Machine("table", "Example plasma table", model=model, controller=control))
# What the torch does in this material at this current (a cut chart's line): the kerf it burns, its feed and cut
# height, how long and how far from the cut it pierces, and its leads. QtPlasmaC takes the pierce height, the pierce
# delay and the cut height from its own material file; camlib plans the path with the kerf and the leads.
steel6 = shop.add(CuttingRecipe("steel6", "6 mm mild steel, 45 A", process="plasma", kerf=1.5, feed=2500, cut_height=1.5,
                                pierce_seconds=0.5, pierce_radius=2.25, lead_in=2, lead_out=1, pierce_height=3.8,
                                clearance=10))
