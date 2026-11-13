"""Shop as code: the machines, controllers, tools, tool setups and fixtures a camlib program uses, written in Python.

A shop file (shop.py) makes `shop = Shop()` and adds items to it. Each item is a record identified by its `key`, so
renaming its `name` never breaks what uses it; a program reaches it as `shop.<key>`:

    from camlib_ui.shop import *

    shop = Shop()
    model = shop.add(MachineModel.mill("vmc_model", "Example VMC", travel=(500, 400, 400),
                                       spindle=Spindle(interface="bt30", max_rpm=12_000),
                                       changer=Changer.magazine(pockets=12, interface="bt30")))
    control = shop.add(Controller("control", "LinuxCNC", dialect="linuxcnc_cartesian_linear_v1",
                                  rapid_behavior="linear", work_offsets=[1, 2, 3, 4, 5, 6]))
    vmc = shop.add(Machine("vmc", "Example VMC", model=model, controller=control))
    em6 = shop.add(EndMill("em6", "6 mm end mill", diameter=6, flutes=3, flute_length=18, overall_length=50))
    er = shop.add(Holder("bt30_er20", "BT30 ER20 holder", input_interface="bt30", output_interface="cylindrical_shank", ...))
    t1 = shop.add(Tool("t_em6", "6 mm end mill in ER20", cutter=em6, holders=[er], stickout=22))
    shop.add(ToolSetup("rack", "Everyday rack", tools={1: t1}))

Items refer to each other directly (model=x7_model); adding an item adds the items it uses. `Record(kind, key, {...})`
writes any record field by field, for what the helpers don't cover (a fixture, a sheet cutting recipe). A fixture
component's `geometry_source` is {"file": "<part file next to shop.py>", "body": "<body name>"}. Lengths are
millimetres, angles radians, speeds RPM. (From STEVE Studio's shop as code.)
"""
from __future__ import annotations

import copy
import math
import re
import sys
from typing import Any

__all__ = ["Shop", "Item", "Record", "MachineModel", "Spindle", "Changer", "Controller", "Machine", "Cutter", "EndMill",
           "BallEndMill", "BullEndMill", "Drill", "ChamferMill", "FaceMill", "ShellMill", "Reamer", "Tap", "ThreadMill",
           "BoringBar", "Inserts", "Holder", "Tool", "ToolSetup", "Material", "Preset", "Post"]

KEY = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$")
IDENTITY = {"origin_mm": [0.0, 0.0, 0.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "z": [0.0, 0.0, 1.0]}


def _caller() -> tuple[str, int]:
    """The shop source file and line that made an item (errors point there)."""
    frame = sys._getframe(2)   # frame walking, not inspect.stack(): no source lookups (fast, and safe in any module)
    while frame is not None:
        name = frame.f_code.co_filename
        if not name.endswith(("camlib_ui/shop.py", "camlib_ui\\shop.py")):
            return name, frame.f_lineno
        frame = frame.f_back
    return "?", 0


class Item:
    """One library record in the shop: its kind, its stable key and its definition (the library record's fields)."""

    kind: str = ""

    def __init__(self, key: str, definition: dict[str, Any], kind: str | None = None):
        if not isinstance(key, str) or not KEY.match(key):
            raise ValueError(f"{key!r} isn't a valid key: start with a letter; letters, digits, _ and - only; at most 64.")
        self.key = key
        self.kind = kind or self.kind
        self.definition = {"kind": self.kind, **definition}
        self.file, self.line = _caller()

    @property
    def name(self) -> str:
        return str(self.definition.get("name", self.key))

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.key!r}, kind={self.kind!r})"

    def clone(self, key: str, name: str | None = None, **changes) -> "Item":
        """A copy of this item under your own key, with `changes` applied: a catalogue machine, controller or tool made
        yours. Nested settings merge: spindle={"max_rpm": 10_000} changes the first spindle's speed only (and a new
        "interface" moves the spindle mount with it); other dict fields merge key by key; anything else replaces the
        field (tool_change=Changer.magazine(...) replaces the changer). Items it uses (a machine's model) stay as they
        are: clone those too and pass them, e.g. model=my_model. The copy is yours: shop.add it."""
        definition = {k: (v if isinstance(v, Item) else copy.deepcopy(v)) for k, v in self.definition.items() if k != "kind"}
        if name is not None:
            definition["name"] = name
        for field, value in changes.items():
            if field == "spindle" and isinstance(value, dict) and definition.get("spindles"):
                spindle = {**definition["spindles"][0], **value}
                definition["spindles"] = [spindle, *definition["spindles"][1:]]
                if "interface" in value:
                    spindle["interface"] = str(value["interface"]).lower()
                    for attachment in definition.get("attachments", []):
                        if attachment.get("id") == spindle.get("attachment"):
                            attachment["interface"] = spindle["interface"]
            elif isinstance(value, dict) and isinstance(definition.get(field), dict) and not isinstance(value, Item):
                definition[field] = {**definition[field], **value}
            else:
                definition[field] = value
        # A changer swapped in (e.g. a magazine on a machine sold with manual changes) brings the mount its pockets use.
        stations = (definition.get("tool_change") or {}).get("stations") or []
        mounts = {a.get("id") for a in definition.get("attachments", [])}
        if "tool_change" in changes:
            # A new changer's pockets take the mount they use with them (a BT40 magazine on a model sold with BT30).
            for attachment in definition.get("attachments", []):
                interfaces = {s.get("interface") for s in stations if s.get("attachment") == attachment.get("id") and s.get("interface")}
                if len(interfaces) == 1:
                    attachment["interface"] = interfaces.pop()
        for station in stations:
            if station.get("attachment") not in mounts:
                definition.setdefault("attachments", []).append({"id": station["attachment"], "node": "base", "role": "tool",
                                                                 "frame": IDENTITY, "interface": station.get("interface")})
                mounts.add(station["attachment"])
        clone = Item(key, definition, kind=self.kind)
        clone.__class__ = type(self) if isinstance(self, Item) else Item
        return clone

    def _record(self) -> dict:
        """The record as the build sends it: references to other items as {"$ref": key}."""
        return {"key": self.key, "kind": self.kind, "definition": _refs(self.definition), "file": self.file, "line": self.line}


