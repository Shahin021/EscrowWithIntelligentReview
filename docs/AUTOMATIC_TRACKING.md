# Workspace v2 automatic receipt tracking

Based on reviewed workspace commit 4092e534430068901375accec7a17f8f6bbf4132.

The page now checks unresolved journal transactions every 15 seconds after the
previous pass completes. The polling uses the existing read-only resume path;
it never requests a wallet send, never releases an ambiguous forwarded request,
and never changes the journal format or identifiers. Visibility and connectivity
changes wake the poller. Hidden/offline tabs pause; reopening resumes from storage.
A closed browser cannot poll: the chain continues processing independently.

Activity shows the actual receipt status and network finality window. The window
comes from consensusData.canFinalize using the latest block timestamp via eth_call.
Zero means no deadline scheduled. A completed countdown is never treated as proof
of finality. Estimates older than 90 seconds are labelled stale. Timing read errors
do not prevent receipt tracking. A final receipt must still pass recipient,
consensus and execution checks; finalized execution failures remain failures.

Final receipts trigger a project refresh, deferred while the user is editing a
form or sending a transaction. Manual controls remain available. Nothing signs
a subsequent action automatically. This does not reduce network waiting periods.

Validation: 207 frontend tests passed; production build passed. Six new tests
cover non-overlap, pause/wake, transient errors, real consensus ABI encoding,
zero/stale/elapsed deadlines, and durable-journal resume to execution failure.
No live RPC verification or wallet signing was performed in this environment.

This update does not change contracts, packed deployment artifacts, workflows,
previous evidence, main, or the published site. Configurable evidence-recovery
windows remain a separate contract change and are not part of this patch.
