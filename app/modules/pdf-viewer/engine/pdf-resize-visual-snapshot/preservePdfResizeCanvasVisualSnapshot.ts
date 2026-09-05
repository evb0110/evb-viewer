const RESIZE_SNAPSHOT_CLASS = 'pdf-resize-canvas-snapshot';
const RESIZE_SNAPSHOT_CANVAS_CLASS = 'page_canvas--resize-visual-snapshot';

export interface IPdfResizeCanvasVisualSnapshot {
    hasReplacementCanvas: () => boolean;
    isValid: () => boolean;
    release: () => void;
}

export function preservePdfResizeCanvasVisualSnapshot(
    pageContainer: HTMLElement | null | undefined,
): IPdfResizeCanvasVisualSnapshot | null {
    const pageCanvas = pageContainer?.querySelector<HTMLElement>('.page_canvas');
    const canvasHost = pageCanvas?.querySelector<HTMLElement>('.page_canvas__render-layer');
    const sourceCanvas = canvasHost?.querySelector<HTMLCanvasElement>('canvas');
    const existingSnapshots = pageCanvas?.querySelectorAll<HTMLCanvasElement>(
        `.${RESIZE_SNAPSHOT_CLASS}`,
    ) ?? [];
    for (const existingSnapshot of existingSnapshots) {
        const isValid = existingSnapshot.isConnected
            && existingSnapshot.parentElement === pageCanvas
            && existingSnapshot.width > 0
            && existingSnapshot.height > 0;
        if (isValid) {
            return null;
        }
        existingSnapshot.remove();
    }
    if (
        !pageContainer
        || !pageCanvas
        || !canvasHost
        || !sourceCanvas
        || !pageContainer.classList.contains('page_container--rendered')
        || sourceCanvas.width <= 0
        || sourceCanvas.height <= 0
    ) {
        return null;
    }

    const snapshot = document.createElement('canvas');
    snapshot.width = sourceCanvas.width;
    snapshot.height = sourceCanvas.height;
    snapshot.classList.add(RESIZE_SNAPSHOT_CLASS);
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.inert = true;

    const context = snapshot.getContext('2d');
    if (!context) {
        return null;
    }
    context.drawImage(sourceCanvas, 0, 0);

    // PdfViewerPage owns the page container's dynamic class binding and may
    // reconcile it while rendered state changes. Keep the imperative snapshot
    // marker on the stable canvas shell so Vue cannot erase the protection
    // before the replacement canvas is presentation-ready.
    pageCanvas.classList.add(RESIZE_SNAPSHOT_CANVAS_CLASS);
    pageCanvas.append(snapshot);

    let released = false;
    return {
        hasReplacementCanvas: () => {
            const replacement = canvasHost.querySelector<HTMLCanvasElement>('canvas');
            return replacement !== null
                && replacement !== sourceCanvas
                && replacement.isConnected
                && replacement.width > 0
                && replacement.height > 0
                && pageContainer.classList.contains('page_container--rendered')
                && getComputedStyle(canvasHost).visibility !== 'hidden';
        },
        isValid: () => (
            !released
            && snapshot.isConnected
            && snapshot.parentElement === pageCanvas
            && pageContainer.contains(pageCanvas)
            && snapshot.width > 0
            && snapshot.height > 0
        ),
        release: () => {
            if (released) {
                return;
            }
            released = true;
            snapshot.remove();
            if (!pageCanvas.querySelector(`.${RESIZE_SNAPSHOT_CLASS}`)) {
                pageCanvas.classList.remove(RESIZE_SNAPSHOT_CANVAS_CLASS);
            }
        },
    };
}
