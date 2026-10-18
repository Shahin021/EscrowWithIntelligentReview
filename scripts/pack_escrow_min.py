"""Pack a contract like scripts/pack_escrow.py, plus safe local-name shortening.

Used for contracts/project_escrow_automation.py, whose extra code would
otherwise push the deployment over Bradbury's observed per-transaction gas
cap. scripts/pack_escrow.py and the v2 artifact are unchanged.

Only function-local variable names are renamed. Parameters, attributes, state
fields, module names, builtins, keyword arguments and public method signatures
are never touched. A function is skipped entirely (left as written) if it
contains anything that makes local renaming unsafe: nested functions or
lambdas, class definitions, global/nonlocal, star-imports, or any call to
locals/vars/eval/exec/globals. The result is verified by renaming back and
comparing the AST with the docstring-stripped original.
"""

import argparse
import ast
import base64
import builtins
import zlib
from pathlib import Path

from scripts.pack_escrow import _RemoveDocstrings, pack_source

UNSAFE_CALLS = {"locals", "vars", "eval", "exec", "globals", "compile", "__import__"}


def _unsafe(fn):
    for node in ast.walk(fn):
        if node is fn:
            continue
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef,
                             ast.Global, ast.Nonlocal, ast.Import, ast.ImportFrom)):
            return True
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in UNSAFE_CALLS:
            return True
    return False


class _RenameLocals(ast.NodeTransformer):
    """Rename each function's locals to _0, _1, ... (per function).

    Restarting the sequence in every function is safe because only functions
    without nested scopes are renamed, so a local can never be read from
    another function; it also compresses far better than unique names.
    """

    def __init__(self, reserved):
        self.reserved = reserved
        self.maps = []  # per renamed function, in traversal order: {old: new}
        self.skipped = []

    def visit_FunctionDef(self, fn):
        if _unsafe(fn):
            self.skipped.append(fn.name)
            self.maps.append(None)
            return fn

        params = {a.arg for a in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs}
        for extra in (fn.args.vararg, fn.args.kwarg):
            if extra:
                params.add(extra.arg)

        local_names = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                local_names.add(node.id)
            if isinstance(node, ast.ExceptHandler) and node.name:
                local_names.add(node.name)
        local_names -= params

        mapping = {}
        counter = 0
        for name in sorted(local_names):
            while f"_{counter}" in self.reserved:
                counter += 1
            mapping[name] = f"_{counter}"
            counter += 1

        for node in ast.walk(fn):
            if isinstance(node, ast.Name) and node.id in mapping:
                node.id = mapping[node.id]
            if isinstance(node, ast.ExceptHandler) and node.name in mapping:
                node.name = mapping[node.name]

        self.maps.append(mapping)
        return fn

    visit_AsyncFunctionDef = visit_FunctionDef


def _functions(tree):
    """Top-level and method FunctionDefs in a stable order (what the renamer visits)."""
    out = []

    def walk(body):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append(node)
            elif isinstance(node, ast.ClassDef):
                walk(node.body)
            elif isinstance(node, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
                for field in ("body", "orelse", "finalbody"):
                    walk(getattr(node, field, []) or [])
                for handler in getattr(node, "handlers", []) or []:
                    walk(handler.body)

    walk(tree.body)
    return out


def _reserved_names(tree):
    names = set(dir(builtins))
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.alias):
            names.add(node.asname or node.name.split(".")[0])
    return names


def minify(text):
    """Return (minified source, stats). Raises if verification fails."""
    stripped = ast.fix_missing_locations(_RemoveDocstrings().visit(ast.parse(text, filename="/contract.py")))

    tree = ast.parse(ast.unparse(ast.fix_missing_locations(stripped)))
    renamer = _RenameLocals(_reserved_names(tree))
    tree = renamer.visit(tree)
    compact = ast.unparse(ast.fix_missing_locations(tree)) + "\n"

    # Verify: on a fresh parse, undo each function's mapping and compare the
    # whole module with the docstring-stripped original.
    check = ast.parse(compact)
    functions = _functions(check)
    if len(functions) != len(renamer.maps):
        raise AssertionError("function count changed")

    renamed = 0
    for fn, mapping in zip(functions, renamer.maps):
        if not mapping:
            continue
        inverse = {new: old for old, new in mapping.items()}
        if len(inverse) != len(mapping):
            raise AssertionError(f"non-injective renaming in {fn.name}")
        renamed += len(inverse)
        for node in ast.walk(fn):
            if isinstance(node, ast.Name) and node.id in inverse:
                node.id = inverse[node.id]
            if isinstance(node, ast.ExceptHandler) and node.name in inverse:
                node.name = inverse[node.name]

    if ast.dump(ast.parse(ast.unparse(check))) != ast.dump(ast.parse(ast.unparse(stripped))):
        raise AssertionError("renaming is not reversible to the original AST")

    return compact, {
        "functions_renamed": sum(1 for m in renamer.maps if m is not None),
        "functions_skipped": renamer.skipped,
        "names_renamed": renamed,
    }


def pack_min(source: bytes) -> bytes:
    text = source.decode("utf-8")
    header = text.splitlines()[0]
    pack_source(source)  # same header validation as the standard packer
    compact, _stats = minify(text)
    encoded = base64.b85encode(zlib.compress(compact.encode(), level=9))
    return (header + "\nimport base64 as _b,zlib as _z\n"
            + f"exec(compile(_z.decompress(_b.b85decode({encoded!r})),"
            + "'/contract.py','exec',dont_inherit=True),globals())\n").encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source_path, output_path = Path(args.source), Path(args.output)
    if source_path.resolve() == output_path.resolve():
        parser.error("output must differ from source")
    source = source_path.read_bytes()
    packed = pack_min(source)
    _compact, stats = minify(source.decode("utf-8"))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(packed)
    print(f"{len(source)} -> {len(packed)} bytes: {output_path} {stats}")


if __name__ == "__main__":
    main()
