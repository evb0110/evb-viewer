import {
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IDocumentOutlineItem,
    IDocumentPageSource,
} from '@app/modules/document-viewer/source/documentPageSource';
import { useDocumentBookmarkSession } from '@app/modules/document-viewer/bookmarks/useDocumentBookmarkSession';
import {requireDocumentRef} from '@contracts/documentRef';

function createSource(getOutline: NonNullable<IDocumentPageSource['outlineProvider']>['getOutline']): IDocumentPageSource {
    return {
        kind: 'djvu',
        documentRef: requireDocumentRef('/test.djvu'),
        pageCount: 4,
        outlineProvider: {getOutline},
        getPageMetrics: vi.fn(),
        renderPage: vi.fn(),
        dispose: vi.fn(),
    };
}

function createDeferredOutline() {
    let resolve!: (value: IDocumentOutlineItem[]) => void;
    const promise = new Promise<IDocumentOutlineItem[]>((nextResolve) => {
        resolve = nextResolve;
    });
    return {
        promise,
        resolve,
    };
}

async function flush() {
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
}

describe('useDocumentBookmarkSession', () => {
    it('loads an initially active provider and derives the current active path', async () => {
        const source = shallowRef<IDocumentPageSource | null>(createSource(vi.fn().mockResolvedValue([{
            title: 'Part',
            pageNumber: 1,
            children: [{
                title: 'Chapter',
                pageNumber: 2,
                children: [],
            }],
        }])));
        const scope = effectScope();
        const session = scope.run(() => useDocumentBookmarkSession({
            source,
            currentPage: ref(2),
            isActive: ref(true),
        }))!;

        await flush();

        expect(session.items.value[0]?.children[0]?.title).toBe('Chapter');
        expect(session.activeId.value).toBe('document-bookmark-0-0');
        expect(session.activePathIds.value).toEqual(new Set([
            'document-bookmark-0',
            'document-bookmark-0-0',
        ]));
        scope.stop();
    });

    it('aborts an in-flight provider when the bookmark panel becomes inactive', async () => {
        const captured: {signal?: AbortSignal} = {};
        const getOutline = vi.fn((_signal: AbortSignal) => {
            captured.signal = _signal;
            return new Promise<never>(() => undefined);
        });
        const active = ref(true);
        const scope = effectScope();
        scope.run(() => useDocumentBookmarkSession({
            source: shallowRef<IDocumentPageSource | null>(createSource(getOutline)),
            currentPage: ref(1),
            isActive: active,
        }));
        await nextTick();

        active.value = false;
        await nextTick();

        expect(captured.signal?.aborted).toBe(true);
        scope.stop();
    });
    it('reports one outline status across loading, error, empty, and ready', async () => {
        const outline = createDeferredOutline();
        const scope = effectScope();
        const session = scope.run(() => useDocumentBookmarkSession({
            source: shallowRef<IDocumentPageSource | null>(createSource(() => outline.promise)),
            currentPage: ref(1),
            isActive: ref(true),
        }))!;

        try {
            expect(session.status.value).toBe('loading');

            outline.resolve([{
                title: 'Part',
                pageNumber: 1,
                children: [],
            }]);
            await flush();

            expect(session.status.value).toBe('ready');
        } finally {
            scope.stop();
        }
    });

    it('represents a failed outline load as an error status carrying the reason', async () => {
        const scope = effectScope();
        const session = scope.run(() => useDocumentBookmarkSession({
            source: shallowRef<IDocumentPageSource | null>(createSource(
                vi.fn().mockRejectedValue(new Error('outline stream is corrupt')),
            )),
            currentPage: ref(1),
            isActive: ref(true),
        }))!;

        try {
            await flush();

            expect(session.status.value).toBe('error');
            expect(session.error.value).toBe('outline stream is corrupt');
            expect(session.items.value).toEqual([]);
        } finally {
            scope.stop();
        }
    });

    it('separates an empty outline from a failed one', async () => {
        const scope = effectScope();
        const session = scope.run(() => useDocumentBookmarkSession({
            source: shallowRef<IDocumentPageSource | null>(createSource(vi.fn().mockResolvedValue([]))),
            currentPage: ref(1),
            isActive: ref(true),
        }))!;

        try {
            await flush();

            expect(session.status.value).toBe('empty');
            expect(session.error.value).toBeNull();
        } finally {
            scope.stop();
        }
    });
});
