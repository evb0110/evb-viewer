import type { IDocumentPreviewPageState } from '@app/modules/document-viewer/public';

interface INativePdfPageShellLayout {
    height: number;
    top: number;
    width: number;
}

export function resolveNativePdfPageShellLeft(options: {
    gutterPx: number;
    pageWidth: number;
    surfaceWidth: number;
}) {
    return Math.max(options.gutterPx, Math.round((options.surfaceWidth - options.pageWidth) / 2));
}

export function createIdleNativePdfPageState(): IDocumentPreviewPageState {
    return {
        failedRenderPx: 0,
        objectUrl: null,
        renderedPx: 0,
        status: 'idle',
        token: 0,
    };
}

export function preloadNativePdfPageObjectUrl(objectUrl: string) {
    if (typeof Image === 'undefined') {
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
        const image = new Image();
        const settle = (complete: () => void) => {
            image.onload = null;
            image.onerror = null;
            complete();
        };
        image.onload = () => settle(resolve);
        image.onerror = () => settle(() => reject(new Error('Failed to decode PDF page preview')));
        image.src = objectUrl;
    });
}

export function resolveNativePdfPageShellStyle(options: {
    gutterPx: number;
    layout: INativePdfPageShellLayout | null | undefined;
    surfaceWidth: number;
}) {
    if (!options.layout) {
        return {};
    }
    return {
        left: `${resolveNativePdfPageShellLeft({
            gutterPx: options.gutterPx,
            pageWidth: options.layout.width,
            surfaceWidth: options.surfaceWidth,
        })}px`,
        top: `${options.layout.top}px`,
        width: `${options.layout.width}px`,
        height: `${options.layout.height}px`,
    };
}
