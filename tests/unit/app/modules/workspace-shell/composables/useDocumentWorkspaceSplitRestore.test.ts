import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createRenderer,
    nextTick,
    ref,
    watch,
} from 'vue';
import type { Component } from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import { requireDocumentRef } from '@contracts/documentRef';

const mocks = vi.hoisted(() => ({
    cleanupSplitPayloadSnapshot: vi.fn(),
    loggerDebug: vi.fn(),
    loggerWarn: vi.fn(),
}));

vi.mock('@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot', () => ({cleanupSplitPayloadSnapshot: mocks.cleanupSplitPayloadSnapshot}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    debug: mocks.loggerDebug,
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    warn: mocks.loggerWarn,
}}));

function installVueAutoImportStubs() {
    vi.stubGlobal('computed', computed);
    vi.stubGlobal('watch', watch);
}

function createNoopApp(component: Component) {
    const renderer = createRenderer<unknown, unknown>({
        patchProp: vi.fn(),
        insert: vi.fn(),
        remove: vi.fn(),
        createElement: vi.fn(() => ({})),
        createText: vi.fn(() => ({})),
        createComment: vi.fn(() => ({})),
        setText: vi.fn(),
        setElementText: vi.fn(),
        parentNode: vi.fn(() => null),
        nextSibling: vi.fn(() => null),
    });
    return renderer.createApp(component);
}

