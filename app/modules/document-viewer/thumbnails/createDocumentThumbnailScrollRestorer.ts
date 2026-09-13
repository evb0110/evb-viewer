const DEFAULT_MAX_ATTEMPTS = 4;
const SCROLL_TOP_EPSILON = 1;

interface IDocumentThumbnailScrollRestorerOptions {
    applyScrollTop: (container: HTMLElement, scrollTop: number) => void;
    getContainer: () => HTMLElement | null;
    maxAttempts?: number;
}

function waitForAnimationFrame() {
    if (typeof globalThis.requestAnimationFrame === 'function') {
        return new Promise<void>(resolve => {
            globalThis.requestAnimationFrame(() => resolve());
        });
    }
    return new Promise<void>(resolve => {
        globalThis.setTimeout(resolve, 0);
    });
}

/**
 * Verifies a programmatic scroll after Vue has flushed and the browser has had
 * a chance to lay out the updated wrapper. Browsers clamp scrollTop against
 * the old scrollHeight, so one immediate write is not enough while thumbnail
 * geometry is still arriving.
 */
export function createDocumentThumbnailScrollRestorer(
    options: IDocumentThumbnailScrollRestorerOptions,
) {
    const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    let requestId = 0;

    async function verify(request: number, targetScrollTop: number, attempt: number) {
        await nextTick();
        if (request !== requestId) {
            return;
        }
        await waitForAnimationFrame();
        if (request !== requestId) {
            return;
        }

        const container = options.getContainer();
        if (!container) {
            if (attempt + 1 < maxAttempts) {
                await verify(request, targetScrollTop, attempt + 1);
            }
            return;
        }
        if (Math.abs(container.scrollTop - targetScrollTop) < SCROLL_TOP_EPSILON) {
            return;
        }

        options.applyScrollTop(container, targetScrollTop);
        if (
            request === requestId
            && Math.abs(container.scrollTop - targetScrollTop) >= SCROLL_TOP_EPSILON
            && attempt + 1 < maxAttempts
        ) {
            await verify(request, targetScrollTop, attempt + 1);
        }
    }

    function schedule(targetScrollTop: number) {
        if (!Number.isFinite(targetScrollTop)) {
            return;
        }
        const request = ++requestId;
        void verify(request, targetScrollTop, 0);
    }

    function cancel() {
        requestId += 1;
    }

    return {
        cancel,
        schedule,
    };
}
