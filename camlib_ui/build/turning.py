"""A lathe setup as the build's result and the playback stream describe it: its bar, its part's half-section, its
operations and its tools, from camlib's own compiled turning definition (camlib.turning: Setup(turning=TurningSetup(...))).

The tools' outlines here are for drawing only (docs/playback-stream.md, "Turning tools"): camlib checked every move with
its own model of each insert, holder and body, never with these.
"""
from __future__ import annotations

import math

ARC_STEP_DEG = 10.0   # an outline arc is drawn as chords of at most this (display only)


def stock_summary(config):
    """The bar (camlib's TurnStockSpec) and the part's half-section, for the viewer: lathe coordinates are the work's
    (x the radius from the spindle axis, z along it), so the bar's box in work coordinates is ±radius about Z."""
    stock, turning = config["stock"], config["turning"]
    radius = float(stock["outer_radius_mm"])
    return dict(kind="turned", z_min_mm=stock["z_min_mm"], z_max_mm=stock["z_max_mm"], outer_radius_mm=radius,
                bore_radius_mm=stock.get("bore_radius_mm", 0), cell_mm=stock.get("cell_mm"),
                min_mm=[-radius, -radius, stock["z_min_mm"]], max_mm=[radius, radius, stock["z_max_mm"]],
                profile=[list(p) for p in (turning.get("part") or {}).get("points") or []],
                bore=[list(p) for p in (turning.get("bore") or {}).get("points") or []],
                face_grooves=list(turning.get("face_grooves") or []), chuck_z_mm=turning.get("chuck_z_mm"))


def operation_summaries(turning):
    """Each turning operation as camlib compiled it: its kind and tool, the tool's station and offset (the T word's),
    and its own speed and feed (per revolution: a lathe operation has no feed per minute of its own)."""
    stations = {entry["tool"]["id"]: entry for entry in turning["tools"]}
    out = []
    for op in turning["operations"]:
        station = stations.get(op.get("tool")) or {}
        out.append(dict(id=op["id"], kind=f"turn_{op.get('kind')}", tool=op.get("tool"), tool_number=station.get("number"),
                        length_register=station.get("offset"), spindle_rpm=op.get("rpm"), feed_mm_min=None,
                        feed_mm_rev=op.get("feed_mm_rev"), surface_speed_m_min=op.get("surface_speed_m_min")))
    return out


def _outline_points(outline):
    """A camlib turning Outline (start, then lines and arcs) as points (x, z); arcs as chords."""
    points = [tuple(outline["start_mm"])]
    for segment in outline["segments"]:
        if segment["kind"] == "line":
            points.append(tuple(segment["to_mm"]))
            continue
        (cx, cz), radius = segment["center_mm"], segment["radius_mm"]
        start, end = segment["start_deg"], segment["end_deg"]
        steps = max(1, math.ceil(abs(end - start) / ARC_STEP_DEG))
        for k in range(steps + 1):
            a = math.radians(start + (end - start) * k / steps)   # degrees from +x toward +z (camlib's tool frame)
            points.append((cx + radius * math.cos(a), cz + radius * math.sin(a)))
    return points


def _insert_shape(tool):
    """(the insert's polygon, its programming point), both in the tool frame with the nose centre at the origin
    (camlib src/turning/tool.rs: an outside, right-hand tool cutting toward -z; x away from the spindle axis)."""
    insert, nose = tool["insert"], float(tool["nose_radius_mm"])
    kind = insert["kind"]
    if kind == "outline":
        corner = insert["outline"]["segments"][insert["corner"]]
        cx, cz = corner["center_mm"]
        px, pz = insert["programming_point_mm"]
        return [(x - cx, z - cz) for x, z in _outline_points(insert["outline"])], (px - cx, pz - cz)
    if kind == "groove":       # the leading corner's nose centre is the reference; the blade reaches +x, its width +z
        w, d = float(insert["width_mm"]), float(insert["depth_mm"])
        return [(-nose, -nose), (-nose, w - nose), (d - nose, w - nose), (d - nose, -nose)], (-nose, -nose)
    if kind == "face_groove":  # the inner corner's nose centre; the blade points -z, its width across in x
        w, d = float(insert["width_mm"]), float(insert["depth_mm"])
        return [(-nose, -nose), (w - nose, -nose), (w - nose, d - nose), (-nose, d - nose)], (-nose, -nose)
    if kind == "thread":       # on its centre line: the tip a nose radius toward the axis
        d, half = float(insert["depth_mm"]), math.radians(float(insert["profile_angle_deg"])) / 2
        return [(-nose, 0.0), (d - nose, d * math.tan(half)), (d - nose, -d * math.tan(half))], (-nose, 0.0)
    if kind == "drill":        # its tip on the axis; the flutes run toward +z
        r, flutes = float(insert["diameter_mm"]) / 2, float(insert["flute_length_mm"])
        angle = math.radians(float(insert["point_angle_deg"])) / 2
        cone = 0.0 if angle >= math.pi / 2 - 1e-9 else r / math.tan(angle)
        return [(0.0, 0.0), (r, cone), (r, flutes), (-r, flutes), (-r, cone)], (0.0, 0.0)
    return [], (0.0, 0.0)


def tool_summaries(turning):
    """Each turret station's tool: its id, station and offset, what its insert is, and its insert's and holder's
    outlines relative to the point the program moves (the setup's `controlled_point`), in lathe coordinates (x the
    radius, z along the axis), mirrored as camlib mirrors them: x for a boring tool, z for a left-hand one."""
    out = []
    at_tip = turning.get("controlled_point", "tip") == "tip"
    for entry in turning["tools"]:
        tool = entry["tool"]
        sx = -1.0 if tool.get("side") == "inner" else 1.0
        sz = -1.0 if tool.get("hand") == "left" else 1.0
        insert, point = _insert_shape(tool)
        ox, oz = point if at_tip else (0.0, 0.0)
        place = lambda points: [[round(sx * (x - ox), 6), round(sz * (z - oz), 6)] for x, z in points]
        holder = _outline_points(tool["holder"]["outline"])
        if tool["insert"]["kind"] == "outline":   # the holder is drawn in the insert's own frame: move it with it
            cx, cz = tool["insert"]["outline"]["segments"][tool["insert"]["corner"]]["center_mm"]
            holder = [(x - cx, z - cz) for x, z in holder]
        body = tool.get("body") or {}
        out.append(dict(id=tool["id"], name=tool["id"], number=entry.get("number"), offset=entry.get("offset"),
                        turning=dict(insert=tool["insert"]["kind"], side=tool.get("side"), hand=tool.get("hand"),
                                     nose_radius_mm=tool.get("nose_radius_mm"), insert_outline=place(insert),
                                     holder_outline=place(holder), holder_y_mm=body.get("holder_y_mm"))))
    return out
