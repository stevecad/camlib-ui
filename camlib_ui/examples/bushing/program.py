"""Bushing, turned from a 40 mm bar: face, drill, bore, turn the outside, groove it, part off.

Lathe coordinates: X is the radius from the spindle axis, Z runs along it; zero is the centre of the part's front face.
The bar stands 1 mm proud of the front face; the chuck's face is 50 mm behind it. The speeds and feeds are example
values for the example's tools: set your own.
"""
import math

from links import part, shop
from camlib import (Job, Setup, TurnBoreFinish, TurnBoreRough, TurnDrill, TurnFace, TurnGroove, TurnPartOff, TurnRough,
                    TurnStockSpec, TurningSetup)
from camlib.post import LoweringOptions
from camlib_ui.program import Program, machine, station, tool, turned

turn, drill, bore, groove = tool(shop.t_turn), tool(shop.t_drill), tool(shop.t_bore), tool(shop.t_groove)
section = turned(part)                    # the outside's half-section and the hole's, read from the part
hole_bottom = section.bore[-1][1]         # the drill point's tip, on the axis

ops = (
    TurnFace("face", "t_turn", z_mm=0, stepdown_mm=1, feed_mm_rev=0.15, rpm=1200),
    # On the axis to the hole's bottom, in 10 mm pecks; camlib checks the drill stays inside the part's hole.
    TurnDrill("drill", "t_drill", depth_z_mm=hole_bottom, peck_mm=10, feed_mm_rev=0.12, rpm=900),
    # The drilled hole opened to the bore less an allowance, then the bore followed at size.
    TurnBoreRough("bore_rough", "t_bore", z_end_mm=-24, depth_of_cut_mm=1.5, allowance_mm=0.2, feed_mm_rev=0.15, rpm=1000),
    TurnBoreFinish("bore_finish", "t_bore", z_end_mm=-24, feed_mm_rev=0.08, rpm=1200),
    # The outside to size in axial passes (the groove is left for the blade).
    TurnRough("turn", "t_turn", depth_of_cut_mm=1, allowance_mm=0, feed_mm_rev=0.15, rpm=1200),
    TurnGroove("groove", "t_groove", z_from_mm=-30, z_to_mm=-33, bottom_radius_mm=15, peck_mm=1, feed_mm_rev=0.05, rpm=800),
    TurnPartOff("part_off", "t_groove", z_mm=-40, feed_mm_rev=0.05, rpm=800),
)
setup = Setup("turn", stock=TurnStockSpec(z_min_mm=-60, z_max_mm=1, outer_radius_mm=20),
              tools=(station(shop.turret, turn), station(shop.turret, drill), station(shop.turret, bore),
                     station(shop.turret, groove)),
              operations=ops, initial_position_mm=(40, 0, 60),
              turning=TurningSetup.from_section(section, chuck_z_mm=-50, clearance_mm=2, tolerance_mm=0.01))
job = Job("bushing", "1", (setup,))
# This shop declares no machine crash model (camlib docs/machine.md), so camlib can't check the lathe's own bodies or
# its travel; that is accepted here on purpose and the result says so. Remove it to see camlib refuse.
program = Program(
    job,
    machine(shop.lathe, setup, lowering=LoweringOptions(native_arcs=True), flood=True, mist=False, arcs=True,
            helices=False, max_sweep_rad=math.tau, max_tool_number=8, max_length_register=8),
    accept={"unchecked_machine"},
)
