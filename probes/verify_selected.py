from __future__ import annotations

import hashlib
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
MANIFEST = RESULTS / "SELECTED.sha256"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if not MANIFEST.exists():
        print(f"ERROR: manifest not found: {MANIFEST}")
        return 1

    failures = 0
    checked = 0

    for line_no, raw in enumerate(
        MANIFEST.read_text(encoding="ascii").splitlines(),
        1,
    ):
        line = raw.strip()

        if not line or line.startswith("#"):
            continue

        try:
            expected, name = line.split(None, 1)
        except ValueError:
            print(f"FAIL line {line_no}: malformed manifest entry")
            failures += 1
            continue

        name = name.strip()
        path = RESULTS / name

        if not path.is_file():
            print(f"FAIL {name}: missing")
            failures += 1
            continue

        actual = sha256_file(path)
        checked += 1

        if actual.lower() != expected.lower():
            print(f"FAIL {name}")
            print(f"  expected: {expected}")
            print(f"  actual:   {actual}")
            failures += 1
        else:
            print(f"OK   {name}")

    print()
    print(f"Checked: {checked}")
    print(f"Failures: {failures}")

    if failures:
        return 1

    print("SELECTED EVIDENCE VERIFIED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
