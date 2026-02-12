import type { IScrollSnapshot } from '@app/types/pdf';

export function isRenderingCancelledError(error: unknown) {
    if (!error) {
        return false;
    }
    if (
        typeof error === 'object'
        && 'name' in error
        && (error as { name?: string }).name === 'RenderingCancelledException'
    ) {
        return true;
    }

    const message = typeof error === 'string'
        ? error
        : (
            typeof error === 'object'
            && error !== null
            && 'message' in error
            && typeof (error as { message?: unknown }).message === 'string'
        )
            ? (error as { message: string }).message
            : '';

    return /rendering cancelled/i.test(message);
}

export function captureScrollSnapshot(container: HTMLElement | null): IScrollSnapshot | null {
    if (!container) {
        return null;
    }

    const {
        scrollWidth,
        scrollHeight,
    } = container;
    if (!scrollWidth || !scrollHeight) {
        return null;
    }

    return {
        width: scrollWidth,
        height: scrollHeight,
        centerX: container.scrollLeft + container.clientWidth / 2,
        centerY: container.scrollTop + container.clientHeight / 2,
    };
}

export function restoreScrollFromSnapshot(
    container: HTMLElement | null,
    snapshot: IScrollSnapshot | null,
) {
    if (!snapshot || !container) {
        return;
    }

    const newWidth = container.scrollWidth;
    const newHeight = container.scrollHeight;

    if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
        return;
    }

    const targetLeft = (snapshot.centerX / snapshot.width) * newWidth - container.clientWidth / 2;
    const targetTop = (snapshot.centerY / snapshot.height) * newHeight - container.clientHeight / 2;

    container.scrollLeft = Math.max(0, targetLeft);
    container.scrollTop = Math.max(0, targetTop);
}

export function formatRenderError(error: unknown, pageNumber: number) {
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : (() => {
                try {
                    return JSON.stringify(error);
                } catch {
                    return String(error);
                }
            })();

    const stack = error instanceof Error ? error.stack ?? '' : '';
    return stack
        ? `Failed to render PDF page: ${pageNumber} ${message}\n${stack}`
        : `Failed to render PDF page: ${pageNumber} ${message}`;
}
