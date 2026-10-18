"""The automation contract artifact is exactly the reviewed source, minified safely.

dapp/public/contracts/project_escrow_automation.packed.py must decompress to
scripts/pack_escrow_min.minify(contracts/project_escrow_automation.py), whose
renaming is verified reversible; both hashes must match the values pinned in
dapp/src/workspace/artifact.js. The v2 contract and artifact are untouched.
"""

import base64
import hashlib
import re
import zlib
import ast
from pathlib import Path

from scripts.pack_escrow_min import minify, pack_min

ROOT = Path(__file__).resolve().parent
ARTIFACT = ROOT / "dapp/public/contracts/project_escrow_automation.packed.py"
SOURCE = ROOT / "contracts/project_escrow_automation.py"
PIN = (ROOT / "dapp/src/workspace/artifact.js").read_text()


def _pinned(name):
    block = PIN[PIN.index("AUTOMATION_ARTIFACT"):]
    return re.search(rf'{name}: "([0-9a-f]{{64}})"', block).group(1)


def test_hashes_match_the_pins():
    assert hashlib.sha256(ARTIFACT.read_bytes()).hexdigest() == _pinned("sha256")
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == _pinned("sourceSha256")


def test_artifact_is_the_minified_source():
    packed = ARTIFACT.read_text()
    source = SOURCE.read_text()
    assert packed.splitlines()[0] == source.splitlines()[0]
    blob = re.search(r"_b\.b85decode\((b'.*?')\)", packed).group(1)
    inner = zlib.decompress(base64.b85decode(ast.literal_eval(blob))).decode()
    compact, stats = minify(source)
    assert inner == compact
    assert stats["names_renamed"] > 100
    assert ARTIFACT.read_bytes() == pack_min(SOURCE.read_bytes())


def test_v2_contract_is_unchanged_by_the_automation_version():
    v2 = (ROOT / "contracts/project_escrow.py").read_bytes()
    assert hashlib.sha256(v2).hexdigest() == "d08f3398a5608c0bad2162ba0c25c774928ac7e4b8f2154c4571c06a198a5d11"
