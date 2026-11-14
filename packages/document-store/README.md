# Document store

The shared durability core for desktop, browser and extension. The application
owns document identity, permissions and view state; this package owns committed
bytes and drafts. [ADR 0010](../../docs/architecture/adr/0010-document-store-manifest-is-the-commit-point.md)
records the decision.

## Directory and commit

Each `documents/<id>/` directory contains:

| Entry | Meaning |
| --- | --- |
| `manifest.json` | The only commit point: current revision, retained history, destination, baseline witness, pending publication and drafts reference. |
| `r<n>.<ext>` | Revision bytes, immutable within every length the manifest names. |
| `drafts-<uuid>.json` | Immutable annotations and metadata not yet written into the document bytes. |

A path-backed document can start without a revision file. Reads use its
destination until the first append needs private bytes; drafts never copy it,
and a rewrite supplies all its bytes. Append mutations flush an extended
revision (`extend` commits what a native tool appended to the current file
itself); rewrites flush a new file. Replacing the manifest commits the revision
and its kept, replaced or cleared drafts together. An imported rewrite, such as
the decrypted or repaired bytes a browser open makes of a document without a
file, also makes them the baseline, with no history, in that commit: an open
cut short leaves no unsaved work. A drafts-only change also
commits by replacing the manifest. Desktop tools read a revision file to its
end, so before such a tool runs and after an undo, `ownCurrentFile` moves redo
revisions that extend the current file to a copy and cuts what no revision
names. An in-place append is a lease: releasing its receipt without a commit
cuts its uncommitted tail, unless a later append owns the end.

Undo and redo call `restoreDocumentRevision` in the same directory. History
entries name revisions, and `retainDocumentRevisions` keeps the ones they need;
the store also keeps the revision the latest mutation replaced. The shell
bounds history to 20 entries. Before publication, a retained destination-backed
revision is copied in while the destination is readable and still matches its
witness, preserving the opened bytes for undo. If it cannot be read, Save can
proceed but that revision cannot be restored.

On open, recovery truncates an unfinished append beyond the greatest length
that current or history names in that file, removes unreferenced files and
settles `pendingPublish`. A missing or short committed revision leaves the
directory intact and refuses mutation and Save; it is not discarded as clean.
Dirty state derives from drafts, pending publication and the current revision's
witness against the baseline.

The renderer has one draft writer per document. Annotation state, editor text,
note windows, metadata and byte revisions mark it stale; it starts immediately
and repeats with the latest state if it changed during the write. Edits, typing,
undo and redo do not wait for it. Save, page operations, OCR apply, tab moves
and close or quit preparation wait for it. Drafts are cleared when the working
bytes hold that state, and kept while it cannot be captured. Recovered drafts
hold the writer until replay finishes; a failed replay leaves them intact.
Workspace checkpoints write layout and references, never drafts or PDF bytes.

## Save

`saveDocument` serializes these steps with document mutations. It records
`pendingPublish` before calling the publication port, which checks at its write
boundary:

1. Commit the captured edits into a revision, making that snapshot durable.
2. Check the destination against its baseline witness in the publication port.
   A changed file returns `conflict`, so the application can offer Save As.
3. Publish the committed bytes.
4. Acknowledge the published revision by updating the baseline and clearing
   `pendingPublish` in the manifest.

An annotation edit accepted after the Save snapshot stays unsaved; it does
not invalidate that Save. A changed byte revision can still refuse a stale
operation. Save As supplies a destination and publishes without the baseline
check. If a draft-only document has no private bytes and its original changed,
Save stages its edits on the original as it is now, checking that the copy is
stable. Plain Save still refuses the changed original; Save As can publish
those bytes with the edits. An unreadable original refuses with its own reason.
Failures retain the committed work. Recovery compares an interrupted
publication's witness with the destination before acknowledging it; the
publication port's `settle` first ends what the publish left there (desktop
puts back a PDF it moved aside). A publish whose destination cannot be read
stays recorded, in `unsettled` once a later Save follows it, until an open
or Save settles it. Desktop records the exact sibling temporary path before
creating it. Settlement removes only that recorded temporary file, after
validating its name and location; it never sweeps unknown files beside the PDF.

Desktop uses `file-v2:<size>:<mtimeNs>:<dev>:<ino>` as its destination
witness (device and inode are the volume serial and file id on Windows).
Opening, checking and publishing need no content-hash pass. A rename keeps
that witness; a replacement with equal size and time has a different identity.
An in-place edit that restores size and modification time is not detected.

Browser handle checks use size and millisecond modification time. Publication
stages a `content-v2` hash, then reads one File snapshot after closing the
writable and records that snapshot's metadata and content hash together. Other
content is a conflict. Recovery compares content when the staged witness names
it. Downloads use a content witness and dispatch as their receipt.

## Ports and ownership

`IStorePort` owns random reads, writes, truncation, flush, durable atomic
replacement and copies. `nodeStorePort.ts` uses local files, flushes file data
and, outside Windows, parent directory entries. It retains revision handles
read-only so qpdf can share them on Windows, opening write access only for the
store write, truncate or flush. Copies clone where the volume supports it,
including `/bin/cp -c` on macOS, and otherwise copy exclusively. The browser
adapter lives in
`app/platform/browser/browserStorePort.ts`: the core runs in the window and a
dedicated worker owns OPFS sync access handles. Without OPFS and Web Locks the
browser uses memory and reports that documents cannot survive a reload.

The Electron main process owns desktop directories. Each browser window holds
a Web Lock per open directory; file publication also takes an origin-wide lock.
File handles live in a small IndexedDB store. Desktop publication uses atomic
file replacement and retains displaced foreign bytes with a visible notice;
browser publication uses `createWritable`, write and close. A download's dispatch
is its receipt.

`workspaces/<window>.json` stores directory references and per-view state in
its tabs, plus the window layout. Linked views name the same directory. A
window names a directory in its checkpoint before the directory's first edit:
the browser as soon as it holds it, desktop before the first change that is
not part of opening it (a decrypt or normalize at open is not an edit).

Collection decides each directory while holding it: desktop collects once at
startup before the store opens anything, the browser takes the directory's
Web Lock. It removes directories without a manifest and clean ones no
checkpoint names. Unsaved edits are never collected. An unreferenced directory
with only an interrupted open's output (no drafts, no publish to settle and at
most two revisions made) can be removed. Every other unsaved directory no
window holds is offered for recovery, as a tab of its own when no workspace
shows it. A desktop document
discarded while a native reader still holds its files loses its manifest
first, so it is collected rather than offered.
