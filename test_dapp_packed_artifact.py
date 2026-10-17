"""The contract code the workspace dApp deploys is the reviewed contract.

dapp/public/contracts/project_escrow.packed.py is what a browser deployment
sends. This checks, without GenVM, that it carries the same Depends header
and decompresses to exactly the executable AST of contracts/project_escrow.py
(comments and docstrings removed, as scripts/pack_escrow.py does), and that
its bytes match the SHA-256 pinned in dapp/src/workspace/artifact.js.
"""

import ast
import base64
import hashlib
import re
import zlib
from pathlib import Path

from scripts.pack_escrow import _RemoveDocstrings

ROOT = Path(__file__).resolve().parent
ARTIFACT = ROOT / "dapp/public/contracts/project_escrow.packed.py"
SOURCE = ROOT / "contracts/project_escrow.py"
PIN = ROOT / "dapp/src/workspace/artifact.js"


def _pinned(name):
    return re.search(rf'{name}: "([0-9a-f]{{64}})"', PIN.read_text()).group(1)


def test_artifact_bytes_match_the_pinned_hash():
    data = ARTIFACT.read_bytes()
    assert hashlib.sha256(data).hexdigest() == _pinned("sha256")
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == _pinned("sourceSha256")


def test_artifact_decompresses_to_the_reviewed_source():
    packed = ARTIFACT.read_text()
    source = SOURCE.read_text()
    assert packed.splitlines()[0] == source.splitlines()[0]  # pinned Depends header
    blob = re.search(r"_b\.b85decode\((b'.*?')\)", packed).group(1)
    inner = zlib.decompress(base64.b85decode(ast.literal_eval(blob))).decode()
    tree = _RemoveDocstrings().visit(ast.parse(source))
    expected = ast.unparse(ast.fix_missing_locations(tree)) + "\n"
    assert inner == expected
