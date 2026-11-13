"""Sheet: six brackets and eight washers nested on a 500 x 300 mm sheet of 6 mm steel and cut with a plasma torch.

The parts are flat outlines with their holes, in millimetres; camlib's Nest places the copies (and proves their
spacing), and ThermalCut plans every pierce, lead and kerf path around them: holes before outlines, the kerf beside
the part. The sheet's lower left corner on its top face is the program's zero.
"""
import math

from links import shop
from camlib import Job, Nest, NestPart, Setup, SmallHoles, StockSpec, ThermalCut
from camlib.motion import WorkFrame
from camlib.planar import Boundary, Component, PlanarRegion
from camlib.post import LoweringOptions
from camlib.verification import StockContactOptions, StreamChecks
from camlib_ui.program import Program, cutting, head, machine

THICKNESS = 6


def circle(centre, radius):
    """A circle as camlib's Boundary: two half turns (a vertex's bulge 1 is a half circle to the next)."""
    return Boundary(((centre[0] + radius, centre[1], 1), (centre[0] - radius, centre[1], 1)))


def rectangle(x0, y0, x1, y1):
    return Boundary.polygon(((x0, y0), (x1, y0), (x1, y1), (x0, y1)))


# Each part: its outline, then its holes.
bracket = PlanarRegion("bracket", (Component(rectangle(0, 0, 90, 60), (circle((20, 30), 8), circle((70, 30), 8),
                                                                      circle((45, 12), 3), circle((45, 48), 3))),), 0)
washer = PlanarRegion("washer", (Component(circle((0, 0), 18), (circle((0, 0), 7),)),), 0)
sheet = PlanarRegion("sheet", (Component(rectangle(0, 0, 500, 300)),))

# The torch (its kerf is the recipe's) and the cut's process values, from the shop's recipe. QtPlasmaC owns the heights
# and the pierce delay, so the cut is planned at one Z ("fixed"); the lead arcs' radii are this program's.
torch = head(shop.table, shop.steel6)
process = cutting(shop.steel6, shop.table, height_mode="fixed", lead_in_radius_mm=3, lead_out_radius_mm=2)
# Holes up to 1.5 x the sheet's thickness across are cut slower, with height control off (camlib's SmallHoles); each
# loop ends 0.5 mm before it closes (a negative overcut).
plan = dict(overcut_mm=-0.5, height_control=True, small_holes=SmallHoles(feed_percent=60), tool_number=1,
            length_register=1, **process)
# The nest: copies of each part, the rotations they may take, the material left between cuts and to the sheet's edge,
# for a cut with this kerf and these leads. camlib refuses a nest that doesn't fit, and proves the distances of the
# one it returns.
nest = Nest.for_cut(ThermalCut("cut", torch, None, **plan), sheet,
                    parts=(NestPart(bracket, quantity=6, rotations_deg=(0, 90)),
                           NestPart(washer, quantity=8, rotations_deg=(0,))),
                    part_spacing_mm=3, edge_margin_mm=10, resolution_mm=1).run()
ops = (
    ThermalCut("cut", torch, nest.region, **plan),
)
setup = Setup("sheet", StockSpec((0, 0, 0), (500, 300, THICKNESS), 0.5), (torch,), ops, (0, 0, 40),
              verification=StreamChecks(stock_contact=StockContactOptions()))
job = Job("sheet", "1", (setup,))
# Where the sheet's corner sits in the table's coordinates. This shop declares no machine crash model (camlib
# docs/machine.md), so camlib can't check the table's own bodies; that is accepted here on purpose and the result says
# so. Remove it to see camlib refuse.
program = Program(
    job,
    machine(shop.table, setup, work_to_machine=WorkFrame((100, 100, -190)), lowering=LoweringOptions(native_arcs=True),
            arcs=True, helices=False, planes=("xy",), max_sweep_rad=math.tau, max_tool_number=1, max_length_register=1,
            blend_mm=0.005),
    accept={"unchecked_machine"},
)
