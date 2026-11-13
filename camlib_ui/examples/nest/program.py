"""Nest: parts drawn in a DXF file, nested on a sheet from a chosen corner and cut with a plasma torch.

parts.dxf holds three flat parts (a bracket, a ring and a gusset) as closed outlines with their holes. camlib's Nest
places the copies from the sheet's start corner (and proves their spacing); ThermalCut cuts them in an order that
spreads the heat, keeping its rapids off the parts already cut free; and the remnant of the sheet comes out of the
build as remnant.dxf, to be the sheet of the next job. The sheet's lower left corner on its top face is the program's
zero.
"""
import math

from links import shop
from camlib import AvoidCutParts, Job, Nest, NestPart, Setup, SmallHoles, SpreadHeat, StockSpec, ThermalCut
from camlib.dxf import write_regions
from camlib.motion import WorkFrame
from camlib.planar import Boundary, Component, PlanarRegion
from camlib.post import LoweringOptions
from camlib.verification import StockContactOptions, StreamChecks
from camlib_ui.program import Program, cutting, dxf_parts, head, machine

SHEET_X, SHEET_Y, THICKNESS = 500, 300, 6

# The drawing is in millimetres; ends up to 0.01 mm apart are one corner.
bracket, ring, gusset = dxf_parts("parts.dxf", unit_mm=1, join_tolerance_mm=0.01)
sheet = PlanarRegion("sheet", (Component(Boundary.polygon(((0, 0), (SHEET_X, 0), (SHEET_X, SHEET_Y), (0, SHEET_Y)))),))

# The torch and the cut's process values, from the shop's recipe (QtPlasmaC owns the heights and the pierce delay).
torch = head(shop.table, shop.steel6)
# Parts cut one after the other start at least 120 mm apart, and rapids keep 8 mm from parts already cut free (they
# can tip up between the slats): both are this shop's choices for this plate, not camlib's.
plan = dict(overcut_mm=-0.5, height_control=True, small_holes=SmallHoles(feed_percent=60),
            part_order=SpreadHeat(min_distance_mm=120), avoid_cut_parts=AvoidCutParts(clearance_mm=8),
            tool_number=1, length_register=1,
            **cutting(shop.steel6, shop.table, height_mode="fixed", lead_in_radius_mm=3, lead_out_radius_mm=2))
# The nest: how many of each part, the rotations each may take, the material left between cuts and to the sheet's
# edge, and where the fill starts (the remnant is left on the far side).
layout = Nest.for_cut(ThermalCut("cut", torch, None, **plan), sheet,
                      parts=(NestPart(bracket, quantity=4, rotations_deg=(0, 90, 180, 270)),
                             NestPart(ring, quantity=5, rotations_deg=(0,)),
                             NestPart(gusset, quantity=6, rotations_deg=(0, 90, 180, 270))),
                      part_spacing_mm=3, edge_margin_mm=10, resolution_mm=1,
                      start_corner="lower_left", fill_axis="y")
nest = layout.run()
# What is left of the sheet, 3 mm in from everything the cut can reach: the next job's sheet.
remnant = layout.remnant(nest, remnant_margin_mm=3)

ops = (
    ThermalCut("cut", torch, nest.region, **plan),
)
setup = Setup("sheet", StockSpec((0, 0, 0), (SHEET_X, SHEET_Y, THICKNESS), 0.5), (torch,), ops, (0, 0, 40),
              verification=StreamChecks(stock_contact=StockContactOptions()))
job = Job("nest", "1", (setup,))
# This shop declares no machine crash model (camlib docs/machine.md), so camlib can't check the table's own bodies;
# that is accepted here on purpose and the result says so. Remove it to see camlib refuse.
program = Program(
    job,
    machine(shop.table, setup, work_to_machine=WorkFrame((100, 100, -190)), lowering=LoweringOptions(native_arcs=True),
            arcs=True, helices=False, planes=("xy",), max_sweep_rad=math.tau, max_tool_number=1, max_length_register=1,
            blend_mm=0.005),
    accept={"unchecked_machine"},
    outputs={"remnant.dxf": write_regions(remnant.pieces[0])} if remnant.pieces else {},
)
