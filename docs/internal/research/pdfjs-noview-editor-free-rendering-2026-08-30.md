# pdf.js `noView` hiding and editor-free rendering at v5.7.284

Answers GitHub issue #153 (part of #150). Every citation is `path:line` in the
pdf.js clone at tag `v5.7.284` (commit `7e5b36c2d`), read with
`git show v5.7.284:<path>`. App citations are the current `main` checkout.

## 1. `annotationStorage.setValue(id, { noView: true })`

**Who reads it.** `Annotation.mustBeViewed(annotationStorage)` returns
`!noView` when the storage entry keyed by `this.data.id` defines `noView`,
otherwise falls back to the annotation flags
(`src/core/annotation.js:837-843`). `WidgetAnnotation.mustBeViewed` overrides
this: when `renderForms` is true it returns `this.viewable` and never looks at
the storage (`src/core/annotation.js:2011-2018`; widget `viewable` is always
true because `_isViewable` returns true, `:2000-2008`). The only caller is
`Page.getOperatorList` in the worker, which evaluates
`intentDisplay && mustBeViewed(annotationStorage, renderForms) && mustBeViewedWhenEditing(...)`
per annotation on every operator-list request (`src/core/document.js:617-632`).
Annotation objects are parsed once and shadowed (`document.js:811-875`); the
visibility decision is not cached there.

**When the worker sees the storage.** `WorkerTransport.getRenderingIntent`
only attaches `annotationStorage.serializable` when `annotationMode ===
ENABLE_STORAGE` (`src/display/api.js:2505-2518`); every other mode passes
`SerializableEmpty`, whose `map` is `null` (`src/display/annotation_storage.js:20-24`).
`_pumpOperatorList` sends that `map` as `annotationStorage` to the worker
(`api.js:1885-1896`; received at `src/core/worker.js:867-887`). So under
`ENABLE` or `ENABLE_FORMS` the worker calls `mustBeViewed(null)` and the
`noView` entry is ignored.

**Whether the next `render()` picks it up.** The operator-list cache key is
`[renderingIntent, serializable.hash, modifiedIdsHash].join("_")`
(`api.js:2530-2541`). `serializable.hash` is a MurmurHash over
`${key}:${JSON.stringify(value)}` for every entry (`annotation_storage.js:186-215`),
so any storage change yields a new key; `render()` looks up
`_intentStates` by that key and requests a fresh operator list when none exists
(`api.js:1484-1486`, `:1496-1508`). No `cleanup()`, `intent`, or `isEditing`
change is required. `cleanup()` only drops cached intent states and objects
(`api.js:1804-1830`); stale states from earlier hashes stay resident until then.

**Exact consumer recipe.**

1. `pdfDocument.annotationStorage.setValue(data.id, { noView: true })`, where
   `data.id` comes from `getAnnotations()` (`setValue` semantics:
   `annotation_storage.js:114-136`).
2. `page.render({ ..., annotationMode: AnnotationMode.ENABLE_STORAGE })`.
   Nothing else is needed.
3. To restore: `setValue(id, { noView: false })` (an explicit `false` beats the
   flags, `annotation.js:839-841`) or `remove(id)` (`annotation_storage.js:89-107`).

**Side effects the consumer must accept.**

- `ENABLE_STORAGE` also feeds `getNewAnnotationsMap(annotationStorage)`
  (`document.js:485-486`, `src/core/core_utils.js:662`), so any live editor
  entries in the storage are painted into the canvas as new annotations.
- `ENABLE_STORAGE` clears `ANNOTATIONS_FORMS`, so form widgets are drawn on the
  canvas (`annotation.js:2065-2079` skips them only under `ANNOTATIONS_FORMS`).
- The entry is not display-only: `WidgetAnnotation.save` and
  `ButtonWidgetAnnotation.save` convert `noView`/`noPrint` into `/F` flags via
  `_buildFlags` (`annotation.js:771-803`, `:2175-2177`, `:3225-3227`, `:3284-3286`).
  The base `Annotation.save` returns `null` (`:1265-1267`), so markup
  annotations are unaffected, but widget entries leak into `saveDocument`.
