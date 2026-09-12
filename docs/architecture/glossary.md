# EVB Viewer

A desktop and browser PDF/DjVu viewer with Acrobat-style annotation editing for
a small circle of users. This glossary fixes the words the codebase and its
decisions use for documents, annotations, and the parts that read and write them.

## Documents

**Working copy**:
The private, decrypted copy of an opened file that every read, edit, and save
operates on until the user saves back to the original path.
_Avoid_: temp file, scratch copy, materialized file

**Renderer**:
The component that turns a page into pixels, a text layer, and a static display
of annotations it does not edit. It never produces PDF bytes.
_Avoid_: engine, viewer core

**Writer**:
The single component that reads annotations from a file into the canonical
annotation store and produces PDF bytes for a save, whether by appending an
incremental update or rewriting the file.
_Avoid_: save route, materializer, saveDocument

## Annotations

**Canonical annotation store**:
The one in-app owner of every annotation's state. Every other view of an
annotation (on-page display, sidebar, written PDF objects) derives from it.
_Avoid_: annotation storage, editor state, mirror

**Annotation editor layer**:
The EVB-owned on-page UI that creates, moves, resizes, and edits annotations
against the canonical annotation store.
_Avoid_: editor bridge, editor UI manager, annotation layer

**Editable annotation type**:
An annotation kind the annotation editor layer can create and modify: text box,
highlight, note, stamp, shape.
_Avoid_: editor type, supported annotation

**Note**:
An editable annotation that shows as a small icon on the page and opens its text
in a window. Foreign viewers display the same icon.
_Avoid_: sticky note, point note, marker, FreeText note

**Text box**:
An editable annotation whose text is drawn on the page inside a rectangle.
_Avoid_: FreeText editor, free text, text annotation

**Canonical property**:
A property of an editable annotation that the canonical annotation store owns
and the annotation editor layer can change.
_Avoid_: editable field, core field, semantic field

**Preserved property**:
Data on an editable annotation that the store does not own and the writer
leaves in the file untouched, including replies and review states on a note.
_Avoid_: fidelity, opaque blob, passthrough, unknown keys

**Derived property**:
A value the app recomputes from the document each time it opens, never stored
as the source of truth, such as the text under a highlight.
_Avoid_: cache, snapshot, hint

**Round-trip equality**:
The rule that every canonical property compares equal after parse, save,
reopen, parse, within a tolerance no user can see on the page.
_Avoid_: fingerprint match, semantic equality, persistence parity

**Foreign annotation**:
An annotation the canonical annotation store does not own: a non-editable
type (link, widget, unknown subtype) or an editable type it cannot represent.
The renderer displays it read-only and the writer preserves it untouched.
_Avoid_: imported annotation, external annotation, legacy annotation

**Opening preview**:
The fast first paint of a document produced outside the renderer while the
renderer is still loading.
_Avoid_: native preview, skeleton

## Assistant

**Assistant session**:
A conversation bound to one document scope and one assistant provider. Its
durable transcript is the source of truth for the renderer's displayed chat.
_Avoid_: panel state, chat component state, provider thread

**Assistant provider**:
A supported local execution backend that translates one assistant session to
and from a vendor protocol while preserving the shared chat lifecycle.
_Avoid_: plugin, model, assistant mode

**Assistant state projection**:
The renderer's disposable view of assistant sessions, provider status, and
turn progress. It can be rebuilt from main-process state and durable records.
_Avoid_: assistant store, chat source of truth

**Local MCP boundary**:
The loopback-only tool boundary through which a supported assistant reads and
acts on the current EVB Viewer workspace under its existing access controls.
_Avoid_: public API, plugin API, remote MCP service
