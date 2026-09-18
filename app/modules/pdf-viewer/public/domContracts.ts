/**
 * The viewer's rendered-DOM contract: the selectors that name its elements and
 * the epsilon it clamps horizontal scroll with. Kept as a leaf entrypoint so an
 * observer can read the viewer's own definitions without pulling the runtime.
 */
export { HORIZONTAL_SCROLL_CLAMP_EPSILON_PX } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';
export { pdfViewerDomClasses } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses';
export { pdfViewerDomSelectors } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomSelectors';