- `hasOwnCanvas` annotations hidden this way never reach `beginAnnotation`, so
  no canvas is placed in `annotationCanvasMap` (`src/display/canvas.js:2995-3019`)
  and the DOM element keeps no canvas child (`annotation_layer.js:4065-4103`).

**Alternative already in use.** `render({ operationsFilter })` skips operator
indices on the main thread (`api.js:1236-1237`, `:1466`, `canvas.js:772`)
without a worker round-trip and without touching the storage. The app uses it
today (`app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createHiddenAnnotationOperationsFilter.ts:109-145`,
wired at `app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer.ts:222-236`,
`:318-332`) with `ENABLE_FORMS` (`usePdfCanvasRenderer.ts:223`). Thumbnails
already render with `ENABLE_STORAGE` (`app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime.ts:424-428`).

## 2. Interaction with the DOM `AnnotationLayer`

- `getAnnotations()` is a plain worker call keyed only by `intent`
  (`api.js:1406-1410`, `:2993-2998`). The worker filters by
  `annotation.viewable` for display intent (`document.js:748-760`), which is
  flag-based (`INVISIBLE`/`NOVIEW`, `annotation.js:806-810`, `:869-877`) and
  never consults the storage. A storage `noView` entry therefore does not
  remove the annotation from `getAnnotations()`. The `HIDDEN` flag does not
  exclude non-widget annotations either.
- `data.hidden` is set only for widgets (`HIDDEN || NOVIEW`,
  `annotation.js:1957-1959`) and PMD barcode text widgets (`:2791`).
  `AnnotationLayer.render` applies `visibility: hidden` from that field
  (`src/display/annotation_layer.js:3892-3894`, `:3913-3915`) and skips
  `data.noHTML` entries (`:3865-3867`). Nothing in `render` reads
  `annotationStorage.noView`.
- The only DOM path that honors storage `noView`/`hidden` is
  `_setDefaultPropertiesFromJS` (`:601-625`), gated on `enableScripting` and
  called only from widget elements (`:1865`, `:1958`, `:2064`, `:2085`, `:2347`),
  replaying the `display`/`hidden` actions (`:528-550`) that also toggle
  `container.style.visibility`.
- Links: `LinkAnnotationElement` is unconditionally renderable (`:948-955`).
  Popups: `PopupAnnotationElement` renders whenever the parent element was
  rendered and has popup data (`:2354-2360`, `:3419-3428`, `:3465-3478`); the
  parent's storage entry is not consulted.
- So a `noView` markup annotation keeps its DOM container, link, and popup.
  Hide them by filtering the `annotations` array before
  `AnnotationLayer.render` (the app already passes that array:
  `app/services/pdfjs/pdfViewerFacade.ts:139-147`) or by calling
  `element.hide()`, which sets `container.hidden` and force-hides the popup
  (`annotation_layer.js:838-843`).
- Text layer: `TextLayer` takes only `{ textContentSource, images, container, viewport }`
  (`src/display/text_layer.js:53`, `:105`) and has no annotation, storage, or
  editor dependency.

## 3. Running with no `AnnotationEditorUIManager`

Supported. `AnnotationLayer` stores the manager (`annotation_layer.js:3782-3803`)
and every use is optional-chained: `renderAnnotationElement` (`:3896-3899`)
and `setMissingCanvas` (`:4090-4097`); no other reference exists in
`src/display` outside `src/display/editor/`. `annotationStorage` defaults to a
fresh `AnnotationStorage` (`:3800`). `AnnotationElement` uses
`annotationStorage?.getEditor` (`:217`, `:229`), which returns `null` without
editors (`annotation_storage.js:286-288`).

pdf.js's own viewer proves the configuration: with
`annotationEditorMode: DISABLE` the manager is never constructed
(`web/pdf_viewer.js:973-1008`), the getter reports `DISABLE` (`:2566-2570`) and
the setter throws (`:2594-2596`). `PDFPageView` still builds `TextLayerBuilder`
(`web/pdf_page_view.js:1045-1064`) and `AnnotationLayerBuilder`
(`:1068-1102`) with a null manager (`:114-118`;
`web/annotation_layer_builder.js:98`, `:114`, `:199`), and skips `DrawLayer` and
`AnnotationEditorLayerBuilder` when the manager is absent
(`pdf_page_view.js:1194-1200`). Classes that do require the manager:
`AnnotationEditorLayer`, `DrawLayer` wiring (`:1198-1218`), and the manager
itself, which needs an `eventBus` and `pdfDocument.annotationStorage`
(`src/display/editor/tools.js:914-966`). The app constructs it in
`app/services/pdfjs/pdfViewerFacade.ts:99-117`.

