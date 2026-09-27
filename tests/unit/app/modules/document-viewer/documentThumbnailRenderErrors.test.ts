// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {LOCALE_MESSAGES} from '@i18n-app/locales';
import englishMessages from '@i18n-app/messages/en';
import {
    countDocumentThumbnailCalls,
    createDocumentThumbnailSourceHarness,
    documentThumbnailRow,
    type IDocumentThumbnailSourceHarness,
    installDocumentThumbnailListEnvironment,
    LEASED_THUMBNAIL_RASTER_WIDTH,
    mountDocumentThumbnailList,
    restoreDocumentThumbnailListEnvironment,
    scrollDocumentThumbnailRail,
    settleDocumentThumbnailList,
    widenDocumentThumbnailFrames,
} from '@tests/helpers/document-viewer/documentThumbnailListHarness';

/** Widths the rail asked the provider for on behalf of one page, in order. */
function requestedWidths(harness: IDocumentThumbnailSourceHarness, pageNumber: number) {
    return harness.renderRequests
        .filter(request => request.pageNumber === pageNumber)
        .map(request => request.widthPx);
}

function resolveMessage(messages: unknown, key: string): string {
    const value = key.split('.').reduce<unknown>(
        (node, segment) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined),
        messages,
    );
    return typeof value === 'string' ? value : key;
}

function translate(key: string, parameters?: Record<string, string | number>) {
    return Object.entries(parameters ?? {}).reduce(
        (
            value,
            [
                parameter,
                replacement,
            ],
        ) => value.replace(`{${parameter}}`, String(replacement)),
        resolveMessage(englishMessages, key),
    );
}

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: translate}),
}));

beforeEach(installDocumentThumbnailListEnvironment);
afterEach(restoreDocumentThumbnailListEnvironment);

