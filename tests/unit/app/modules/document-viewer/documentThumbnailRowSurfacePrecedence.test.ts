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
 * The row template shows a committed surface ahead of an error decoration, so
 * the row name and the failure marker have to follow that same precedence. The
 * controller and the scheduler can hold both facts at once — a page keeps its
 * committed lease until the replacement commits — so this drives the component
 * with a controller double that puts the row in exactly that state.
 */
const controller = vi.hoisted(() => ({
    contentHeight: '0px',
    handlePointerDown: () => {},
    handleScroll: () => {},
    handleWheel: () => {},
    renderErrors: new Set<number>(),
    retryRender: () => {},
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

function commitSurface(pageNumber: number, surface: IDocumentThumbnailCommittedState['surface']) {
    controller.states.set(pageNumber, {
        heightPx: 252,
        pageNumber,
        requestWidthPx: 192,
        surface,
        widthPx: 180,
    });
}

beforeEach(() => {
    controller.contentHeight = '0px';
    controller.renderErrors.clear();
    controller.states.clear();
    controller.virtualItems.length = 0;
    installDocumentThumbnailListEnvironment();
});

afterEach(restoreDocumentThumbnailListEnvironment);

describe('DocumentThumbnailList row surface precedence', () => {
    it('keeps a committed canvas thumbnail free of failure semantics', () => {
        showRow(3);
        commitSurface(3, document.createElement('canvas'));
        controller.renderErrors.add(3);

        const {host} = mountDocumentThumbnailList(null);

        const rendered = documentThumbnailRow(host, 3);
        expect(rendered?.querySelector('.document-thumbnail-list__canvas-host')).not.toBeNull();
        expect(rendered?.querySelector('.document-thumbnail-list__error')).toBeNull();
        expect(rendered?.hasAttribute('data-thumbnail-render-error')).toBe(false);
        expect(rendered?.getAttribute('aria-label')).toBe('documentSourceSidebar.goToPage');
    });

    it('keeps a committed image thumbnail free of failure semantics', () => {
        showRow(4);
        commitSurface(4, 'blob:thumbnail-4');
        controller.renderErrors.add(4);

        const {host} = mountDocumentThumbnailList(null);

        const rendered = documentThumbnailRow(host, 4);
        expect(rendered?.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail-4');
        expect(rendered?.querySelector('.document-thumbnail-list__error')).toBeNull();
        expect(rendered?.hasAttribute('data-thumbnail-render-error')).toBe(false);
        expect(rendered?.getAttribute('aria-label')).toBe('documentSourceSidebar.goToPage');
    });

    it('marks the row as failed once there is no surface left to show', () => {
        showRow(3);
        controller.renderErrors.add(3);

        const {host} = mountDocumentThumbnailList(null);

        const failed = documentThumbnailRow(host, 3);
        expect(failed?.querySelector('.document-thumbnail-list__error')).not.toBeNull();
        expect(failed?.querySelector('.document-thumbnail-list__placeholder')).toBeNull();
        expect(failed?.hasAttribute('data-thumbnail-render-error')).toBe(true);
        expect(failed?.getAttribute('aria-label')).toBe('documentSourceSidebar.goToPageRenderFailed');
    });
});
