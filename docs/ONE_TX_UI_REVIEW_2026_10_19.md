# One-transaction UI review — 2026-10-19

Scope: the experimental `one-tx.html` app, its wallet session, form preflight,
tracking integration and the optional last-moment validation hook in sender.js.
No contract, packed artifact, automation service, workflow, deployed site or
previous evidence changed. No live transactions or emails were sent here.

## Findings and fixes

- Connected wallet controls disagreed with the account state. Both controls now
  show Disconnect; account selection is a separate Change account control.
- Explicit app disconnect did not exist. It now clears the signer/guard, cancels
  stale connection responses and survives reload. Passive restoration never
  requests signatures/permissions or overrides an explicit disconnect. This is
  app disconnection; it does not revoke MetaMask's site permission or the
  contract's existing technical grants. Background tracking continues.
- Account locking, account changes and network changes now clear stale signer
  state and disable submit. Explicit connection handles its own network-switch
  events without losing the final account returned by MetaMask.
- Earlier project-term reads could overwrite a newer project input. Each read
  has an identity/revision check before populating the delivery form.
- Account/form changes during estimates and delivery preflight now invalidate
  the result. An optional synchronous assertCurrent hook rechecks consent at
  the final forwarding boundary, before the wallet receives a transaction.
- Double clicks are locked before preflight, rather than only during send.
  Unresolved/accepted worker submissions disable Submit after response loss or
  successful recording; they cannot be re-sent from that button.
- Worker preflight now checks the final contract's evidence allowlist, prefix
  boundaries, URL syntax/length, missing entries, Unicode and bundle size.
  Notes are capped at 500 characters, matching the active review's existing
  _append_attempt limit (the bundle's broader 2000 limit was insufficient).
- Form errors appear next to each action, not only above the page.
- Missing/corrupt browser storage no longer breaks app boot and cannot enable
  writes. The strict journal still refuses writes if durability later fails.
- Service HTTP reads have bounded waits; one tracking failure does not hide
  other journal entries. A failed handoff never says background tracking was
  recorded. Wallet requests themselves are not timed out or retried.
- Check status remains manual. No 15-second interval was reintroduced.

## Validation

- Frontend: 269 tests passed; production build passed.
- Automation: 68 tests passed, unchanged service implementation.
- The actual main module was exercised with Happy DOM 21.0.3 and a simulated
  EIP-1193 wallet, RPC and sender: 21 scenarios passed. These are DOM flow
  checks, not graphical-browser rendering checks or Bradbury execution proof.
- Existing real genlayer-js boundary tests pass. A new test proves that a form
  invalidated at the forwarding boundary never reaches the wallet and remains
  correctly recorded as not sent.
- The UI lifecycle check fails on the earlier 1b9093b main module at the
  connected-button expectation, reproducing the reported bug.
- Manual-status/slow-read and saved-project DOM checks still pass.

## Reproduce the integrated DOM check (optional)

Install Happy DOM outside the application dependency tree, then point
ESCROW_AUDIT_DOM_MODULE to its absolute `lib/index.js` path. Example PowerShell:

```powershell
npm.cmd install --prefix "$env:TEMP\escrow-ui-qa" --no-save happy-dom@21.0.3
$env:ESCROW_AUDIT_DOM_MODULE = "$env:TEMP\escrow-ui-qa\node_modules\happy-dom\lib\index.js"
node.exe --experimental-vm-modules scripts/qa/one-tx-app-audit.mjs
```

This check requires Node 24. It uses the existing dapp dependencies. It sends
nothing to Bradbury. `--baseline` runs the old main module to reproduce the
original label failure; a nonzero exit is expected for that mode.

## Still live-only

MetaMask's own extension window, Bradbury consensus timing and real SMTP
remain environment-dependent. The fixes do not shorten network finality,
change a contract or require redeploying the existing funded test project.
