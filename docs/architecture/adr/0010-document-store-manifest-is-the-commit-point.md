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
drafts, retained history, the destination and its baseline witness. A mutation
flushes bytes and drafts before atomically replacing the manifest.

Undo and redo restore revisions in that directory; the caller retains the
revisions its history needs. In-place appends commit their length with `extend`.
Releasing an uncommitted append receipt cuts its tail, and `ownCurrentFile`
separates redo tails before a tool reads or writes an undone file.

One renderer writer per document starts a durable draft write when unsaved
annotations, editor text or metadata change. Drafts copy no PDF bytes. Save,
page operations, OCR apply, tab moves and close or quit preparation wait for
that writer; ordinary edits, undo and redo do not.

Save commits a snapshot, checks the destination, publishes it and acknowledges
it. A later annotation edit remains unsaved. Every renderer write to the
original awaits `saveToOriginalFile`'s copy decision; an inconclusive analysis
goes to Save As, while changed, unreadable or locked originals refuse with
their own reason. Save As publishes without the baseline check. A draft-only
document without private bytes builds its edits on the original as it is now,
so Save As can rescue them after an external change.

Desktop uses `file-v2:<size>:<mtimeNs>:<dev>:<ino>`, without a hash pass at open
or Save. Browser handle checks use size and millisecond modification time;
publication records the metadata and content hash of one snapshot after the
write. `pendingPublish` records the attempt before publication, including the
exact desktop sibling temporary path before creation. Recovery acknowledges
only a matching witness and removes only that recorded temporary file.
Unresolved attempts stay recorded even when a later Save As succeeds.

Recovery truncates uncommitted tails, removes unreferenced files and settles
pending publication. Workspace checkpoints name document directories and hold
per-view state. The Electron main process owns desktop directories; a browser
window holds a Web Lock per directory and uses OPFS through a storage worker.
Only storage and publication ports depend on the platform.

## Consequences

- A failed publication leaves the committed work recoverable.
- Drafts do not copy the saved file. Before a publish, a retained revision
  backed only by the unchanged destination is copied in to preserve undo.
- A desktop window pins the revision it parsed, such as the source of
  original text-box appearances, without copying it. The pin's bytes are
  copied out before a mutation, Save, undo or retention could change, cut or
  remove them. A destination is copied through one handle on the file that
  was admitted. A pin whose destination another program changed becomes
  unavailable instead of reading the changed bytes, and a Save that meets it
  refuses as `source-unavailable`. Revision 1 copied from a changed
  destination cannot be pinned. Only the pinning window reads a pin; no
  generic path check admits the pin folder.
- Desktop staged receipts and managed binary handles resolve by file
  identity, stat witness and revision on every platform. Only the byte pass
  that wrote or first read a file hashes it, and a receipt names the file its
  writer's open handle saw.
- One manifest replacement commits bytes and their drafts together, without a
  journal or a separate annotation-recovery tree.
- File metadata checks do not detect an in-place writer that restores size
  and modification time. Desktop identity checks do detect a replaced file.
  Browser download completion cannot be observed beyond dispatch. Browsers without durable storage keep documents in memory.
- The synchronous Windows metadata decision in
  [ADR 0001](0001-sync-fs-metadata-in-packaged-critical-paths.md) still applies.

## Revisit when

A supported storage or publication API cannot preserve the committed revision
or identify an interrupted publication under this model.
