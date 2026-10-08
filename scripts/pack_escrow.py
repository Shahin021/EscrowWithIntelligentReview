"""Build an optional compact deployment artifact; keep the contract intact."""

import argparse
import ast
import base64
import json
from pathlib import Path
import zlib


class _RemoveDocstrings(ast.NodeTransformer):
    def _body(self, node):
        self.generic_visit(node)
        if (node.body and isinstance(node.body[0], ast.Expr)
                and isinstance(node.body[0].value, ast.Constant)
                and isinstance(node.body[0].value.value, str)):
            node.body.pop(0)
            if not node.body:
                node.body.append(ast.Pass())
        return node

    visit_Module = _body
    visit_ClassDef = _body
    visit_FunctionDef = _body
    visit_AsyncFunctionDef = _body


def pack_source(source: bytes) -> bytes:
    """Preserve Depends and executable AST, removing comments/docstrings only.

    This changes source locations and __doc__. Keep the original file for
    review/debugging. Runtime support must be checked on the target network.
    """
    text = source.decode("utf-8")
    header = text.splitlines()[0]
    if not header.startswith("#"):
        raise ValueError("first line must contain the pinned Depends header")
    try:
        depends = json.loads(header[1:].strip())["Depends"]
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError("invalid Depends header") from exc
    if not isinstance(depends, str) or not depends.startswith("py-genlayer:"):
        raise ValueError("expected a pinned py-genlayer Depends header")
    tree = _RemoveDocstrings().visit(ast.parse(text, filename="/contract.py"))
    compact = (ast.unparse(ast.fix_missing_locations(tree)) + "\n").encode()
    encoded = base64.b85encode(zlib.compress(compact, level=9))
    return (header + "\nimport base64 as _b,zlib as _z\n"
            + f"exec(compile(_z.decompress(_b.b85decode({encoded!r})),"
            + "'/contract.py','exec',dont_inherit=True),globals())\n").encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="contracts/project_escrow.py")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source_path, output_path = Path(args.source), Path(args.output)
    if source_path.resolve() == output_path.resolve():
        parser.error("output must differ from source")
    source = source_path.read_bytes()
    packed = pack_source(source)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(packed)
    print(f"{len(source)} -> {len(packed)} bytes: {output_path}")


if __name__ == "__main__":
    main()
