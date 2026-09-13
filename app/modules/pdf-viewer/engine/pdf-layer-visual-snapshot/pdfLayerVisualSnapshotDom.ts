import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import type { TPdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';

const pdfLayerVisualSnapshotActiveClass = 'pdf-layer-preserve-active';
const pdfLayerVisualSnapshotSourceClass = 'pdf-layer-preserve-hidden-source';

const activeSnapshotHostCounts = new WeakMap<Element, number>();

export function queryPdfLayerVisualSnapshotElements<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    if (!root) {
        return [];
    }
    return Array.from(root.querySelectorAll<T>(selector));
}

export function disablePdfLayerVisualSnapshotInteractivity(snapshot: Element) {
    snapshot.setAttribute('aria-hidden', 'true');
    if (snapshot instanceof HTMLElement) {
        snapshot.inert = true;
    }

    queryPdfLayerVisualSnapshotElements<HTMLElement>(snapshot, 'a, button, input, select, textarea, [tabindex]')
        .forEach((element) => {
            element.tabIndex = -1;
        });
}

export function createPdfLayerVisualSnapshotRelease(
    snapshots: Element[],
    restoreOriginals: Array<() => void> = [],
): TPdfLayerVisualSnapshotRelease | null {
    if (snapshots.length === 0 && restoreOriginals.length === 0) {
        return null;
    }

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        snapshots.forEach(snapshot => snapshot.remove());
        restoreOriginals.forEach(restoreOriginal => restoreOriginal());
    };
}

export function activatePdfLayerVisualSnapshotHost(host: HTMLElement) {
    const nextCount = (activeSnapshotHostCounts.get(host) ?? 0) + 1;
    activeSnapshotHostCounts.set(host, nextCount);
    host.classList.add(pdfLayerVisualSnapshotActiveClass);

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        const currentCount = activeSnapshotHostCounts.get(host) ?? 1;
        const remainingCount = Math.max(0, currentCount - 1);
        if (remainingCount > 0) {
            activeSnapshotHostCounts.set(host, remainingCount);
            return;
        }
        activeSnapshotHostCounts.delete(host);
        host.classList.remove(pdfLayerVisualSnapshotActiveClass);
    };
}

export function hidePdfLayerVisualSnapshotSource(element: HTMLElement | SVGElement) {
    const hadHiddenSourceClass = element.classList.contains(pdfLayerVisualSnapshotSourceClass);
    const previousVisibility = element.style.visibility;
    element.classList.add(pdfLayerVisualSnapshotSourceClass);
    element.style.visibility = 'hidden';
    return () => {
        if ('isConnected' in element && !element.isConnected) {
            return;
        }
        if (!hadHiddenSourceClass) {
            element.classList.remove(pdfLayerVisualSnapshotSourceClass);
        }
        element.style.visibility = previousVisibility;
    };
}

export function getPdfLayerVisualSnapshotCanvasHost(
    pageContainer: HTMLElement | null | undefined,
) {
    return pageContainer?.querySelector<HTMLElement>('.page_canvas__render-layer')
        ?? pageContainer?.querySelector<HTMLElement>('.page_canvas, .canvasWrapper')
        ?? null;
}

export function getPdfLayerVisualSnapshotAnnotationLayer(
    pageContainer: HTMLElement | null | undefined,
) {
    return pageContainer?.querySelector<HTMLElement>('.annotation-layer, .annotationLayer') ?? null;
}

export function getPdfLayerVisualSnapshotAnnotationEditorLayer(
    pageContainer: HTMLElement | null | undefined,
) {
    return pageContainer?.querySelector<HTMLElement>('.annotation-editor-layer, .annotationEditorLayer') ?? null;
}

export function isPdfLayerVisualSnapshotElement(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotClass}`));
}

export function isPdfLayerVisualSnapshotSourceElement(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotSourceClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotSourceClass}`));
}

function isInsideActivePdfLayerVisualSnapshotHost(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotActiveClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotActiveClass}`));
}

export function isPdfLayerVisualElementPotentiallyPainted(
    element: Element,
    options: { ignoreActiveSnapshotHostVisibility: boolean },
) {
    const isHtmlElement = typeof HTMLElement !== 'undefined' && element instanceof HTMLElement;
    const isSvgElement = typeof SVGElement !== 'undefined' && element instanceof SVGElement;
    if (!isHtmlElement && !isSvgElement) {
        return false;
    }
    if (isHtmlElement && element.hidden) {
        return false;
    }

    try {
        const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(element)
            : null;
        const activeSnapshotSuppressed = options.ignoreActiveSnapshotHostVisibility
            && isInsideActivePdfLayerVisualSnapshotHost(element);
        if (
            style
            && (
                style.display === 'none'
                || (style.visibility === 'hidden' && !activeSnapshotSuppressed)
                || Number(style.opacity || '1') <= 0
            )
        ) {
            return false;
        }

        const rect = typeof element.getBoundingClientRect === 'function'
            ? element.getBoundingClientRect()
            : null;
        return !rect || (rect.width > 0 && rect.height > 0);
    } catch {
        return true;
    }
}

export function isPdfLayerVisualElementVisiblyPainted(element: Element) {
    if (
        isPdfLayerVisualSnapshotElement(element)
        || isPdfLayerVisualSnapshotSourceElement(element)
        || isInsideActivePdfLayerVisualSnapshotHost(element)
    ) {
        return false;
    }
    return isPdfLayerVisualElementPotentiallyPainted(element, {ignoreActiveSnapshotHostVisibility: false});
}
