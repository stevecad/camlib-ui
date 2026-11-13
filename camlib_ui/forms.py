"""What the program forms read (web/src/cam/forms*.ts, from STEVE Studio's camlib forms): a program's outline, camlib's
operation fields, and the shop's records.

- ``outline(code)``: program.py as data. Nothing runs: every top-level name with its value as syntax, UTF-16 spans (the
  browser replaces them in its JavaScript strings directly) and the literal value where it has one. The forms decide
  what they can show; code they can't stays as it is and is edited in the code.
- ``operation_fields()``: camlib's milling and turning operations and their option objects, field by field from the installed camlib's own
  dataclasses ([name, type, default as Python source or None when required, keyword only]), so the forms always match
  the camlib that builds.
- ``python -m camlib_ui.forms shop <shop.py> <out.json>``: the shop's records (the forms' machines, tool setups and
  tools), in a child process like the part (shop.py is the project's code).
"""
from __future__ import annotations

import ast
import json
import math
import sys
from functools import lru_cache
from pathlib import Path

MAX_DEPTH = 40   # nesting the outline follows; deeper values are kept as code

# camlib's milling operations the forms write, and the option objects their fields hold.
OPERATIONS = ("Facing", "Pocket", "RestPocket", "AdaptivePocket", "Roughing", "RestRoughing", "Contour", "Chamfer", "VCarve",
              "Trace", "TrochoidalSlot", "Drilling", "Bore", "Reaming", "Tapping", "ThreadMilling", "Parallel", "Waterline",
              "Flat", "Scallop", "Pencil", "Spiral", "Radial", "Project", "Morph")
OPTIONS = ("HelicalEntry", "StockEdgeEntry", "RampEntry", "RasterClearing", "OffsetClearing", "AdaptiveClearing", "Tabs", "FineBore",
           "TraceSideOffset", "SmallHoles", "MicroJoints", "CommonLine")
# camlib's plasma and laser operations (a sheet setup's), which the forms write too.
THERMAL = ("ThermalCut", "ThermalMark")
# camlib's turning operations (camlib.turning: a lathe setup's), which the forms write too.
TURNING = ("TurnFace", "TurnRough", "TurnFinish", "TurnGroove", "TurnPartOff", "TurnThread", "TurnDrill", "TurnBoreRough",
           "TurnBoreFinish", "TurnFaceGroove")


# ── Outline ────────────────────────────────────────────────────────────────

MATH = {"pi": math.pi, "tau": math.tau, "e": math.e, "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan,
        "radians": math.radians, "degrees": math.degrees, "abs": abs, "min": min, "max": max, "hypot": math.hypot}
BINOPS = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b, ast.Div: lambda a, b: a / b,
          ast.FloorDiv: lambda a, b: a // b, ast.Mod: lambda a, b: a % b, ast.Pow: lambda a, b: a ** b}


class NotSimple(Exception):
    """An expression the evaluator won't evaluate (calls, attributes, comprehensions …)."""


