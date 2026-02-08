# Memories

Practical findings, struggles, and solutions discovered during implementation.

## Annotation System

### PDF.js Stamp Injection
PDF.js has no direct "add stamp at position" API. The workaround: activate the STAMP editor type, then use `AnnotationEditorParamsType.CREATE` with `{ bitmapFile: file }` to inject a stamp image. The file must be a `File` object (not a Blob). The pipeline is SVG string → Canvas render → `canvas.toBlob()` → `new File([blob], name, { type: 'image/png' })`.

### Shape Overlay Event Bubbling via Provide/Inject
`PdfShapeOverlay.vue` is rendered inside `PdfViewerPage.vue`, but events need to reach `PdfViewer.vue`. Direct emit chains don't work because PdfViewerPage doesn't know about shapes natively. Solution: `PdfViewer` creates a shape context object and `provide()`s it. PdfViewerPage `inject()`s it and passes it as props to PdfShapeOverlay. Event handlers on the overlay call methods on the injected context, which the PdfViewer controls. This avoids deep emit chains.

### Single-Click vs Double-Click on Annotated Text
Originally, single-clicking annotated text emitted `annotation-open-note` which opened a floating note window. Users found this intrusive. Fix: introduced a separate `annotation-comment-click` event for single clicks that only activates/pulses the annotation without opening anything. Double-click still emits `annotation-open-note` to open the note. Same pattern as file explorers (select vs open).

### Context Menu Forcing Sidebar Open
`handleViewerAnnotationContextMenu` was calling `handleAnnotationFocusComment()` which forces `showSidebar = true`. This meant right-clicking any annotation would slam the sidebar open. Fix: removed that call — the context menu handler now just sets the active comment key and shows the menu. The sidebar only opens from deliberate sidebar panel interactions.

## CSS / Styling

### Annotation Underlines Were Confusing
The dotted brown `text-decoration: underline dotted` on `.pdf-annotation-has-note-target` looked like rendering artifacts to users. Removed it entirely — the highlight background color is sufficient visual indication.

### Overlap Count Badges Were Invisible
The `.is-cluster::after` badges (showing "2" for overlapping annotations) were styled as tiny 4px dots, only revealing the count on hover. Users couldn't tell annotations overlapped. Fix: made badges always visible at 15px with 9px font, white-to-amber gradient background, and a border for contrast.

### Vue Scoped CSS and `::after`/`::before` Pseudo-elements
When styling PDF.js-generated DOM elements (not Vue-rendered), use `:deep()` to pierce scoping. The annotation markers and badges are injected by JavaScript into the PDF.js text layer, so `.pdfViewer :deep(.pdf-inline-comment-marker.is-cluster)::after` is needed.

## TypeScript

### Array Indexing Returns `T | undefined` in Strict Mode
`pageShapes[index]` returns `IShapeAnnotation | undefined` even after `findIndex` confirmed the index exists. Spreading `{ ...pageShapes[index], ...updates }` fails because `Partial<IShapeAnnotation>` isn't assignable to the union. Fix: non-null assert `pageShapes[index]!`.

### String Character Access Possibly Undefined
`someString[0]` returns `string | undefined` in strict mode. When parsing hex colors character by character, need `clean[0]!` etc. after validating length.

## SVG Shape Rendering

### Normalized Coordinates (0-1) with `vector-effect="non-scaling-stroke"`
Shapes use coordinates normalized to 0-1 relative to page dimensions (`viewBox="0 0 1 1"`). This makes them resolution-independent. But stroke widths would also scale, making them paper-thin. `vector-effect="non-scaling-stroke"` keeps stroke widths in screen pixels regardless of viewBox scaling.

### Arrow Markers Need `currentColor` + Style Binding
SVG `<marker>` elements with `fill="currentColor"` inherit color from the parent element's CSS `color` property, not from `stroke`. So arrow lines need both `:stroke="shape.color"` and `:style="{ color: shape.color }"` to color the arrowhead.

## Tooling

### Use Electron Puppeteer Skill, Not Browser Automation
This is an Electron app. The Chrome browser automation MCP tools (`mcp__claude-in-chrome__*`) don't work for it. Always use the `electron-puppeteer` skill (`pnpm electron:run`) for screenshots, clicking, and evaluation.

### Linter Auto-Reformats Between Read and Edit
ESLint with `--fix` can reformat code (spacing, trailing commas) between when you read a file and when you edit it. If an `Edit` old_string doesn't match, re-read the file to get the current linter-reformatted text before retrying the edit.

### `pnpm electron:run run` Quoting Issues
Multi-line or complex JS passed to `pnpm electron:run run "..."` breaks due to shell quoting. Use `eval` for simple one-liners, or `run` with single-line code. For complex interactions, chain simple commands.
