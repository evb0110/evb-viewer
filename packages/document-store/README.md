# Document store

The shared durability core for desktop, browser and extension. The application
owns document identity, permissions and view state; this package owns committed
bytes and drafts. [ADR 0010](../../docs/architecture/adr/0010-document-store-manifest-is-the-commit-point.md)
records the decision.

## Directory and commit

Each `documents/<id>/` directory contains:

| Entry | Meaning |
| --- | --- |
| `manifest.json` | The only commit point: current revision, bounded history, destination, baseline witness, pending publication and drafts reference. |
| `r<n>.<ext>` | Revision bytes, immutable within every length the manifest names. |
| `drafts-<uuid>.json` | Immutable annotations and metadata not yet written into the document bytes. |

A path-backed document can start without a revision file. Reads use its
destination until the first mutation needs private bytes. Append mutations flush
an extended revision; rewrites flush a new file. Replacing the manifest commits
the revision and its kept, replaced or cleared drafts together. A drafts-only
change also commits by replacing the manifest.

On open, recovery truncates an unfinished append beyond the greatest length
that current or history names in that file, removes unreferenced files and
settles `pendingPublish`. A missing or short committed revision leaves the
directory intact and refuses mutation and Save; it is not discarded as clean.
Dirty state derives from drafts, pending publication and the current revision's
witness against the baseline.

## Save

`saveDocument` serializes these steps with document mutations. It records
`pendingPublish` before calling the publication port, which checks at its write
boundary:

1. Commit pending edits into a revision, making the work durable.
2. Check the destination against its baseline witness in the publication port.
   A changed file returns `conflict`, so the application can offer Save As.
3. Publish the committed bytes.
4. Acknowledge the published revision by updating the baseline and clearing
   `pendingPublish` in the manifest.

Save As supplies a destination and publishes without the baseline check.
Failures retain the committed work. Recovery compares an interrupted
publication's witness with the destination before acknowledging it; the
publication port's `settle` first ends what the publish left there (desktop
puts back a PDF it moved aside). A publish whose destination cannot be read
stays recorded, in `unsettled` once a later Save follows it, until an open
or Save settles it.

A saved file's metadata witness is its size and modification time; desktop
adds the file's identity (device and inode, on Windows the volume serial and
file id), so a file another program put in its place differs even with the
same size and time, while a rename keeps it. Desktop records nanoseconds;
browser file handles expose milliseconds. Checking that fact reads no file
content. A touch or an identical rewrite that changes the metadata conflicts;
an edit in place that restores the modification time is not seen. Content witnesses identify revision bytes and downloaded
output, and let recovery recognize a completed publication.

## Ports and ownership

`IStorePort` owns random reads, writes, truncation, flush, durable atomic
replacement and copies. `nodeStorePort.ts` uses local files, flushes file data
and, outside Windows, parent directory entries. The browser adapter lives in
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
checkpoint names. Unsaved work is never removed, with one exception: an
unsaved directory no checkpoint names that holds only what an open made (no
drafts, no publish to settle, at most two revisions made) is an open a crash
cut short. Every other unsaved directory no window holds is offered for
recovery, as a tab of its own when no workspace shows it. A desktop document
discarded while a native reader still holds its files loses its manifest
first, so it is collected rather than offered.
