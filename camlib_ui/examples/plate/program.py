"""Plate, top side: face, pocket, outline and holes. The stock stands 6 mm below the part, held in the shop's vise."""
import math

from links import part, shop
from camlib import Contour, Drilling, Facing, HelicalEntry, Job, Pocket, Setup, StockSpec
from camlib.motion import WorkFrame
from camlib.post import LoweringOptions
from camlib.material import Options as MaterialOptions
from camlib.verification import MaterialCheck, StockContactOptions, StreamChecks
from camlib_ui.program import Program, fixture, machine, part_target, region, slot, tool

mill10, mill6, drill = tool(shop.t_em10), tool(shop.t_em6), tool(shop.t_drill)
# The vise's fixed jaw: its clamping face at Y -5, its top 1 mm below the part (the stock's bottom 5 mm in the jaws).
vise = fixture(shop.vise, at=(50, -5, -1))
floor = region(part, "pocket_floor", name="pocket")
outline = region(part, "bottom", name="outline")
holes = [(10, 10), (90, 10), (10, 50), (90, 50)]
# The finished stock compared with the part: a cut below its surface is a gouge (a violation). camlib protects
# everything below the target's base; the stock stands below the part, so the base is the stock's bottom (drilling
# through the part into it isn't a gouge). Cells along walls the tool runs tangent to are decided within 0.01 mm.
protect_part = MaterialCheck(part_target(part, base_z_mm=-6), options=MaterialOptions(comparison_tolerance_mm=0.01))

ops = (
    Facing("face", mill10, floor_z_mm=20, stepdown_mm=1, stepover_mm=4, clearance_z_mm=30,
           feed_mm_min=1200, plunge_mm_min=400, spindle_rpm=9000, coolant="flood", **slot(shop.rack, mill10)),
    Pocket("pocket", mill6, floor, top_z_mm=20, floor_z_mm=12, stepdown_mm=2, stepover_mm=2.5, clearance_z_mm=30,
           entry=HelicalEntry(), feed_mm_min=900, plunge_mm_min=300, spindle_rpm=11000, coolant="flood",
           **slot(shop.rack, mill6)),
    Contour("outline", mill10, outline, floor_z_mm=0, stepdown_mm=5, clearance_z_mm=30, lead_in_mm=3, lead_out_mm=3,
            feed_mm_min=1000, plunge_mm_min=300, spindle_rpm=9000, coolant="flood", **slot(shop.rack, mill10)),
    Drilling("holes", drill, holes, depth_z_mm=-1, clearance_z_mm=30, allow_breakthrough_mm=1.5, peck_mm=4,
             feed_mm_min=200, retract_feed_mm_min=600, spindle_rpm=1500, coolant="flood", **slot(shop.rack, drill)),
)
setup = Setup("top", StockSpec((-5, -5, -6), (105, 65, 21), 0.5), (mill10, mill6, drill), ops, (0, 0, 60),
              verification=StreamChecks(stock_contact=StockContactOptions(), material=(protect_part,)))
job = Job("plate", "1", (setup,))
# This shop declares no machine crash model (camlib docs/machine.md: Machine.crash_model), so camlib can't check the
# machine's own bodies; that is accepted here on purpose and the result says so. Remove it to see camlib refuse.
program = Program(
    job,
    machine(shop.mill, setup, tooling=shop.rack, work_to_machine=WorkFrame((200, 150, -300)), fixtures=vise,
            lowering=LoweringOptions(native_arcs=True), flood=True, mist=False, planes=("xy", "xz", "yz"), arcs=True,
            helices=True, max_sweep_rad=math.tau, max_tool_number=99, max_length_register=99,
            tool_change_position_mode="preserve_tip"),
    accept={"unchecked_machine"},
)
