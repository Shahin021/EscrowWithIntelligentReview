"""Packed bytes pin the separate contract; prior deployed bytes stay unchanged."""
import ast
import base64
import hashlib
import re
import zlib
from pathlib import Path
from scripts.pack_escrow_min import minify

ROOT=Path(__file__).parent

def test_one_tx_artifact_matches_reviewed_source_and_pins():
    source=(ROOT/'contracts/project_escrow_one_tx.py').read_bytes()
    artifact=(ROOT/'dapp/public/contracts/project_escrow_one_tx.packed.py').read_bytes()
    pins=(ROOT/'dapp/src/workspace/one-tx.js').read_text()
    assert hashlib.sha256(source).hexdigest() in pins
    assert hashlib.sha256(artifact).hexdigest() in pins
    assert len(artifact)==19241
    blob=ast.literal_eval(re.search(r"_b.b85decode\((b'.*?')\)",artifact.decode()).group(1))
    unpacked=zlib.decompress(base64.b85decode(blob)).decode()
    assert unpacked==minify(source.decode())[0]

def test_previous_contract_and_artifacts_are_unchanged():
    expected={
      'contracts/project_escrow.py':'d08f3398a5608c0bad2162ba0c25c774928ac7e4b8f2154c4571c06a198a5d11',
      'contracts/project_escrow_automation.py':'953ad9f33021d387bffb0772f234fc8e3049533489f2cfbdd0a9abb4dc90c8aa',
      'dapp/public/contracts/project_escrow.packed.py':'da2b18158ebf6e3aa72950b9bb8445aa6ac7305827cfe9409280d8313c772ed3',
      'dapp/public/contracts/project_escrow_automation.packed.py':'6b4c31631e561cee51166c01908bc6e19ac3184bbaa14e2a345cc9487586c187',
    }
    for file,sha in expected.items(): assert hashlib.sha256((ROOT/file).read_bytes()).hexdigest()==sha