async function flushPromises() {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

describe('useDocumentWorkspaceSplitRestore', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        installVueAutoImportStubs();
        mocks.cleanupSplitPayloadSnapshot.mockResolvedValue(true);
    });

    it.each([
        {status: 'cancelled' as const},
        {
            status: 'failed' as const,
            error: 'restore failed',
        },
        {
            status: 'stale' as const,
            result: {
                kind: 'pdf',
                workingPath: requireDocumentRef('/tmp/split-snapshot.pdf'),
                originalPath: requireDocumentRef('/tmp/sample.pdf'),
            },
        },
        {
            status: 'prepared' as const,
            result: {
                kind: 'pdf',
                workingPath: requireDocumentRef('/tmp/split-snapshot.pdf'),
                originalPath: requireDocumentRef('/tmp/sample.pdf'),
            },
        },
    ])('retains a cached snapshot after a $status restore outcome', async (outcome) => {
        const payload: TSplitPayload = {
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: requireDocumentRef('/tmp/sample.pdf'),
            snapshotPath: requireDocumentRef('/tmp/split-snapshot.pdf'),
            isDirty: false,
            currentPage: 3,
            totalPages: 9,
        };
        let cachedPresent = true;
        const workspaceSplitCache = {
            has: vi.fn(() => cachedPresent),
            peek: vi.fn(() => ({
                id: 'entry-1',
                payload,
            })),
            consume: vi.fn(() => {
                cachedPresent = false;
                return payload;
            }),
            clear: vi.fn(),
            set: vi.fn(),
        };
        const restoreSplitPayload = Object.assign(vi.fn(async (): Promise<TDocumentOpenOutcome> => outcome as TDocumentOpenOutcome), {lastOutcome: outcome});
        const { useDocumentWorkspaceSplitRestore } = await import(
            '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore'
        );

        const app = createNoopApp({setup() {
            useDocumentWorkspaceSplitRestore({
                tabId: 'tab-1',
                pendingDocumentOpen: computed(() => false),
                isTabTransitionBusy: computed(() => false),
                workspaceSplitCache,
                workspaceRestoreTracker: {
                    has: vi.fn(() => false),
                    start: vi.fn(),
                    finish: vi.fn(),
                },
                hasPdf: ref(false),
                currentPage: ref(1),
                totalPages: ref(0),
                showSidebar: ref(false),
                sidebarTab: ref(null),
                isResizingSidebar: ref(false),
                isLoading: ref(false),
                continuousScroll: ref(false),
                fitMode: ref(null),
                viewMode: ref(null),
                zoom: ref(1),
                documentViewerRef: ref(null),
                initFromStorage: vi.fn(),
                cleanupSidebarResizeListeners: vi.fn(),
                captureSplitPayload: vi.fn(),
                restoreSplitPayload,
                isRestoringSplitPayload: ref(false),
                currentPageTransitionHistory: ref([]),
            });
            return () => null;
        }});

        app.mount({});
        await flushPromises();
        app.unmount();

        expect(restoreSplitPayload).toHaveBeenCalledWith(payload);
        expect(workspaceSplitCache.consume).not.toHaveBeenCalled();
        expect(mocks.cleanupSplitPayloadSnapshot).not.toHaveBeenCalled();
    });

    it('preseeds DjVu cached payload paging before restore', async () => {
        const payload: TSplitPayload = {
            kind: 'djvu',
            sourcePath: requireDocumentRef('/tmp/sample.djvu'),
            currentPage: 5,
            totalPages: 12,
        };
        const currentPage = ref(1);
        const totalPages = ref(0);
        let cachedPresent = true;
        const workspaceSplitCache = {
            has: vi.fn(() => cachedPresent),
            peek: vi.fn(() => ({
                id: 'entry-1',
                payload,
            })),
            consume: vi.fn(() => {
                cachedPresent = false;
                return payload;
            }),
            clear: vi.fn(),
            set: vi.fn(),
        };
        const restoreSplitPayload = vi.fn(async () => ({
            status: 'opened' as const,
            result: {
                kind: 'djvu' as const,
                workingPath: '' as const,
                originalPath: payload.sourcePath,
            },
        }));
        const { useDocumentWorkspaceSplitRestore } = await import(
            '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore'
        );

        const app = createNoopApp({setup() {
            useDocumentWorkspaceSplitRestore({
                tabId: 'tab-1',
                pendingDocumentOpen: computed(() => false),
                isTabTransitionBusy: computed(() => false),
                workspaceSplitCache,
                workspaceRestoreTracker: {
                    has: vi.fn(() => false),
                    start: vi.fn(),
                    finish: vi.fn(),
                },
                hasPdf: ref(false),
                currentPage,
                totalPages,
                showSidebar: ref(false),
                sidebarTab: ref(null),
                isResizingSidebar: ref(false),
                isLoading: ref(false),
                continuousScroll: ref(false),
                fitMode: ref(null),
                viewMode: ref(null),
                zoom: ref(1),
                documentViewerRef: ref(null),
                initFromStorage: vi.fn(),
                cleanupSidebarResizeListeners: vi.fn(),
                captureSplitPayload: vi.fn(),
                restoreSplitPayload,
                isRestoringSplitPayload: ref(false),
                currentPageTransitionHistory: ref([]),
            });
            return () => null;
        }});

        app.mount({});
        await flushPromises();
        app.unmount();

        expect(currentPage.value).toBe(5);
        expect(totalPages.value).toBe(12);
        expect(restoreSplitPayload).toHaveBeenCalledWith(payload);
        expect(workspaceSplitCache.consume).toHaveBeenCalledWith('tab-1', 'entry-1');
    });

    it('does not retry a failed DjVu payload in a loop within one mount', async () => {
        const payload: TSplitPayload = {
            kind: 'djvu',
            sourcePath: requireDocumentRef('/tmp/sample.djvu'),
            currentPage: 5,
            totalPages: 12,
        };
        // The entry is never consumed on the DjVu failure path, so it stays
        // queued. Clearing isRestoringSplitPayload re-triggers the restore
        // watcher; without the failed-entry guard this would restore the same
        // payload again and again inside a single mount.
        const workspaceSplitCache = {
            has: vi.fn(() => true),
            peek: vi.fn(() => ({
                id: 'entry-1',
                payload,
            })),
            consume: vi.fn(),
            clear: vi.fn(),
            set: vi.fn(),
        };
        const restoreSplitPayload = vi.fn(async () => {
            throw new Error('restore failed');
        });
        const { useDocumentWorkspaceSplitRestore } = await import(
            '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore'
        );

        const app = createNoopApp({setup() {
            useDocumentWorkspaceSplitRestore({
                tabId: 'tab-1',
                pendingDocumentOpen: computed(() => false),
                isTabTransitionBusy: computed(() => false),
                workspaceSplitCache,
                workspaceRestoreTracker: {
                    has: vi.fn(() => false),
                    start: vi.fn(),
                    finish: vi.fn(),
                },
                hasPdf: ref(false),
                currentPage: ref(1),
                totalPages: ref(0),
                showSidebar: ref(false),
                sidebarTab: ref(null),
                isResizingSidebar: ref(false),
                isLoading: ref(false),
                continuousScroll: ref(false),
                fitMode: ref(null),
                viewMode: ref(null),
                zoom: ref(1),
                documentViewerRef: ref(null),
                initFromStorage: vi.fn(),
                cleanupSidebarResizeListeners: vi.fn(),
                captureSplitPayload: vi.fn(),
                restoreSplitPayload,
                isRestoringSplitPayload: ref(false),
                currentPageTransitionHistory: ref([]),
            });
            return () => null;
        }});

        app.mount({});
        await flushPromises();
        await flushPromises();
        await flushPromises();
        app.unmount();

        expect(restoreSplitPayload).toHaveBeenCalledTimes(1);
        expect(workspaceSplitCache.consume).not.toHaveBeenCalled();
        expect(mocks.cleanupSplitPayloadSnapshot).not.toHaveBeenCalled();
    });
});