def evaluate(node: ast.AST, env: dict):
    """Arithmetic over numbers, top-level number names and math (`math.pi` too); tuples, lists, strings, bools, None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float, str, bool, type(None))):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        raise NotSimple(f"unknown name {node.id}")
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "math" \
            and not callable(MATH.get(node.attr)) and node.attr in MATH:
        return MATH[node.attr]
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = evaluate(node.operand, env)
        return -value if isinstance(node.op, ast.USub) else +value
    if isinstance(node, ast.BinOp) and type(node.op) in BINOPS:
        return BINOPS[type(node.op)](evaluate(node.left, env), evaluate(node.right, env))
    if isinstance(node, ast.Call) and not node.keywords:
        name = node.func.attr if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) \
            and node.func.value.id == "math" else node.func.id if isinstance(node.func, ast.Name) else None
        if callable(MATH.get(name)):
            return MATH[name](*(evaluate(arg, env) for arg in node.args))
    if isinstance(node, (ast.Tuple, ast.List)):
        return [evaluate(item, env) for item in node.elts]
    raise NotSimple(type(node).__name__)


def _u16(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


class Source:
    """Offsets: ast gives (line, UTF-8 byte column); the browser wants UTF-16 offsets."""

    def __init__(self, code: str):
        self.code = code
        self.lines = code.splitlines(keepends=True)
        self.starts16 = []
        total = 0
        for line in self.lines:
            self.starts16.append(total)
            total += _u16(line)
        self.starts16.append(total)

    def offset(self, line: int, col_utf8: int) -> int:
        if line - 1 >= len(self.lines):
            return self.starts16[-1]
        prefix = self.lines[line - 1].encode("utf-8")[:col_utf8].decode("utf-8", errors="ignore")
        return self.starts16[line - 1] + _u16(prefix)

    def span(self, node: ast.AST) -> list[int]:
        return [self.offset(node.lineno, node.col_offset), self.offset(node.end_lineno, node.end_col_offset)]

    def statement_span(self, node: ast.stmt) -> list[int]:
        """Whole lines of a statement, including its trailing newline, for replacement."""
        return [self.starts16[node.lineno - 1], self.starts16[min(node.end_lineno, len(self.lines))]]

    def text(self, node: ast.AST) -> str:
        return ast.get_source_segment(self.code, node) or ""


def _dotted(node: ast.AST) -> str | None:
    """`shop.t_em10` → "shop.t_em10"; `camlib.operations.Pocket` → its dotted name; else None."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def value(node: ast.AST, src: Source, env: dict, depth: int = 0) -> dict:
    """One expression as data: its kind (`k`), span (`s`), source text and, where it has one, its literal value (`v`).
    Calls carry their function's dotted name, positional arguments and keywords (a `**` splat has key None); tuples
    and lists their items; dicts their keys and values; names and attributes their dotted name."""
    out: dict = {"s": src.span(node), "src": src.text(node)}
    if depth > MAX_DEPTH:
        return {**out, "k": "code"}
    try:
        literal = evaluate(node, env)
        if not isinstance(literal, float) or math.isfinite(literal):
            out["v"] = literal
    except (NotSimple, ArithmeticError, TypeError, ValueError, RecursionError):
        pass
    if isinstance(node, ast.Constant):
        kind = {bool: "bool", type(None): "none", str: "str"}.get(type(node.value), "num" if isinstance(node.value, (int, float)) else "code")
        return {**out, "k": kind}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant) \
            and isinstance(node.operand.value, (int, float)) and not isinstance(node.operand.value, bool):
        return {**out, "k": "num"}
    if isinstance(node, (ast.Name, ast.Attribute)) and _dotted(node):
        return {**out, "k": "name" if isinstance(node, ast.Name) else "attr", "name": _dotted(node)}
    if isinstance(node, ast.Call):
        keywords = [{"key": kw.arg, "s": src.span(kw), "value": value(kw.value, src, env, depth + 1)} for kw in node.keywords]
        return {**out, "k": "call", "f": _dotted(node.func), "a": [value(a, src, env, depth + 1) for a in node.args], "kw": keywords}
    if isinstance(node, (ast.Tuple, ast.List)):
        return {**out, "k": "tuple" if isinstance(node, ast.Tuple) else "list", "items": [value(e, src, env, depth + 1) for e in node.elts]}
    if isinstance(node, ast.Starred):
        return {**out, "k": "starred", "item": value(node.value, src, env, depth + 1)}
    if isinstance(node, ast.Dict):
        return {**out, "k": "dict", "keys": [None if k is None else value(k, src, env, depth + 1) for k in node.keys],
                "values": [value(v, src, env, depth + 1) for v in node.values]}
    return {**out, "k": "expr" if "v" in out else "code"}


