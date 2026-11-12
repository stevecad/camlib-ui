"""Cover, top side: an adaptive pocket, a recess entered by a ramp, and the outline cut through with tabs at points.

The stock is the part's thickness, 8 mm larger all round, on a spoil board (not modelled: the program places no
fixture, and the result says so). The tabs hold the part in the stock once the outline is through.
"""
import math

from links import part, shop
from camlib import AdaptivePocket, Contour, Job, Pocket, RampEntry, Setup, StockSpec, Tabs
from camlib.motion import WorkFrame
from camlib.post import LoweringOptions
from camlib.verification import StockContactOptions, StreamChecks
from camlib_ui.program import Program, machine, region, slot, tool

mill6 = tool(shop.t_em6)
pocket = region(part, "pocket_floor", name="pocket")
recess = region(part, "recess_floor", name="recess")
outline = region(part, "bottom", name="outline")

ops = (
    # camlib's default adaptive planner follows the edge of the uncut stock: stepover_mm is the radial width of every
    # pass, and its report (the result's Operations) gives the engagement it proved, level by level.
    AdaptivePocket("pocket", mill6, pocket, top_z_mm=8, floor_z_mm=3, stepdown_mm=2.5, stepover_mm=1.5, clearance_z_mm=20,
                   feed_mm_min=900, plunge_mm_min=300, spindle_rpm=11000, coolant="flood", **slot(shop.rack, mill6)),
    # A ramp along the pass it is about to cut, never steeper than 3 degrees; it may turn around on a 4 mm span.
    Pocket("recess", mill6, recess, top_z_mm=8, floor_z_mm=5, stepdown_mm=1.5, stepover_mm=2.5, clearance_z_mm=20,
           entry=RampEntry(angle_deg=3, min_length_mm=4), feed_mm_min=900, plunge_mm_min=300, spindle_rpm=11000,
           coolant="flood", **slot(shop.rack, mill6)),
    # Through the stock, with a tab at the middle of each side. A loop with no point would get no tab.
    Contour("outline", mill6, outline, floor_z_mm=0, stepdown_mm=2, clearance_z_mm=20, lead_in_mm=3, lead_out_mm=3,
            tabs=Tabs(width_mm=6, height_mm=1.5, positions_mm=((45, 0), (90, 25), (45, 50), (0, 25))),
            feed_mm_min=900, plunge_mm_min=300, spindle_rpm=11000, coolant="flood", **slot(shop.rack, mill6)),
)
# The tabs are left on purpose, so the finished stock isn't compared with the part here (the result lists the material
# check as not run). Every move is checked against the stock.
setup = Setup("top", StockSpec((-8, -8, 0), (98, 58, 8), 0.5), (mill6,), ops, (0, 0, 60),
              verification=StreamChecks(stock_contact=StockContactOptions()))
job = Job("cover", "1", (setup,))
# This shop declares no machine crash model (camlib docs/machine.md: Machine.crash_model), so camlib can't check the
# machine's own bodies; that is accepted here on purpose and the result says so. Remove it to see camlib refuse.
program = Program(
    job,
    machine(shop.mill, setup, tooling=shop.rack, work_to_machine=WorkFrame((200, 150, -300)),
            lowering=LoweringOptions(native_arcs=True), flood=True, mist=False, planes=("xy", "xz", "yz"), arcs=True,
            helices=True, max_sweep_rad=math.tau, max_tool_number=99, max_length_register=99,
            tool_change_position_mode="preserve_tip"),
    accept={"unchecked_machine"},
)
