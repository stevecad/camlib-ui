"""Shaft, turned from a 40 mm bar: face, rough, finish (the relief and its fillet too), the M20 x 2.5 thread, part off.

Lathe coordinates: X is the radius from the spindle axis, Z runs along it; zero is the centre of the part's front face.
The bar stands 2 mm proud of the front face and is held in the chuck, whose face is 50 mm behind it. The speeds and
feeds are example values for the example's tools: set your own.
"""
import math

from links import part, shop
from camlib import Job, Setup, TurnFace, TurnFinish, TurnPartOff, TurnRough, TurnStockSpec, TurnThread, TurningSetup
from camlib.post import LoweringOptions
from camlib_ui.program import Program, machine, station, tool, turned

rough, finish, thread, part_off = tool(shop.t_rough), tool(shop.t_finish), tool(shop.t_thread), tool(shop.t_part)

ops = (
    TurnFace("face", "t_rough", z_mm=0, stepdown_mm=1, feed_mm_rev=0.15, rpm=1200),
    # Axial passes down to the part plus an allowance; the relief is below what this insert reaches and is left.
    TurnRough("rough", "t_rough", depth_of_cut_mm=2, allowance_mm=0.3, feed_mm_rev=0.25, rpm=1200),
    # The whole profile at size: the relief's slope and its fillet are followed as they are (the fillet as an arc).
    TurnFinish("finish", "t_finish", feed_mm_rev=0.1, rpm=1500),
    # M20 x 2.5: 0.613 x the pitch deep, in passes of constant chip area; its run-out ends on the land, before the relief.
    TurnThread("thread", "t_thread", z_start_mm=0, z_end_mm=-15, major_radius_mm=10, pitch_mm=2.5, depth_mm=1.534,
               passes=6, rpm=500),
    TurnPartOff("part_off", "t_part", z_mm=-40, feed_mm_rev=0.05, rpm=800),
)
setup = Setup("turn", stock=TurnStockSpec(z_min_mm=-60, z_max_mm=2, outer_radius_mm=20),
              tools=(station(shop.turret, rough), station(shop.turret, finish), station(shop.turret, thread),
                     station(shop.turret, part_off)),
              operations=ops, initial_position_mm=(40, 0, 30),
              # The part's half-section, read from the part (camlib.cadquery.turning_section), the chuck face, the
              # approach clearance and the tolerance of every move check (the posted program, rounded to the control's
              # 0.001 mm, is checked with it too).
              turning=TurningSetup.from_section(turned(part), chuck_z_mm=-50, clearance_mm=2, tolerance_mm=0.01))
job = Job("shaft", "1", (setup,))
# Arcs are posted as G2/G3 where their words are exact at the control's three decimals; the others become chords within
# camlib's 0.0025 mm, inside the setup's tolerance (camlib replays the posted program against the part with it).
# This shop declares no machine crash model (camlib docs/machine.md), so camlib can't check the lathe's own bodies or
# its travel; that is accepted here on purpose and the result says so. Remove it to see camlib refuse.
program = Program(
    job,
    machine(shop.lathe, setup, lowering=LoweringOptions(native_arcs=True), flood=True, mist=False, arcs=True,
            helices=False, max_sweep_rad=math.tau, max_tool_number=8, max_length_register=8, program_number=1001),
    accept={"unchecked_machine"},
)
