# ADR 0010: the document store manifest is the commit point

- Status: accepted

## Context

Document bytes, unsaved annotations and the destination's saved state need one
durability boundary across desktop, browser and extension. An interrupted write
must leave a committed revision available without reconstructing it from view
state. Publication can fail after edits have become durable, and another
program can change the destination.

## Decision

`packages/document-store` owns one directory per document. Its manifest is the
only commit point, naming revision files and their committed lengths, immutable
drafts, bounded history, the destination and its baseline witness. A mutation
flushes bytes and drafts before atomically replacing the manifest.

Save commits pending edits, checks the destination, publishes the committed
revision and acknowledges it. The destination check uses file size and
modification time; a touch or identical rewrite that changes either conflicts
and offers Save As. Save As publishes to its chosen destination without that
check. `pendingPublish` records the publication being attempted, so recovery
acknowledges it only when the destination matches its witness. Content witnesses
identify revision bytes and download receipts.

Recovery truncates uncommitted tails, removes unreferenced files and settles
pending publication. Workspace checkpoints name document directories and hold
per-view state. The Electron main process owns desktop directories; a browser
window holds a Web Lock per directory and uses OPFS through a storage worker.
Only storage and publication ports depend on the platform.

## Consequences

- A failed publication leaves the committed work recoverable.
- Saved files stay separate from private document revisions; Save publishes
  outward without reading the destination back into a revision.
- One manifest replacement commits bytes and their drafts together, without a
  journal or a separate annotation-recovery tree.
- File metadata checks do not detect a writer that restores both size and
  modification time. Browser download completion cannot be observed beyond
  dispatch. Browsers without durable storage keep documents in memory.
- The synchronous Windows metadata decision in
  [ADR 0001](0001-sync-fs-metadata-in-packaged-critical-paths.md) still applies.

## Revisit when

A supported storage or publication API cannot preserve the committed revision
or identify an interrupted publication under this model.