## 4. `AnnotationStorage` without an editor

Class at `annotation_storage.js:29`. With no `AnnotationEditor` values:

- `getValue`/`getRawValue`/`remove`/`setValue`/`has`/`size` work on the raw map
  (`:67-149`). There is no `getAll` at this tag; iteration is
  `[Symbol.iterator]` (`:318-320`).
- `onSetModified` fires on the first modifying `setValue` (`:151-156`),
  `onResetModified` on `resetModified` (`:158-163`); pdf.js's viewer uses them
  for the `beforeunload` guard (`web/app.js:1917-1926`). `onAnnotationEditor`
  fires only for editor values (`:132-135`) or their removal (`:103-106`).
- `serializable` maps raw values verbatim and hashes them (`:176-216`);
  `modifiedIds` returns an empty set and `""` hash when no editors exist
  (`:293-316`); `getEditor` returns `null` (`:286-288`); `editorStats` still
  counts `popup` fields on raw entries (`:218-271`).
- Form values written by widget DOM elements (e.g. `:1198`, `:1451-1464`) are
  read back in `WidgetAnnotation.save` (`annotation.js:2175-2180`).

`saveDocument` is not the only consumer of serialized entries:

- `saveDocument` (`api.js:974`, `:2895-2917`) → worker `SaveDocument`
  (`worker.js:666-680`, `:714`, `:778`).
- `extractPages` (`api.js:1012`, `:2920-2934`) → worker `ExtractPages`
  (`worker.js:561-562`, `:649`).
- `render`/`getOperatorList` under `ENABLE_STORAGE` (`document.js:485-486`,
  `:627-632`), including printing through `PrintAnnotationStorage`
  (`annotation_storage.js:328-344`; `api.js:2499-2503`).
- XFA serialization (`worker.js:768`).
- `getData()` does not consume it (`api.js:965`, `:2891-2893`).

## 5. Effect of `page.render({ annotationMode })`

`AnnotationMode` values: `src/shared/util.js:65-70`; flag mapping:
`api.js:2505-2528`.

- `DISABLE` → `ANNOTATIONS_DISABLE`: the worker returns the page operator list
  with no annotations at all (`document.js:610-616`); storage irrelevant.
- `ENABLE`: display intent only; storage `map` is `null`, so only PDF flags
  decide visibility; widgets are drawn on the canvas.
- `ENABLE_FORMS`: widgets are skipped on the canvas unless `noHTML`,
  `hasOwnCanvas`, or signature (`annotation.js:2065-2079`); widget
  `mustBeViewed` ignores the storage (`:2011-2014`); storage still not sent, so
  `noView` has no canvas effect for any annotation type.
- `ENABLE_STORAGE`: storage map and hash are sent; `noView` is honored for all
  types (widgets via the `super` path, `:2015-2018`); editor entries are drawn
  as new annotations (`document.js:485-560`).
- `isEditing` adds `IS_EDITING` and routes through `mustBeViewedWhenEditing`
  (`annotation.js:862-864`, `document.js:631`), which hides editable
  annotations independent of `noView`. `intent: "any"` bypasses
  `mustBeViewed` entirely (`document.js:628`).
- `getAnnotations()` and the DOM `AnnotationLayer` ignore `annotationMode`
  (sections 2 and 3).

## Bottom line

`noView` in the storage is a worker-side operator-list switch that works on the
next `render()` call, but only under `annotationMode: ENABLE_STORAGE`, and it
does not touch `getAnnotations()`, the DOM layer, or the text layer. The DOM
element must be hidden separately. The editor stack can be omitted entirely;
`AnnotationStorage` keeps working as a plain keyed map with modified-state
callbacks, and its entries feed save, extract, print, and `ENABLE_STORAGE`
rendering.