def outline(code: str) -> dict:
    """program.py as data (module docstring). A syntax error comes back as {"ok": false, "error": {message, line}}."""
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        return {"version": 1, "ok": False, "error": {"message": error.msg or "Invalid Python.", "line": error.lineno or 0}}
    src = Source(code)
    env: dict = {}   # top-level numbers (parameters), for literal values of expressions that use them
    imports, statements, bindings = [], [], {}
    for index, stmt in enumerate(tree.body):
        entry = {"index": index, "s": src.statement_span(stmt), "line": stmt.lineno, "end_line": stmt.end_lineno}
        if isinstance(stmt, ast.ImportFrom) and stmt.level == 0 and stmt.module:
            entry.update(kind="import", module=stmt.module, names=[{"name": a.name, "as": a.asname} for a in stmt.names])
            imports.append(entry)
        elif isinstance(stmt, ast.Import):
            entry.update(kind="import", module=None, names=[{"name": a.name, "as": a.asname} for a in stmt.names])
            imports.append(entry)
        elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str) and index == 0:
            entry.update(kind="docstring")
        elif isinstance(stmt, (ast.Assign, ast.AnnAssign)) and getattr(stmt, "value", None) is not None:
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            names = []
            whole = value(stmt.value, src, env)
            for target in targets:
                if isinstance(target, ast.Name):
                    names.append(target.id)
                    bindings[target.id] = {"statement": index, "value": whole}
                elif isinstance(target, ast.Tuple) and isinstance(stmt.value, ast.Tuple) and len(target.elts) == len(stmt.value.elts) \
                        and all(isinstance(t, ast.Name) for t in target.elts):
                    # `a, b = tool(shop.x), tool(shop.y)`: each name with its own item.
                    for t, item in zip(target.elts, whole["items"]):
                        names.append(t.id)
                        bindings[t.id] = {"statement": index, "value": item, "unpacked": True}
                else:
                    names.extend(n.id for n in ast.walk(target) if isinstance(n, ast.Name))
            entry.update(kind="assign", names=names, value=whole)
            # Numbers become parameters; anything else assigned to a name stops being one.
            for name in names:
                env.pop(name, None)
            if len(targets) == 1 and isinstance(targets[0], ast.Name):
                try:
                    number = evaluate(stmt.value, env)
                    if isinstance(number, (int, float)) and not isinstance(number, bool):
                        env[targets[0].id] = number
                except (NotSimple, ArithmeticError, TypeError, ValueError, RecursionError):
                    pass
        else:
            entry.update(kind="other", names=sorted({t.id for t in ast.walk(stmt) if isinstance(t, ast.Name) and isinstance(t.ctx, ast.Store)}))
            for name in entry["names"]:
                bindings.pop(name, None)
                env.pop(name, None)
        statements.append(entry)
    return {"version": 1, "ok": True, "statements": statements, "imports": imports, "bindings": bindings,
            "parameters": {k: v for k, v in env.items() if isinstance(v, (int, float))}}


# ── camlib's fields ────────────────────────────────────────────────────────

def _type(annotation) -> str:
    text = str(annotation)
    return text[8:-2] if text.startswith("<class '") else text


@lru_cache(maxsize=1)
def operation_fields() -> dict:
    """Each operation's and option object's fields in camlib's order: [name, type, default as Python source (None:
    required), keyword only], from the installed camlib's dataclasses (a camlib that lacks one leaves it out)."""
    import dataclasses
    import camlib.operations as operations
    import camlib.turning as turning
    out = {}
    for name in (*OPERATIONS, *OPTIONS, *THERMAL, *TURNING):
        cls = getattr(turning if name in TURNING else operations, name, None)
        if cls is None or not dataclasses.is_dataclass(cls):
            continue
        fields = []
        for field in dataclasses.fields(cls):
            if field.default is not dataclasses.MISSING:
                default = repr(field.default)
            elif field.default_factory is not dataclasses.MISSING:   # e.g. a tuple default: camlib's own value
                default = repr(field.default_factory())
            else:
                default = None
            fields.append([field.name, _type(field.type), default, bool(field.kw_only)])
        out[name] = fields
    return out


# ── The shop's records ─────────────────────────────────────────────────────

def shop_records(path: Path) -> list[dict]:
    """shop.py's records (it runs: call this in a child process)."""
    from camlib_ui.shop import Shop
    namespace = {"__name__": "__shop__", "__file__": str(path)}
    exec(compile(path.read_text(), str(path), "exec"), namespace)
    shop = namespace.get("shop")
    if not isinstance(shop, Shop):
        raise ValueError(f"{path.name} must make `shop = Shop()` (from camlib_ui.shop import *).")
    return [{key: record[key] for key in ("key", "kind", "definition")} for record in shop.records()]


def main(argv):
    """python -m camlib_ui.forms shop <shop.py> <out.json>: shop_records as {"ok": true, "records": [...]}."""
    if len(argv) != 3 or argv[0] != "shop":
        sys.exit("python -m camlib_ui.forms shop <shop.py> <out.json>")
    try:
        data = {"ok": True, "records": shop_records(Path(argv[1]))}
        raw = json.dumps(data, allow_nan=False, separators=(",", ":"))
    except Exception as error:  # noqa: BLE001  The shop's own error is the answer.
        import traceback
        raw = json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}", "trace": traceback.format_exc()[-6000:]})
    Path(argv[2]).write_text(raw)


if __name__ == "__main__":
    main(sys.argv[1:])
