"""
Guard for the accepted V2 contract.

escrow_contract.py is the source accepted for the Intelligent Contracts task
(commit c0a03dc; byte-identical to 42fa779, deployed on Bradbury at
0x38A6Dc8F960781fa109EF3Aa4A891689a64763Fe). V3 is built in new files and
must never modify it.

The check recomputes the Git blob hash from the working-tree bytes, so it
needs no git binary. CRLF is normalized to LF first because .gitattributes
(`* text=auto`) stores LF and a Windows checkout may convert line endings.
"""

import hashlib
from pathlib import Path

ACCEPTED_V2_BLOB = "7b391fa8ce384db50f9c525f7cfec8d0a588da4f"
V2_PATH = Path(__file__).parent / "escrow_contract.py"


def git_blob_sha1(data: bytes) -> str:
    header = b"blob " + str(len(data)).encode() + b"\0"
    return hashlib.sha1(header + data).hexdigest()


def test_v2_source_unchanged():
    data = V2_PATH.read_bytes().replace(b"\r\n", b"\n")
    assert git_blob_sha1(data) == ACCEPTED_V2_BLOB, (
        "escrow_contract.py differs from the accepted V2 source (c0a03dc). "
        "V3 work belongs in new files."
    )


def test_guard_detects_a_one_byte_change():
    data = V2_PATH.read_bytes().replace(b"\r\n", b"\n")
    assert git_blob_sha1(data + b" ") != ACCEPTED_V2_BLOB
