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
import type {IDocumentThumbnailCommittedState} from '@app/utils/document-viewer/thumbnails/documentThumbnailScheduler';
import type {IDocumentThumbnailVirtualItem} from '@app/utils/document-viewer/thumbnails/useDocumentThumbnailController';
import {
    documentThumbnailRow,
    installDocumentThumbnailListEnvironment,
    mountDocumentThumbnailList,
    restoreDocumentThumbnailListEnvironment,
} from '@tests/helpers/document-viewer/documentThumbnailListHarness';

/**
 * Multi-select intent lives in the modifier keys of the click that selected a
 * row, and only the original event carries them. The rail hands its consumer
 * that exact event, so a consumer can implement ctrl/shift selection without
 * reconstructing a synthetic event from coordinates it never received.
 *
 * The controller is a double here: the scenario is about the click path from
 * the row to the emit, not about rendering.
 */
const controller = vi.hoisted(() => ({
    contentHeight: '0px',
    handlePointerDown: () => {},
    handleScroll: () => {},
    handleWheel: () => {},
    renderErrors: new Set<number>(),
    retryRender: vi.fn(),
    states: new Map<number, IDocumentThumbnailCommittedState>(),
    virtualItems: [] as IDocumentThumbnailVirtualItem[],
}));

vi.mock(
    '@app/utils/document-viewer/thumbnails/useDocumentThumbnailController',
    () => ({useDocumentThumbnailController: () => controller}),
);

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

function showRow(pageNumber: number) {
    controller.contentHeight = '400px';
    controller.virtualItems.push({
        aspectRatio: '5 / 7',
        height: 200,
        pageNumber,
        top: (pageNumber - 1) * 200,
    });
}

beforeEach(() => {
    controller.contentHeight = '0px';
    controller.renderErrors.clear();
    controller.retryRender.mockClear();
    controller.states.clear();
    controller.virtualItems.length = 0;
    installDocumentThumbnailListEnvironment();
});

afterEach(restoreDocumentThumbnailListEnvironment);

describe('DocumentThumbnailList activation event', () => {
    it('hands the consumer the original event of a modified click', () => {
        showRow(2);
        const rail = mountDocumentThumbnailList(null);
        const click = new MouseEvent('click', {
            bubbles: true,
            ctrlKey: true,
            shiftKey: true,
        });

        documentThumbnailRow(rail.host, 2)?.dispatchEvent(click);

        expect(rail.navigations).toEqual([2]);
        expect(rail.navigationEvents[0]).toBe(click);
        expect(rail.navigationEvents[0]?.ctrlKey).toBe(true);
        expect(rail.navigationEvents[0]?.shiftKey).toBe(true);
    });

    it('still reports a plain click as a plain click', () => {
        showRow(3);
        const rail = mountDocumentThumbnailList(null);
        const click = new MouseEvent('click', {bubbles: true});

        documentThumbnailRow(rail.host, 3)?.dispatchEvent(click);

        expect(rail.navigations).toEqual([3]);
        expect(rail.navigationEvents[0]).toBe(click);
        expect(rail.navigationEvents[0]?.ctrlKey).toBe(false);
        expect(rail.navigationEvents[0]?.metaKey).toBe(false);
        expect(rail.navigationEvents[0]?.shiftKey).toBe(false);
    });
});