describe('DocumentThumbnailList render errors', () => {
    it('keeps the loading placeholder while the scheduler still has retries left', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        harness.behaviors.set(3, 'defer');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBe(1);
        expect(documentThumbnailRow(host, 3)?.querySelector('.document-thumbnail-list__placeholder')).not.toBeNull();

        await harness.failPendingRender(3);
        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBe(2);
        expect(documentThumbnailRow(host, 3)?.hasAttribute('data-thumbnail-render-error')).toBe(false);
        expect(documentThumbnailRow(host, 3)?.querySelector('.document-thumbnail-list__placeholder')).not.toBeNull();

        await harness.failPendingRender(3);
        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBe(3);
        expect(documentThumbnailRow(host, 3)?.hasAttribute('data-thumbnail-render-error')).toBe(false);
        expect(documentThumbnailRow(host, 3)?.querySelector('.document-thumbnail-list__placeholder')).not.toBeNull();

        await harness.failPendingRender(3);
        expect(documentThumbnailRow(host, 3)?.hasAttribute('data-thumbnail-render-error')).toBe(true);
        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBe(3);
    });

    it('recovers without an error surface when a retry succeeds', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        harness.behaviors.set(3, 'defer');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        harness.behaviors.set(3, 'succeed');
        await harness.failPendingRender(3);

        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBe(2);
        expect(host.querySelectorAll('[data-thumbnail-render-error]')).toHaveLength(0);
        expect(documentThumbnailRow(host, 3)?.querySelector('.document-thumbnail-list__canvas-host')).not.toBeNull();
        expect(documentThumbnailRow(host, 3)?.getAttribute('aria-label')).toBe('Go to page 3');
    });

    it('surfaces a localized error once retries are exhausted and stops retrying', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        harness.behaviors.set(3, 'fail');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        const failedRow = documentThumbnailRow(host, 3);
        expect(failedRow?.hasAttribute('data-thumbnail-render-error')).toBe(true);
        expect(failedRow?.getAttribute('aria-label')).toBe('Go to page 3. Page preview unavailable.');
        expect(failedRow?.querySelector('.document-thumbnail-list__error-text')?.textContent)
            .toBe(englishMessages.common.pageRenderFailed);
        expect(failedRow?.querySelector('.document-thumbnail-list__placeholder')).not.toBeNull();

        const attempts = countDocumentThumbnailCalls(harness.renderCalls, 3);
        expect(attempts).toBe(3);

        await settleDocumentThumbnailList();
        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBe(attempts);
    });

    it('hides the error decoration from assistive technology behind the row name', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        harness.behaviors.set(3, 'fail');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        const decoration = documentThumbnailRow(host, 3)
            ?.querySelector<HTMLElement>('.document-thumbnail-list__error');
        expect(decoration?.getAttribute('aria-hidden')).toBe('true');
        expect(decoration?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('i-ph-warning-circle');
    });

    it('translates the failed row name in every shipped locale', () => {
        for (const [
            code,
            messages,
        ] of Object.entries(LOCALE_MESSAGES)) {
            const failed = resolveMessage(messages, 'documentSourceSidebar.goToPageRenderFailed');
            const succeeded = resolveMessage(messages, 'documentSourceSidebar.goToPage');

            expect(failed, code).not.toBe('documentSourceSidebar.goToPageRenderFailed');
            expect(failed, code).toContain('{page}');
            expect(failed, code).not.toBe(succeeded);
        }
    });

    it('keeps one failed page from poisoning its neighbours', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        harness.behaviors.set(3, 'fail');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        expect(host.querySelectorAll('[data-thumbnail-render-error]')).toHaveLength(1);
        for (const pageNumber of [
            1,
            2,
        ]) {
            const neighbour = documentThumbnailRow(host, pageNumber);
            expect(neighbour?.hasAttribute('data-thumbnail-render-error'), String(pageNumber)).toBe(false);
            expect(neighbour?.getAttribute('aria-label')).toBe(`Go to page ${String(pageNumber)}`);
            expect(countDocumentThumbnailCalls(harness.renderCalls, pageNumber)).toBe(1);
        }
    });

    it('retries and clears the error when the failed row is activated', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        harness.behaviors.set(3, 'fail');
        const {
            host,
            navigations,
        } = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        expect(documentThumbnailRow(host, 3)?.hasAttribute('data-thumbnail-render-error')).toBe(true);
        const attemptsBeforeRetry = countDocumentThumbnailCalls(harness.renderCalls, 3);

        harness.behaviors.set(3, 'succeed');
        documentThumbnailRow(host, 3)?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await settleDocumentThumbnailList();

        expect(navigations).toEqual([3]);
        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBe(attemptsBeforeRetry + 1);
        expect(documentThumbnailRow(host, 3)?.hasAttribute('data-thumbnail-render-error')).toBe(false);
        expect(documentThumbnailRow(host, 3)?.getAttribute('aria-label')).toBe('Go to page 3');
        expect(host.querySelectorAll('[data-thumbnail-render-error]')).toHaveLength(0);
    });

    it('clears errors when the source is replaced', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        harness.behaviors.set(3, 'fail');
        const {
            host,
            setSource,
        } = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        expect(host.querySelectorAll('[data-thumbnail-render-error]')).toHaveLength(1);

        const replacement = createDocumentThumbnailSourceHarness(12, '/replacement.pdf');
        setSource(replacement.source);
        await settleDocumentThumbnailList();

        expect(host.querySelectorAll('[data-thumbnail-render-error]')).toHaveLength(0);
        expect(documentThumbnailRow(host, 3)?.getAttribute('aria-label')).toBe('Go to page 3');
        expect(countDocumentThumbnailCalls(replacement.renderCalls, 3)).toBe(1);
    });

    it('gives a failed page a fresh run once it leaves and re-enters the window', async () => {
        const harness = createDocumentThumbnailSourceHarness(400);
        harness.behaviors.set(3, 'fail');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        expect(documentThumbnailRow(host, 3)?.hasAttribute('data-thumbnail-render-error')).toBe(true);
        const attempts = countDocumentThumbnailCalls(harness.renderCalls, 3);
        await scrollDocumentThumbnailRail(host, 10_000);
        harness.behaviors.set(3, 'succeed');
        await scrollDocumentThumbnailRail(host, 0);
        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBe(attempts + 1);
        expect(documentThumbnailRow(host, 3)?.hasAttribute('data-thumbnail-render-error')).toBe(false);
        expect(documentThumbnailRow(host, 3)?.querySelector('.document-thumbnail-list__canvas-host')).not.toBeNull();
    });

    it('shows the same placeholder after a failed resize without looping on the smaller cached raster', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();
        const committedWidth = requestedWidths(harness, 2)[0];
        expect(committedWidth).not.toBe(LEASED_THUMBNAIL_RASTER_WIDTH);
        expect(documentThumbnailRow(host, 2)?.querySelector('.document-thumbnail-list__canvas-host')).not.toBeNull();
        harness.behaviors.set(2, 'fail');
        widenDocumentThumbnailFrames(400);
        await scrollDocumentThumbnailRail(host, 40);
        await scrollDocumentThumbnailRail(host, 0);
        expect(requestedWidths(harness, 2).slice(1)).toHaveLength(3);
        expect(requestedWidths(harness, 2).slice(1).every(width => width > committedWidth!)).toBe(true);
        expect(documentThumbnailRow(host, 2)?.querySelector('.document-thumbnail-list__canvas-host')).toBeNull();
        expect(documentThumbnailRow(host, 2)?.querySelector('.document-thumbnail-list__placeholder')).not.toBeNull();
        expect(documentThumbnailRow(host, 2)?.hasAttribute('data-thumbnail-render-error')).toBe(true);
        await settleDocumentThumbnailList();
        expect(requestedWidths(harness, 2)).toHaveLength(4);
        expect([...harness.runawayPages]).toEqual([]);
        harness.behaviors.set(2, 'succeed');
        documentThumbnailRow(host, 2)?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await settleDocumentThumbnailList();
        expect(requestedWidths(harness, 2)).toHaveLength(5);
        expect(documentThumbnailRow(host, 2)?.querySelector('.document-thumbnail-list__canvas-host')).not.toBeNull();
        expect(documentThumbnailRow(host, 2)?.hasAttribute('data-thumbnail-render-error')).toBe(false);
    });

    it('renders retries without loading page geometry', async () => {
        const harness = createDocumentThumbnailSourceHarness();
        harness.behaviors.set(3, 'fail');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        harness.behaviors.set(3, 'succeed');
        documentThumbnailRow(host, 3)?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        await settleDocumentThumbnailList();

        expect(countDocumentThumbnailCalls(harness.renderCalls, 3)).toBeGreaterThan(1);
        expect(harness.metricsCalls).toEqual([]);
    });
});