def _refs(value):
    if isinstance(value, Item):
        return {"$ref": value.key}
    if isinstance(value, dict):
        return {k: _refs(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_refs(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Shop values must be finite numbers.")
    return value


def _uses(value):
    """The items a definition refers to, in order."""
    if isinstance(value, Item):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _uses(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _uses(v)


def Record(kind: str, key: str, definition: dict[str, Any]) -> Item:
    """Any library record, field by field (the library's schema for `kind`); other items may stand where a pin goes."""
    return Item(key, dict(definition), kind=kind)


class Shop:
    """The shop a document builds: add() each item (the items it uses come along); the build saves them in dependency
    order."""

    def __init__(self):
        self._items: dict[str, Item] = {}

    def add(self, *items: Item) -> Item:
        """Adds items, and the items they use (a machine's model and controller, a tool's cutter and holders) that
        aren't added yet. Returns the last one given."""
        for item in items:
            if not isinstance(item, Item):
                raise TypeError(f"Shop.add takes shop items (Machine, Tool, …), not {type(item).__name__}.")
            for used in _uses(item.definition):
                self.add(used)
            if item.key in self._items and self._items[item.key] is not item:
                raise ValueError(f"Two shop items share the key {item.key!r}; keys must be unique in a shop.")
            self._items[item.key] = item
        return items[-1] if items else None

    def __getitem__(self, key: str) -> Item:
        return self._items[key]

    def __getattr__(self, key: str) -> Item:
        """`shop.<key>`: the item of that key."""
        items = self.__dict__.get("_items", {})
        if key not in items:
            raise AttributeError(f"The shop has no item {key!r}. Its keys: {', '.join(sorted(items)) or 'none'}.")
        return items[key]

    def items(self) -> list[Item]:
        return list(self._items.values())

    def records(self) -> list[dict]:
        """Every item, references by key, checked to point at items of this shop."""
        out = [item._record() for item in self._items.values()]
        known = set(self._items)

        def check(value, item):
            if isinstance(value, dict):
                if set(value) == {"$ref"}:
                    if value["$ref"] not in known:
                        raise ValueError(f"{item['key']} uses {value['$ref']!r}, which isn't added to the shop (shop.add it).")
                    return
                for v in value.values():
                    check(v, item)
            elif isinstance(value, list):
                for v in value:
                    check(v, item)
        for item in out:
            check(item["definition"], item)
        return out


# ---------------------------------------------------------------- machines

def Spindle(*, interface: str, max_rpm: float, min_rpm: float = 0, id: str = "main", reversible: bool = True,
            max_tool_diameter: float = 80, max_tool_length: float = 200, max_power_kw: float | None = None,
            max_torque_nm: float | None = None, max_tool_mass_kg: float | None = None) -> dict:
    """A cutting spindle: its taper or interface (e.g. "bt30", "cat40", "er20"), speed range and tool size limits."""
    return {"id": id, "role": "cutting", "interface": interface.lower(), "min_rpm": min_rpm, "max_rpm": max_rpm,
            "reversible": reversible, "max_power_kw": max_power_kw, "max_torque_nm": max_torque_nm,
            "max_tool_diameter_mm": max_tool_diameter, "max_tool_length_mm": max_tool_length, "max_tool_mass_kg": max_tool_mass_kg}


class Changer:
    """How tools get into the spindle: by hand, or from a magazine of numbered pockets."""

    @staticmethod
    def manual() -> dict:
        return {"mode": "manual", "stations": [], "pose": "home", "retract_pose": "home", "sequence": "explicit_poses"}

    @staticmethod
    def magazine(*, pockets: int, interface: str, max_tool_diameter: float = 80, max_tool_length: float = 200,
                 max_tool_mass_kg: float | None = None) -> dict:
        """An automatic changer (umbrella, carousel or arm) with pockets numbered 1..pockets; the controller manages
        the change motion."""
        if not isinstance(pockets, int) or pockets < 1:
            raise ValueError("A magazine needs a whole number of pockets, at least 1.")
        stations = [{"id": f"pocket_{n}", "attachment": "magazine", "interface": interface.lower(),
                     "max_tool_diameter_mm": max_tool_diameter, "max_tool_length_mm": max_tool_length,
                     **({"max_tool_mass_kg": max_tool_mass_kg} if max_tool_mass_kg is not None else {})}
                    for n in range(1, pockets + 1)]
        return {"mode": "magazine", "stations": stations, "pose": "home", "retract_pose": "home", "sequence": "controller_managed"}


class MachineModel(Item):
    """A make and model of machine: its axes and travel, spindle and tool changer (library kind machine_model)."""
    kind = "machine_model"

    def __init__(self, key: str, name: str, **fields):
        super().__init__(key, {"name": name, **fields})

    @classmethod
    def mill(cls, key: str, name: str, *, travel: tuple[float, float, float], spindle: dict, changer: dict | None = None,
             rapid: float = 6000, acceleration: float = 500, description: str = "", machine_type: str = "vertical_mill",
             z_down: bool = True) -> "MachineModel":
        """A 3-axis Cartesian mill: X, Y and Z travel in mm, a cutting spindle (Spindle(...)) and a changer
        (Changer.manual() or Changer.magazine(...)); rapid in mm/min. X runs 0..x and Y 0..y; Z runs -z..0 when z_down
        (the default), else 0..z. The machine's home pose (poses, its "home" entry) is X 0, Y 0 and Z at the top of its
        travel, where the spindle starts and tools change; work zero sits below it. To move home, clone the model with
        poses=[{"id": "home", "positions": [{"joint": "X", "value": ...}, {"joint": "Y", ...}, {"joint": "Z", ...}]}]."""
        x, y, z = (float(v) for v in travel)
        if min(x, y, z) <= 0:
            raise ValueError("Travel must be positive in X, Y and Z (mm).")

        def axis(nid, parent, direction, low, high):
            return {"id": nid, "parent": parent, "kind": "linear", "frame": IDENTITY, "axis": direction,
                    "limits": {"unit": "mm", "minimum": low, "maximum": high, "max_velocity_per_minute": rapid,
                               "max_acceleration_per_second2": acceleration}, "periodic": False}
        nodes = [{"id": "base", "parent": None, "kind": "fixed", "frame": IDENTITY, "axis": None, "limits": None, "periodic": False},
                 axis("X", "base", [1.0, 0.0, 0.0], 0.0, x), axis("Y", "X", [0.0, 1.0, 0.0], 0.0, y),
                 axis("Z", "Y", [0.0, 0.0, 1.0], -z if z_down else 0.0, 0.0 if z_down else z)]
        changer = changer or Changer.manual()
        attachments = [{"id": "table", "node": "base", "role": "workpiece", "frame": IDENTITY, "interface": None},
                       {"id": "spindle", "node": "Z", "role": "tool", "frame": IDENTITY, "interface": spindle["interface"]}]
        if changer.get("stations"):
            # The pockets hold tools: a tool attachment (on the frame), with the pockets' interface.
            attachments.append({"id": "magazine", "node": "base", "role": "tool", "frame": IDENTITY,
                                "interface": changer["stations"][0]["interface"]})
        return cls(key, name, description=description, machine_type=machine_type, processes=["milling"], nodes=nodes,
                   attachments=attachments,
                   # a mill homes Z at the top of its travel, whichever way its Z axis counts.
                   poses=[{"id": "home", "positions": [{"joint": "X", "value": 0.0}, {"joint": "Y", "value": 0.0},
                                                       {"joint": "Z", "value": 0.0 if z_down else z}]}],
                   home_pose="home", spindles=[{**spindle, "attachment": "spindle"}], tool_change=changer)


class Controller(Item):
    """A machine's control and the G-code it reads (library kind controller). `dialect` picks camlib's post
    (camlib_ui.program.POSTS)."""
    kind = "controller"

    def __init__(self, key: str, name: str, *, dialect: str, processes=("milling",), output_units: str = "mm", **fields):
        super().__init__(key, {"name": name, "dialect": dialect, "processes": list(processes), "output_units": output_units, **fields})


class Machine(Item):
    """A machine in the shop: a model with a controller fitted (library kind machine_instance)."""
    kind = "machine_instance"

    def __init__(self, key: str, name: str, *, model: Item, controller: Item, **fields):
        for label, value, kind in (("model", model, "machine_model"), ("controller", controller, "controller")):
            if not isinstance(value, Item) or value.kind != kind:
                raise TypeError(f"Machine {key}: {label} must be a {kind} item of this shop.")
        super().__init__(key, {"name": name, "model": model, "controller": controller, **fields})


# ---------------------------------------------------------------- tools

class Cutter(Item):
    """A cutting tool (library kind rotary_cutter). The subclasses fill the type and the usual defaults. `material` is
    the cutting material (edges or inserts); give `body_material` when the body differs, e.g. a steel-bodied face mill."""
    kind = "rotary_cutter"
    cutter_type = ""
    center_cutting = True
    mounting = "shank"

    def __init__(self, key: str, name: str, *, diameter: float, flutes: int | None = None, flute_length: float | None = None,
                 overall_length: float | None = None, shank_diameter: float | None = None, material: str = "carbide",
                 hand: str = "right", dimension_source: str = "catalog", mounting: str | None = None,
                 bore: float | None = None, key_slot: float | None = None, body_diameter: float | None = None,
                 body_height: float | None = None, body_material: str | None = None, inserts: dict | None = None, **fields):
        mounting = mounting or self.mounting
        if inserts is not None:
            # An indexable cutter: Inserts(...) gives the insert count and depth of cut, so flutes and
            # flute_length may be left out; given, they must match.
            fields["inserts"] = inserts
            flutes = inserts["count"] if flutes is None else flutes
            flute_length = inserts["max_depth_of_cut_mm"] if flute_length is None else flute_length
        if flutes is None or flute_length is None:
            raise TypeError(f"Cutter {key}: give flutes and flute_length (mm), or inserts=Inserts(...) for an indexable cutter.")
        if body_material is not None:
            # The body's material when it differs from the cutting material (material=), e.g. a steel-bodied
            # indexable face mill or a brazed-tip cutter.
            fields["body_material"] = body_material
        face = {"bore": bore, "key_slot": key_slot, "body_diameter": body_diameter, "body_height": body_height}
        if mounting == "face":
            # A shell or face mill on an arbor: seated on the arbor face, with no shank.
            if overall_length is not None or shank_diameter is not None:
                raise ValueError(f"Cutter {key}: a face-mounted cutter has no shank: give body_height (tip to the face that seats "
                                 "on the arbor) instead of overall_length and shank_diameter.")
            missing = [name for name in ("bore", "body_diameter", "body_height") if face[name] is None]
            if missing:
                raise TypeError(f"Cutter {key}: a face-mounted cutter needs {', '.join(missing)} (mm, from its drawing).")
            mount = {"mounting": "face", "bore_diameter_mm": bore, "body_diameter_mm": body_diameter, "body_height_mm": body_height,
                     **({"key_slot_width_mm": key_slot} if key_slot is not None else {})}
        else:
            if overall_length is None:
                raise TypeError(f"Cutter {key}: give overall_length (mm), or mounting=\"face\" with bore, body_diameter and "
                                "body_height for a shell or face mill that sits on an arbor.")
            if any(value is not None for value in face.values()):
                raise ValueError(f"Cutter {key}: bore, key_slot, body_diameter and body_height are for a face-mounted cutter "
                                 "(mounting=\"face\").")
            mount = {"overall_length_mm": overall_length,
                     "shank_diameter_mm": shank_diameter if shank_diameter is not None else diameter}
        definition = {"name": name, "cutter_type": fields.pop("cutter_type", self.cutter_type), "diameter_mm": diameter,
                      "flute_count": flutes, "cutting_length_mm": flute_length, **mount, "material": material,
                      "hand": hand, "center_cutting": fields.pop("center_cutting", self.center_cutting),
                      "dimension_source": dimension_source, **fields}
        super().__init__(key, definition)


class EndMill(Cutter):
    cutter_type = "flat_end_mill"


class BallEndMill(Cutter):
    cutter_type = "ball_end_mill"


class BullEndMill(Cutter):
    """A bull-nose end mill: give corner_radius_mm."""
    cutter_type = "bull_end_mill"


class FaceMill(Cutter):
    """A face mill: with a shank (overall_length), or on an arbor with mounting="face", bore, body_diameter and
    body_height (and key_slot, its drive-slot width)."""
    cutter_type = "face_mill"
    center_cutting = False


class ShellMill(FaceMill):
    """A shell or face mill that sits on an arbor's face: bore (takes the arbor's pilot), body_diameter, body_height
    (tip to the face that seats on the arbor) and key_slot (its drive-slot width, if it has one), in mm."""
    mounting = "face"


def Inserts(designation: str, *, count: int, corner_radius: float, lead_angle: float, max_depth: float, grade: str = "") -> dict:
    """An indexable cutter's inserts, for inserts= on a FaceMill, ShellMill or indexable EndMill: the
    designation as in the catalogue (kept as text, never read for sizes), the number of inserts (the cutter's flutes),
    their corner radius (mm, 0 if sharp), lead angle in degrees (90 square shoulder, 45 a 45° face mill) and maximum
    depth of cut (mm, the cutter's flute length), with an optional grade. The cutting material is the cutter's material=."""
    inserts = {"designation": designation, "count": count, "corner_radius_mm": corner_radius, "lead_angle_deg": lead_angle,
               "max_depth_of_cut_mm": max_depth}
    if grade:
        inserts["grade"] = grade
    return inserts


class Drill(Cutter):
    """A drill: point angle in degrees (118 by default)."""
    cutter_type = "drill"

    def __init__(self, key: str, name: str, *, point_angle: float = 118, flutes: int = 2, **fields):
        super().__init__(key, name, flutes=flutes, included_angle_rad=math.radians(point_angle), tip_diameter_mm=0, **fields)


class ChamferMill(Cutter):
    """A chamfer mill or V-bit: included angle in degrees."""
    cutter_type = "chamfer_mill"

    def __init__(self, key: str, name: str, *, angle: float = 90, tip_diameter: float = 0, **fields):
        super().__init__(key, name, included_angle_rad=math.radians(angle), tip_diameter_mm=tip_diameter, **fields)


class Reamer(Cutter):
    """A reamer: cuts at its diameter, not at its centre."""
    cutter_type = "reamer"
    center_cutting = False


class Tap(Cutter):
    """A tap: diameter is its nominal size; minor_diameter (the tap drill size) and pitch in mm, from its designation."""
    cutter_type = "tap"
    center_cutting = False

    def __init__(self, key: str, name: str, *, minor_diameter: float, pitch: float, **fields):
        super().__init__(key, name, minor_diameter_mm=minor_diameter, thread_pitch_mm=pitch, **fields)


class ThreadMill(Cutter):
    """A single-profile thread mill: diameter is its tooth's, flute_length the tooth height, on a neck of neck_length_mm
    and neck_diameter_mm."""
    cutter_type = "thread_mill"
    center_cutting = False


class BoringBar(Cutter):
    """A single-point boring bar: diameter is the diameter its insert cuts, flute_length the insert's length, on a bar
    of neck_diameter_mm reaching neck_length_mm beyond the insert."""
    cutter_type = "boring_bar"
    center_cutting = False

    def __init__(self, key: str, name: str, *, flutes: int = 1, **fields):
        super().__init__(key, name, flutes=flutes, **fields)


class Holder(Item):
    """A tool holder, adaptor or collet (library kind tool_holder): its machine-side and tool-side interfaces, outer
    profile (outer_profile) and clamp (clamp), as the library schema describes them. A shell-mill or face-mill arbor
    takes pilot and pilot_length (mm) instead of a clamp, with drive_key (key width), bolt (its thread, e.g. "M12") and
    bolt_head_height if it has them; output_frame is then the arbor face the cutter seats on."""
    kind = "tool_holder"

    def __init__(self, key: str, name: str, *, input_interface: str, output_interface: str, component_type: str = "holder",
                 dimension_source: str = "catalog", pilot: float | None = None, pilot_length: float | None = None,
                 drive_key: float | None = None, bolt: str | None = None, bolt_head_height: float | None = None, **fields):
        arbor = {"pilot_diameter_mm": pilot, "pilot_length_mm": pilot_length, "drive_key_width_mm": drive_key,
                 "bolt_thread": bolt, "bolt_head_height_mm": bolt_head_height}
        if any(value is not None for value in arbor.values()):
            if pilot is None or pilot_length is None:
                raise TypeError(f"Holder {key}: an arbor needs pilot (its diameter) and pilot_length, in mm from its drawing.")
            if fields.get("clamp") is not None:
                raise ValueError(f"Holder {key}: an arbor carries the cutter on its face (pilot=...), so it takes no clamp.")
            fields["face_mount"] = {name: value for name, value in arbor.items() if value is not None}
        super().__init__(key, {"name": name, "component_type": component_type, "input_interface": input_interface.lower(),
                               "output_interface": output_interface.lower(), "dimension_source": dimension_source, **fields})


def _check_mates(key: str, cutter: Item, holders: list[Item]) -> None:
    """The interface checks the library makes when it resolves a tool, made where the Tool is written: each
    holder's tool side is the next one's machine side, and the last one's is the cutter's shank (cylindrical_shank
    unless the cutter says otherwise)."""
    for parent, child in zip(holders, holders[1:]):
        out, into = parent.definition.get("output_interface"), child.definition.get("input_interface")
        if isinstance(out, str) and isinstance(into, str) and out != into:
            raise ValueError(f"Tool {key}: holder {parent.key} gives output_interface {out!r} but the next holder {child.key} "
                             f"takes input_interface {into!r}; they must be the same.")
    out = holders[-1].definition.get("output_interface")
    shank = cutter.definition.get("shank_interface", "cylindrical_shank")
    if isinstance(out, str) and isinstance(shank, str) and out != shank:
        default = "" if "shank_interface" in cutter.definition else " (the default)"
        raise ValueError(f"Tool {key}: holder {holders[-1].key} gives output_interface {out!r} but cutter {cutter.key} has "
                         f"shank_interface {shank!r}{default}; they must be the same. A collet, side-lock or shrink-fit "
                         f"holder grips a plain shank: use output_interface=\"cylindrical_shank\".")


class Tool(Item):
    """An assembled tool: a cutter in its holder stack (spindle side first) at a stick-out in mm (library kind
    tool_assembly). A face-mounted cutter (ShellMill) seats on its arbor's face: give no stickout."""
    kind = "tool_assembly"

    def __init__(self, key: str, name: str, *, cutter: Item, holders: list[Item], stickout: float | None = None,
                 dimension_source: str = "measured", **fields):
        if not isinstance(cutter, Item) or cutter.kind != "rotary_cutter":
            raise TypeError(f"Tool {key}: cutter must be a cutter item (EndMill, Drill, …) of this shop.")
        if not holders or any(not isinstance(h, Item) or h.kind != "tool_holder" for h in holders):
            raise TypeError(f"Tool {key}: holders must be one or more Holder items, spindle side first.")
        _check_mates(key, cutter, holders)
        face = cutter.definition.get("mounting") == "face"
        if face and stickout is not None:
            raise ValueError(f"Tool {key}: cutter {cutter.key} is face-mounted: it seats on the arbor face, so its stick-out is "
                             f"its body_height. Leave out stickout (it is {stickout}).")
        if not face and stickout is None:
            raise TypeError(f"Tool {key}: give stickout, the length in mm from the holder's mouth to the cutter tip.")
        uses = [{"id": "holder" if i == 0 else f"holder_{i + 1}", "holder": h} for i, h in enumerate(holders)]
        super().__init__(key, {"name": name, "holders": uses, "cutter": cutter,
                               **({"stickout_mm": stickout} if stickout is not None else {}),
                               "dimension_source": dimension_source, **fields})


class ToolSetup(Item):
    """The tools loaded for machining, by T number: {1: tool, 2: (tool, {"length_register": 2, ...})}. Any machine
    can use it; each tool is checked against the machine a program picks (library kind tool_setup)."""
    kind = "tool_setup"

    def __init__(self, key: str, name: str, *, tools: dict[int, Any] | None = None, assignments: list | None = None, **fields):
        if assignments is None:
            assignments = []
            for number, entry in sorted((tools or {}).items()):
                tool, extra = (entry if isinstance(entry, tuple) else (entry, {}))
                if not isinstance(tool, Item) or tool.kind != "tool_assembly":
                    raise TypeError(f"ToolSetup {key}: T{number} must be a Tool item of this shop.")
                extra = dict(extra)
                offsets = {"basis": "gauge_length", **extra.pop("offsets", {})}
                assignments.append({"id": extra.pop("id", f"T{number}"), "assembly": tool, "tool_number": int(number),
                                    "offsets": offsets, **extra})
        if not assignments:
            raise ValueError(f"ToolSetup {key}: load at least one tool.")
        super().__init__(key, {"name": name, "assignments": assignments, **fields})


def Material(key: str, name: str, **fields) -> Item:
    """A stock material (library kind machining_material)."""
    return Item(key, {"name": name, **fields}, kind="machining_material")


def Preset(key: str, name: str, **fields) -> Item:
    """Cutting data for a cutter in a material (library kind cutting_preset)."""
    return Item(key, {"name": name, **fields}, kind="cutting_preset")


def Post(key: str, name: str, **fields) -> Item:
    """A custom post processor (library kind post_processor); built-in posts come with executable controllers."""
    return Item(key, {"name": name, **fields}, kind="post_processor")


# ---------------------------------------------------------------- lathes
# A lathe in the shop: its model (MachineModel.lathe), its turning tools and the turret that holds them. Every value is
# camlib's own (camlib.turning: TurningTool, TurningInsert, TurningHolder, TurningSeat, TurnToolSetting), written here so
# a program reaches the tools as shop items; camlib_ui.program.tool() and station() map them field for field.

class TurningInsert:
    """A turning tool's insert, for TurningTool(insert=...): one of camlib's kinds, with camlib's own values (none has a
    default)."""

    @staticmethod
    def iso_code(code: str, *, holder: str | None = None, approach_angle: float | None = None) -> dict:
        """An ISO 1832 insert ("CNMG120408") on a holder: its ISO 5608 designation (`holder`, "PCLNR2525M12", which gives
        the approach angle) or the approach angle in degrees (camlib TurningInsert.iso_code)."""
        if (holder is None) == (approach_angle is None):
            raise TypeError("TurningInsert.iso_code: give holder= (an ISO 5608 designation) or approach_angle= (degrees).")
        insert = {"type": "iso_code", "code": str(code)}
        if holder is not None:
            insert["holder_code"] = str(holder)
        else:
            insert["approach_angle_deg"] = float(approach_angle)
        return insert

    @staticmethod
    def iso(*, included_angle: float, approach_angle: float, edge_length: float, nose_radius: float) -> dict:
        """A nose between two edges (camlib TurningInsert.iso): the included angle (80 C, 55 D, 35 V), the holder's
        approach angle, in degrees; the edge length and nose radius in mm."""
        return {"type": "iso", "included_angle_deg": float(included_angle), "approach_angle_deg": float(approach_angle),
                "edge_length_mm": float(edge_length), "nose_radius_mm": float(nose_radius)}

    @staticmethod
    def groove(*, width: float, depth: float) -> dict:
        """A grooving or parting blade (camlib GrooveInsert): its width and how deep it reaches, mm."""
        return {"type": "groove", "width_mm": float(width), "depth_mm": float(depth)}

    @staticmethod
    def face_groove(*, width: float, depth: float) -> dict:
        """A face grooving blade (camlib FaceGrooveInsert): its width across and how deep it reaches, mm."""
        return {"type": "face_groove", "width_mm": float(width), "depth_mm": float(depth)}

    @staticmethod
    def thread(*, profile_angle: float, depth: float) -> dict:
        """A threading insert (camlib ThreadInsert): its profile angle (60 metric and UN) and its reach beyond the nose."""
        return {"type": "thread", "profile_angle_deg": float(profile_angle), "depth_mm": float(depth)}

    @staticmethod
    def drill(*, diameter: float, point_angle: float, flute_length: float) -> dict:
        """A drill on the spindle axis (camlib DrillInsert): diameter, point angle (degrees) and flute length."""
        return {"type": "drill", "diameter_mm": float(diameter), "point_angle_deg": float(point_angle),
                "flute_length_mm": float(flute_length)}


class TurningHolder:
    """A turning tool's holder, for TurningTool(holder=...)."""

    @staticmethod
    def rectangle(*, width: float, length: float, offset: float, y: tuple[float, float]) -> dict:
        """camlib's rectangular holder (TurningHolder.rectangle): outside, a shank `width` along Z and `length` away
        from the cut, starting `offset` behind the insert's reach; a boring bar `width` across, its top `offset` under
        the nose centre, `length` out of the bore; a drill's chuck. `y`: its extent across the centre plane, (low, high)
        mm (an outside shank from its height below the cutting face up to its clamp)."""
        low, high = (float(v) for v in y)
        return {"shape": "rectangle", "width_mm": float(width), "length_mm": float(length), "offset_mm": float(offset),
                "y_mm": [low, high]}


class TurningTool(Item):
    """A turning tool as it sits in the turret (kind turning_tool): its insert (TurningInsert.…), the side it cuts
    ("outer", or "inner" for a boring tool) and its hand ("right": cuts toward the chuck), its holder
    (TurningHolder.rectangle) and, as camlib requires them, its body off the centre plane: `seat` (rake, inclination in
    degrees: the holder's catalogue page; not for a drill), `insert_thickness` and `insert_clearance` (mm, degrees; an
    ISO-coded insert has its code's), a blade's `front_clearance` and `side_clearance`, a face grooving blade's
    `curved_for_diameter` (its maker's (min, max) range). `nose_radius`: the corner radius of a blade or threading
    insert, 0 for a drill (an ISO insert states its own). Nothing has a default: camlib refuses a tool with a value
    missing, by name."""
    kind = "turning_tool"

    def __init__(self, key: str, name: str, *, insert: dict, side: str, hand: str, holder: dict,
                 nose_radius: float | None = None, seat: tuple[float, float] | None = None,
                 insert_thickness: float | None = None, insert_clearance: float | None = None,
                 front_clearance: float | None = None, side_clearance=None,
                 curved_for_diameter: tuple[float, float] | None = None, size_tolerance: tuple[float, float] | None = None,
                 **fields):
        if not isinstance(insert, dict) or "type" not in insert:
            raise TypeError(f"Turning tool {key}: insert must be a TurningInsert.… (iso_code, iso, groove, thread, drill).")
        if not isinstance(holder, dict) or holder.get("shape") != "rectangle":
            raise TypeError(f"Turning tool {key}: holder must be a TurningHolder.rectangle(...).")
        if side not in ("outer", "inner") or hand not in ("right", "left"):
            raise ValueError(f"Turning tool {key}: side is \"outer\" or \"inner\", hand \"right\" or \"left\".")
        definition = {"name": name, "insert": dict(insert), "side": side, "hand": hand, "holder": dict(holder)}
        optional = {"nose_radius_mm": nose_radius, "insert_thickness_mm": insert_thickness,
                    "insert_clearance_deg": insert_clearance, "insert_front_clearance_deg": front_clearance,
                    "insert_side_clearance_deg": side_clearance,
                    "seat": None if seat is None else {"rake_deg": float(seat[0]), "inclination_deg": float(seat[1])},
                    "curved_for_diameter_mm": None if curved_for_diameter is None else [float(v) for v in curved_for_diameter],
                    "insert_size_tolerance_mm": None if size_tolerance is None else [float(v) for v in size_tolerance]}
        definition.update({k: v for k, v in optional.items() if v is not None})
        super().__init__(key, {**definition, **fields})


class Turret(Item):
    """The turning tools in a lathe's turret, by station: {1: tool, 2: (tool, {"offset": 12})} (kind turret_setup). A
    station's offset register is its own number unless it says otherwise (the T word is T<station><offset>, T0101)."""
    kind = "turret_setup"

    def __init__(self, key: str, name: str, *, tools: dict[int, Any], **fields):
        stations = []
        for number, entry in sorted((tools or {}).items()):
            tool, extra = (entry if isinstance(entry, tuple) else (entry, {}))
            if not isinstance(tool, Item) or tool.kind != "turning_tool":
                raise TypeError(f"Turret {key}: station {number} must be a TurningTool item of this shop.")
            if not isinstance(number, int) or isinstance(number, bool) or number < 1:
                raise ValueError(f"Turret {key}: stations are numbered from 1.")
            stations.append({"station": number, "tool": tool, "offset": int(dict(extra).get("offset", number))})
        if not stations:
            raise ValueError(f"Turret {key}: load at least one tool.")
        super().__init__(key, {"name": name, "stations": stations, **fields})


def _lathe_model(cls, key: str, name: str, *, x_travel: tuple[float, float], z_travel: tuple[float, float],
                 max_rpm: float, stations: int, rapid: float, acceleration: float = 500, description: str = "") -> "MachineModel":
    """A two-axis lathe: the cross slide's X travel (min, max) in mm as a radius from the spindle axis (X+ away from the
    axis, toward the tool: camlib's lathe premise) and the carriage's Z travel (min, max) along it, in machine
    coordinates; the work spindle's top speed; the turret's stations; rapid in mm/min. camlib has no default for any of
    them."""
    (x0, x1), (z0, z1) = (tuple(float(v) for v in x_travel), tuple(float(v) for v in z_travel))
    if not (x0 < x1 and z0 < z1):
        raise ValueError("A lathe's travel is (min, max) in X (radius) and in Z, min below max.")
    if not isinstance(stations, int) or isinstance(stations, bool) or stations < 1:
        raise ValueError("A turret needs a whole number of stations, at least 1.")

    def axis(nid, parent, direction, low, high):
        return {"id": nid, "parent": parent, "kind": "linear", "frame": IDENTITY, "axis": direction,
                "limits": {"unit": "mm", "minimum": low, "maximum": high, "max_velocity_per_minute": rapid,
                           "max_acceleration_per_second2": acceleration}, "periodic": False}
    nodes = [{"id": "base", "parent": None, "kind": "fixed", "frame": IDENTITY, "axis": None, "limits": None, "periodic": False},
             axis("Z", "base", [0.0, 0.0, 1.0], z0, z1), axis("X", "Z", [1.0, 0.0, 0.0], x0, x1)]
    return cls(key, name, description=description, machine_type="lathe", processes=["turning"], nodes=nodes,
               attachments=[{"id": "chuck", "node": "base", "role": "workpiece", "frame": IDENTITY, "interface": None},
                            {"id": "turret", "node": "X", "role": "tool", "frame": IDENTITY, "interface": None}],
               spindles=[{"id": "main", "role": "work", "attachment": "chuck", "min_rpm": 0, "max_rpm": float(max_rpm),
                          "reversible": True}],
               tool_change={"mode": "turret", "stations": [{"id": f"station_{n}", "attachment": "turret"}
                                                           for n in range(1, stations + 1)]})


MachineModel.lathe = classmethod(_lathe_model)
__all__ += ["TurningInsert", "TurningHolder", "TurningTool", "Turret"]


# ---------------------------------------------------------------- plasma and laser tables
# A cutting table in the shop: its model with its torch or laser head (MachineModel.table), and a cutting recipe per
# material and thickness. camlib_ui.program.head() and cutting() map them to camlib's Torch or LaserHead and to a
# ThermalCut's process values; nothing here has a default that stands in for a machine's or a cut chart's value.

class CuttingHead:
    """A table's cutting head, for MachineModel.table(head=...): what camlib checks against the work (its nozzle and
    body, as cylinders up from the tip, mm: the maker's drawing or a measurement)."""

    @staticmethod
    def plasma(id: str, *, nozzle_diameter: float, nozzle_length: float, body_diameter: float, body_length: float) -> dict:
        return {"id": id, "process": "plasma", "nozzle_diameter_mm": float(nozzle_diameter),
                "nozzle_length_mm": float(nozzle_length), "body_diameter_mm": float(body_diameter),
                "body_length_mm": float(body_length)}

    @staticmethod
    def laser(id: str, *, nozzle_diameter: float, nozzle_length: float, body_diameter: float, body_length: float,
              max_power_w: float) -> dict:
        """A laser head: also its full power in watts (a recipe's power is posted as a share of it)."""
        return {"id": id, "process": "laser", "nozzle_diameter_mm": float(nozzle_diameter),
                "nozzle_length_mm": float(nozzle_length), "body_diameter_mm": float(body_diameter),
                "body_length_mm": float(body_length), "max_power_w": float(max_power_w)}


def _table_model(cls, key: str, name: str, *, travel: tuple[float, float, float], head: dict, rapid: float,
                 acceleration: float = 2000, description: str = "") -> "MachineModel":
    """A plasma or laser table: a gantry carrying one cutting head (CuttingHead.plasma or .laser) over X, Y and Z
    travel in mm (X 0..x, Y 0..y, Z -z..0: the head's mount at the top of its travel is machine Z 0), rapid in mm/min.
    The travel is the head mount's; camlib checks the torch tip's (that box lowered by the head's length)."""
    x, y, z = (float(v) for v in travel)
    if min(x, y, z) <= 0:
        raise ValueError("Travel must be positive in X, Y and Z (mm).")
    if not isinstance(head, dict) or head.get("process") not in ("plasma", "laser"):
        raise TypeError(f"Table {key}: head must be a CuttingHead.plasma(...) or CuttingHead.laser(...).")

    def axis(nid, parent, direction, low, high):
        return {"id": nid, "parent": parent, "kind": "linear", "frame": IDENTITY, "axis": direction,
                "limits": {"unit": "mm", "minimum": low, "maximum": high, "max_velocity_per_minute": rapid,
                           "max_acceleration_per_second2": acceleration}, "periodic": False}
    nodes = [{"id": "base", "parent": None, "kind": "fixed", "frame": IDENTITY, "axis": None, "limits": None, "periodic": False},
             axis("X", "base", [1.0, 0.0, 0.0], 0.0, x), axis("Y", "X", [0.0, 1.0, 0.0], 0.0, y),
             axis("Z", "Y", [0.0, 0.0, 1.0], -z, 0.0)]
    return cls(key, name, description=description, machine_type=f"{head['process']}_table", processes=[head["process"]],
               nodes=nodes,
               attachments=[{"id": "table", "node": "base", "role": "workpiece", "frame": IDENTITY, "interface": None},
                            {"id": "head_mount", "node": "Z", "role": "tool", "frame": IDENTITY, "interface": None}],
               cutting_heads=[{**head, "attachment": "head_mount"}], tool_change={"mode": "none", "stations": []})


MachineModel.table = classmethod(_table_model)


def CuttingRecipe(key: str, name: str, *, process: str, kerf: float, feed: float, cut_height: float, pierce_seconds: float,
                  pierce_radius: float, lead_in: float, lead_out: float, pierce_height: float | None = None,
                  clearance: float | None = None, power_w: float | None = None, **fields) -> Item:
    """What a torch or a laser does in one material at one thickness (library kind sheet_cutting_recipe): a line of
    its cut chart. `process` "plasma" or "laser"; the kerf it burns (mm), its feed (mm/min) and cut height (mm above
    the sheet), how long it pierces (s) and the radius its pierce splashes (mm from the pierce point: camlib keeps
    every pierce that far from the parts), the straight lengths of its lead in and lead out (mm). `pierce_height` and
    `clearance` (the travel height) are needed when the program moves Z itself (height_mode "program"); `power_w` is a
    laser's power for this cut."""
    if process not in ("plasma", "laser"):
        raise ValueError(f"Cutting recipe {key}: process is \"plasma\" or \"laser\".")
    settings = {"process": process, "kerf_mm": float(kerf), "feed_mm_min": float(feed), "cut_height_mm": float(cut_height),
                "pierce_seconds": float(pierce_seconds), "pierce_radius_mm": float(pierce_radius),
                "lead_in_mm": float(lead_in), "lead_out_mm": float(lead_out)}
    optional = {"pierce_height_mm": pierce_height, "clearance_mm": clearance, "power_w": power_w}
    settings.update({k: float(v) for k, v in optional.items() if v is not None})
    return Item(key, {"name": name, "settings": settings, **fields}, kind="sheet_cutting_recipe")


__all__ += ["CuttingHead", "CuttingRecipe"]
