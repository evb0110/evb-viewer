import { yieldToBrowser } from '@app/utils/yieldToBrowser';

interface IDocumentViewerVisibleLayoutOptions {
    isCurrent: () => boolean;
    maxAttempts?: number;
    nextLayoutOpportunity?: () => Promise<unknown>;
}

interface IRunDocumentViewerActivationPresentationOptions {
    isCurrent: () => boolean;
    measure: () => void;
    nextRenderTick?: () => Promise<unknown>;
    reconcile: () => Promise<unknown>;
    waitForVisibleLayout: () => Promise<boolean>;
}

export async function waitForDocumentViewerVisibleLayout(
    readElement: () => HTMLElement | null,
    options: IDocumentViewerVisibleLayoutOptions,
) {
    const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 3));
    const nextLayoutOpportunity = options.nextLayoutOpportunity ?? yieldToBrowser;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        await nextTick();
        if (!options.isCurrent()) {
            return false;
        }
        const element = readElement();
        if (element && element.clientWidth > 0 && element.clientHeight > 0) {
            return true;
        }
        await nextLayoutOpportunity();
        if (!options.isCurrent()) {
            return false;
        }
    }
    const element = readElement();
    return Boolean(
        options.isCurrent()
        && element
        && element.clientWidth > 0
        && element.clientHeight > 0,
    );
}

/**
 * Shared activation ordering for every document presentation adapter.
 * Format-specific geometry and visual reconciliation stay in the supplied
 * closures; this runner only guarantees that they observe visible layout and
 * that every asynchronous boundary is fenced against a stale activation.
 */
export async function runDocumentViewerActivationPresentation(
    options: IRunDocumentViewerActivationPresentationOptions,
) {
    if (!await options.waitForVisibleLayout() || !options.isCurrent()) {
        return false;
    }
    options.measure();
    if (!options.isCurrent()) {
        return false;
    }
    await (options.nextRenderTick ?? nextTick)();
    if (!options.isCurrent()) {
        return false;
    }
    await options.reconcile();
    return options.isCurrent();
}
