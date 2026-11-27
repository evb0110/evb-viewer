import type {IPageRenderTimeoutError} from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

export function isPageRenderTimeoutError(error: unknown): error is IPageRenderTimeoutError {
    return Boolean(
        error &&
        typeof error === 'object' &&
        'name' in error &&
        'stage' in error &&
        'timeoutMs' in error &&
        (error as {name?: unknown}).name === 'PdfPageRenderTimeoutError',
    );
}
