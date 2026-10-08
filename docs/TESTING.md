# Running the test suite

The V3 suite runs in gltest Direct Mode. Linux is authoritative, because CI
runs there, but the suite is now verified on Windows too.

## Toolchain

Pinned in `requirements-test.txt` and used by CI:

| Component | Version |
| --- | --- |
| Python | 3.12 |
| genlayer-py | 0.16.3 |
| genlayer-test | 0.29.2 |
| pytest | 9.1.1 |
| numpy | unpinned |
| GenVM bundle | `v0.2.12`, pinned in `conftest.py` as `GENVM_VERSION` |

The GenVM bundle (about 206 MB) is downloaded once into
`~/.cache/gltest-direct` on the first run, so expect that run to be slow.
CI caches it and verifies its SHA-256.

## Commands

Linux or WSL:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-test.txt
python -m pytest -q
```

Windows PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
.\.venv\Scripts\python.exe -m pytest -q
```

## Verified results

Each row names the commit it was run against. A result is not carried
forward to later commits.

| Platform | Commit | Suite | Shim tests | Date |
| --- | --- | --- | --- | --- |
| Windows | `2f107c6` | 356 / 356 passed | 9 / 9 passed | 2026-10-03 |
| Linux | `2f107c6` | 356 / 356 passed | 9 / 9 passed | 2026-10-03 |
| Linux | `1a6c24d` | 369 / 369 passed | 9 / 9 passed | 2026-10-03 |
| Windows | `1a6c24d` | 369 / 369 passed, finalization 13 / 13 | 9 / 9 passed | 2026-10-03 |
| Linux | `d9526e9` (Phase 3 freeze) | 416 / 416 passed | 9 / 9 passed | 2026-10-03 |
| Windows | `d9526e9` (Phase 3 freeze) | 416 / 416 passed, 0 failed, 0 skipped, in 13.00s | included in the suite | 2026-10-03 |
| Windows | `10abdf5` (Phase 4) | 482 / 482 passed, in 32.63s | included in the suite | 2026-10-03 |
| Linux | `b85f002` (Phase 6 prep) | 491 / 491 Python, 80 / 80 dApp | included in the suite | 2026-10-05 |
| Windows | `b85f002` (Phase 6 prep) | 491 / 491 Python, 80 / 80 dApp, `npm audit` 0 vulnerabilities, build OK on Node v24.18.0 | included in the suite | 2026-10-05 |

| Windows | `ae9bafe` (Phase 6 prep) | 83 / 83 dApp, `npm audit` 0 vulnerabilities, build OK | included in the suite | 2026-10-05 |
| Windows | `d053eef` (Phase 6 prep) | 499 / 499 Python | included in the suite | 2026-10-05 |
| Linux | Phase 6 review head | 503 / 503 Python, 83 / 83 dApp, `npm audit` 0, build OK | included in the suite | 2026-10-05 |

The Python total includes `test_deployment_rehearsal.py`, which runs the full
runbook in glsim rather than Direct Mode, and `test_deployment_prereqs.py`.

The newest rows cover `b85f002` and `ae9bafe`, the branch that reopens the Phase 3 freeze
with the funding split, interface v2 and the documentation sweep. Both
platforms ran the Python suite and the dApp suite; the Windows run used
`.\.venv\Scripts\python.exe -m pytest -q` and `npm test`.

The `10abdf5` row was recorded on the Phase 4 branch in a commit that landed
after the merge and so never reached `main`; it is restored here rather than
left missing.

Older rows are historical: each covers only the code at its own commit, and
none of them covers the current tree. Commits made after `b85f002` are
unverified on both platforms until their own run is recorded.

## Windows support

gltest 0.29.2 cannot run Direct Mode on Windows unaided: its stdin injector
unlinks the message temp file while file descriptor 0 still holds it open,
which Windows refuses with `PermissionError [WinError 32]`, so no test
reaches its contract assertions.

`windows_stdin_compat.py` fixes this inside the repository, with no edits to
`site-packages`. It installs its own injector, mirroring gltest's logic
exactly except that the temp file is deleted after gltest restores fd 0
rather than while fd 0 still refers to it. Nothing global is patched: no `os`
function is replaced, so deletions by unrelated threads are unaffected.
`UPSTREAM_SOURCE_SHA256` pins the upstream source the copy mirrors, and
`install()` raises rather than warning if gltest changes, so the suite can
never run against an unreconciled mirror.

The shim activates only on Windows. Set
`ESCROW_FORCE_WINDOWS_STDIN_COMPAT=1` to exercise its code path elsewhere;
that is for testing the shim itself and is not used in normal runs.

## Expected warning

Every run prints one warning from gltest, not from this project:

```text
WARNING: File `gltest.config.yaml` not found in the current directory,
using default config
```

It is harmless. The file selects between named networks, which Direct Mode
does not use; the default configuration is correct for this suite.
