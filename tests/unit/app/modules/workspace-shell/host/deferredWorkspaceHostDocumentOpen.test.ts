import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    canBeginDocumentOpenSynchronously,
    createWorkspaceDocumentOpenTransactions,
    resolveDocumentOpenRunResult,
    resolveOpenSurfaceDocumentId,
    resolvePreparedPdfOpeningGeometry,
    shouldWaitForPreparedOpeningOwner,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createDeferredWorkspaceLoadGateway } from '@app/modules/workspace-shell/host/createDeferredWorkspaceLoadGateway';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type ICloseFileFromUiOptions,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { workspaceSessionHasOpenedDocument } from '@app/modules/workspace-shell/host/deferredWorkspaceHostState';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

const PDF_GEOMETRY: IPdfOpeningGeometry = {
    pageNumber: requirePageNumber(1),
    pageCount: 431,
    width: 612,
    height: 792,
    rotation: 0 as const,
    size: 538_000_000,
    modifiedAt: requireEpochMs(1_720_000_000_000),
};

describe('deferredWorkspaceHostDocumentOpen', () => {
    it('commits document opens only after a terminal state is reached', () => {
        expect(resolveDocumentOpenRunResult('opened', true)).toBe('opened');
        expect(resolveDocumentOpenRunResult('opened', false)).toBe(false);
        expect(resolveDocumentOpenRunResult(false, true)).toBe(false);
    });

    it('uses the geometry/viewer original path instead of a differing transaction ref', () => {
        expect(resolveOpenSurfaceDocumentId(
            {originalPath: requireDocumentRef('/documents/original.pdf')},
            requireDocumentRef('/managed/working-copy.pdf'),
            'tab-1',
        )).toBe('/documents/original.pdf');
        expect(resolveOpenSurfaceDocumentId(null, requireDocumentRef('/managed/working-copy.pdf'), 'tab-1'))
            .toBe('/managed/working-copy.pdf');
        expect(resolveOpenSurfaceDocumentId(null, null, 'tab-1')).toBe('tab-1');
    });

    it('binds authoritative main-process PDF geometry to the host document identity', () => {
        const geometry = resolvePreparedPdfOpeningGeometry(requireDocumentRef('/documents/scan.pdf'), PDF_GEOMETRY);

        expect(geometry).toEqual({
            documentId: '/documents/scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
            size: 538_000_000,
            modifiedAt: 1_720_000_000_000,
        });
        expect(Object.isFrozen(geometry)).toBe(true);
        expect(resolvePreparedPdfOpeningGeometry('', geometry)).toBeNull();
        expect(resolvePreparedPdfOpeningGeometry(requireDocumentRef('/documents/scan.pdf'), null)).toBeNull();
    });

    it('waits only when a prepared frame still lacks its canonical viewer owner', () => {
        expect(shouldWaitForPreparedOpeningOwner(true, false)).toBe(true);
        expect(shouldWaitForPreparedOpeningOwner(true, true)).toBe(false);
        expect(shouldWaitForPreparedOpeningOwner(false, false)).toBe(false);
        expect(shouldWaitForPreparedOpeningOwner(false, true)).toBe(false);
    });

    it('permits synchronous ownership only for an exact premounted Recent frame', () => {
        expect(canBeginDocumentOpenSynchronously('openRecentFromPlaceholder', true, true)).toBe(true);
        expect(canBeginDocumentOpenSynchronously('openRecentFromPlaceholder', false, true)).toBe(false);
        expect(canBeginDocumentOpenSynchronously('openRecentFromPlaceholder', true, false)).toBe(false);
        expect(canBeginDocumentOpenSynchronously('handleOpenFileWithResultFromUi', true, true)).toBe(false);
        expect(canBeginDocumentOpenSynchronously('restoreColdDocument', true, true)).toBe(false);
    });

    it('publishes open identity before source loading and resolves after the document is accepted', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        let toolbarSnapshot = createDefaultWorkspaceToolbarSnapshot();
        const waitForDocumentOpenSettled = vi.fn(async () => {
            toolbarSnapshot = {
                ...toolbarSnapshot,
                hasPdf: true,
                initialVisualReady: true,
                totalPages: 1,
                viewerCapabilities: {
                    ...createDefaultWorkspaceViewerCapabilities(),
                    closeableDocument: true,
                    pdfDocument: true,
                    pdfMutationActions: true,
                },
            };
        });
        const workspace = createWorkspaceExposeFixture({
            getToolbarSnapshot: () => toolbarSnapshot,
            waitForDocumentOpenSettled,
        });
        controller.attachWorkspace(workspace);
        controller.attachOpenTransactionHost({
            documentOpenSurface: createDocumentOpenSurfaceSession(),
            openingPageFrameAuthority: shallowRef(null),
            ensureWorkspaceLoaded: async () => workspace,
            getActiveTransactionId: () => controller.snapshot.value.activeTransaction?.id ?? null,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: () => toolbarSnapshot,
            hasDocumentOrOpenError: () => toolbarSnapshot.hasOpenError
                || toolbarSnapshot.viewerCapabilities.pdfDocument,
            hasOpenedDocument: () => toolbarSnapshot.viewerCapabilities.pdfDocument,
            hasSessionOpenedDocument: () => workspaceSessionHasOpenedDocument(controller.snapshot.value),
            isHostUnmounted: () => false,
            isViewerOwnerMounted: () => true,
            publishDocumentRecord: record => controller.applyWorkspaceRecord(record, 'host'),
            requestWorkspaceMount: vi.fn(),
        });
        const sourceOpen = vi.fn(async () => {
            expect(controller.snapshot.value.activeTransaction).not.toBeNull();
            expect(controller.snapshot.value.identity.originalPath).toBe('/documents/generated.pdf');
            return true;
        });

        await expect(controller.open({
            action: 'handleOpenFileDirectWithPersist',
            target: {
                fileName: 'generated.pdf',
                originalPath: requireDocumentRef('/documents/generated.pdf'),
                isDjvu: false,
            },
        }, sourceOpen)).resolves.toBe(true);

        expect(sourceOpen).toHaveBeenCalledOnce();
        expect(waitForDocumentOpenSettled).toHaveBeenCalledWith({signal: expect.any(AbortSignal)});
        expect(controller.snapshot.value.activeTransaction).toBeNull();
        expect(controller.snapshot.value.identity.originalPath).toBe('/documents/generated.pdf');
        expect(workspaceSessionHasOpenedDocument(controller.snapshot.value)).toBe(true);
        expect(toolbarSnapshot.initialVisualReady).toBe(true);
        expect(toolbarSnapshot.viewerCapabilities.pdfDocument).toBe(true);
    });

    it('does not release the open transaction until the canonical first visual is ready', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        let toolbarSnapshot = {
            ...createDefaultWorkspaceToolbarSnapshot(),
            hasPdf: true,
            initialVisualReady: false,
            isOpeningDocument: true,
            totalPages: 17,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
                pdfMutationActions: true,
            },
        };
        const waitForDocumentOpenSettled = vi.fn(async () => {
            toolbarSnapshot = {
                ...toolbarSnapshot,
                initialVisualReady: true,
                isOpeningDocument: false,
            };
        });
        const workspace = createWorkspaceExposeFixture({
            getToolbarSnapshot: () => toolbarSnapshot,
            waitForDocumentOpenSettled,
        });
        controller.attachWorkspace(workspace);
        controller.attachOpenTransactionHost({
            documentOpenSurface: createDocumentOpenSurfaceSession(),
            openingPageFrameAuthority: shallowRef(null),
            ensureWorkspaceLoaded: async () => workspace,
            getActiveTransactionId: () => controller.snapshot.value.activeTransaction?.id ?? null,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: () => toolbarSnapshot,
            hasDocumentOrOpenError: () => true,
            hasOpenedDocument: () => true,
            hasSessionOpenedDocument: () => workspaceSessionHasOpenedDocument(controller.snapshot.value),
            isHostUnmounted: () => false,
            isViewerOwnerMounted: () => true,
            publishDocumentRecord: record => controller.applyWorkspaceRecord(record, 'host'),
            requestWorkspaceMount: vi.fn(),
        });

        await expect(controller.open({
            action: 'handleOpenFileWithResultFromUi',
            target: {
                fileName: 'generated.pdf',
                originalPath: requireDocumentRef('/documents/generated.pdf'),
                isDjvu: false,
            },
        }, async () => true)).resolves.toBe(true);

        expect(controller.snapshot.value.activeTransaction).toBeNull();
        expect(waitForDocumentOpenSettled).toHaveBeenCalledOnce();
        expect(waitForDocumentOpenSettled).toHaveBeenCalledWith({signal: expect.any(AbortSignal)});
        expect(toolbarSnapshot.initialVisualReady).toBe(true);
    });

    it('does not let a stale failed open clear a newer transaction presentation', async () => {
        const documentOpenSurface = createDocumentOpenSurfaceSession();
        const toolbarSnapshot = createDefaultWorkspaceToolbarSnapshot();
        const workspace = createWorkspaceExposeFixture({
            getToolbarSnapshot: () => toolbarSnapshot,
            waitForDocumentOpenSettled: vi.fn(async () => {}),
        });
        let activeTransactionId = 'transaction-a';
        const publishDocumentRecord = vi.fn();
        const transactions = createWorkspaceDocumentOpenTransactions({
            tabId: 'tab-1',
            mountedWorkspace: shallowRef(workspace),
        });
        transactions.attachHost({
            documentOpenSurface,
            openingPageFrameAuthority: shallowRef(null),
            ensureWorkspaceLoaded: async () => workspace,
            getActiveTransactionId: () => activeTransactionId,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: () => toolbarSnapshot,
            hasDocumentOrOpenError: () => false,
            hasOpenedDocument: () => false,
            hasSessionOpenedDocument: () => false,
            isHostUnmounted: () => false,
            isViewerOwnerMounted: () => true,
            publishDocumentRecord,
            requestWorkspaceMount: vi.fn(),
        });

        await expect(transactions.run({
            action: 'handleOpenFileWithResultFromUi',
            target: {
                fileName: 'a.pdf',
                originalPath: requireDocumentRef('/documents/a.pdf'),
                isDjvu: false,
            },
        }, 'transaction-a', requireDocumentRef('/documents/a.pdf'), async () => {
            activeTransactionId = 'transaction-b';
            documentOpenSurface.begin({
                documentId: '/documents/b.pdf',
                documentRevision: 'open-intent:transaction-b',
            });
            return false;
        }, new AbortController().signal)).resolves.toBe(false);

        expect(documentOpenSurface.snapshot.value.identity).toEqual({
            documentId: '/documents/b.pdf',
            documentRevision: 'open-intent:transaction-b',
        });
        expect(publishDocumentRecord).toHaveBeenCalledOnce();
        expect(publishDocumentRecord).toHaveBeenCalledWith(expect.objectContaining(
            {tab: expect.objectContaining({originalPath: '/documents/a.pdf'})},
        ));
    });

    it('claims an early startup Recent command before queueing for its viewer owner', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const documentOpenSurface = createDocumentOpenSurfaceSession();
        const ownerGate = Promise.withResolvers<undefined>();
        const publishDocumentRecord = vi.fn(record => controller.applyWorkspaceRecord(record, 'host'));
        controller.attachOpenTransactionHost({
            documentOpenSurface,
            openingPageFrameAuthority: shallowRef(null),
            ensureWorkspaceLoaded: async () => {
                await ownerGate.promise;
                return null;
            },
            getActiveTransactionId: () => controller.snapshot.value.activeTransaction?.id ?? null,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: createDefaultWorkspaceToolbarSnapshot,
            hasDocumentOrOpenError: () => false,
            hasOpenedDocument: () => false,
            hasSessionOpenedDocument: () => false,
            isHostUnmounted: () => false,
            isViewerOwnerMounted: () => false,
            publishDocumentRecord,
            requestWorkspaceMount: vi.fn(),
        });
        const run = vi.fn(async () => true);
        const opening = controller.open({
            action: 'openRecentFromPlaceholder',
            preparedOpeningGeometry: PDF_GEOMETRY,
            target: {originalPath: requireDocumentRef('/documents/scan.pdf')},
        }, run);
        controller.requestDocumentPage(2);

        expect(documentOpenSurface.snapshot.value.identity?.documentId).toBe('/documents/scan.pdf');
        expect(documentOpenSurface.viewportSession.value.requestedPage).toBe(2);
        expect(publishDocumentRecord).toHaveBeenCalledWith(expect.objectContaining(
            {toolbarSnapshot: expect.objectContaining({
                currentPage: 1,
                totalPages: 431,
                isOpeningDocument: true,
            })},
        ));
        expect(controller.snapshot.value.toolbarSnapshot.totalPages).toBe(431);
        expect(run).not.toHaveBeenCalled();
        ownerGate.resolve(undefined);
        await expect(opening).resolves.toBe(false);
        expect(run).not.toHaveBeenCalled();
    });

    it('does not dispatch a deferred source open after close aborts its mount wait', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
        const requestWorkspaceMount = vi.fn();
        const realOpen = vi.fn(async () => true);
        const loadGateway = createDeferredWorkspaceLoadGateway({
            tabId: 'tab-1',
            mountedWorkspace,
            workspaceChunkLoadError: ref<unknown>(null),
            loadDocumentWorkspace: async () => undefined,
            requestWorkspaceMount,
            isHostUnmounted: () => false,
        });
        controller.attachWorkspace(createWorkspaceExposeFixture({handleCloseFileFromUi: async (options?: ICloseFileFromUiOptions) => {
            options?.onCloseCommit?.();
            return true;
        }}));

        const opening = controller.open({
            action: 'openRecentFromPlaceholder',
            target: {originalPath: requireDocumentRef('/documents/scan.pdf')},
        }, signal => loadGateway.withWorkspace(
            'openRecentFromPlaceholder',
            workspace => workspace.handleOpenFileDirectWithPersist(requireDocumentRef('/documents/scan.pdf')),
            signal,
        ));

        expect(requestWorkspaceMount).toHaveBeenCalledOnce();
        await expect(controller.close({persist: false})).resolves.toBe(true);
        await expect(opening).resolves.toBe(false);

        mountedWorkspace.value = createWorkspaceExposeFixture({handleOpenFileDirectWithPersist: realOpen});
        await Promise.resolve();
        await Promise.resolve();

        expect(realOpen).not.toHaveBeenCalled();
        loadGateway.dispose();
    });

    it('refuses opens after the presentation host detaches instead of running them bare', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
        const detach = controller.attachOpenTransactionHost({
            documentOpenSurface: createDocumentOpenSurfaceSession(),
            openingPageFrameAuthority: shallowRef(null),
            ensureWorkspaceLoaded: async () => null,
            getActiveTransactionId: () => controller.snapshot.value.activeTransaction?.id ?? null,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: createDefaultWorkspaceToolbarSnapshot,
            hasDocumentOrOpenError: () => false,
            hasOpenedDocument: () => false,
            hasSessionOpenedDocument: () => false,
            isHostUnmounted: () => true,
            isViewerOwnerMounted: () => false,
            publishDocumentRecord: vi.fn(),
            requestWorkspaceMount: vi.fn(),
        });
        detach();

        const run = vi.fn(async () => true);
        await expect(controller.open({
            action: 'openRecentFromPlaceholder',
            target: {originalPath: requireDocumentRef('/documents/scan.pdf')},
        }, run)).resolves.toBe(false);
        expect(run).not.toHaveBeenCalled();
    });
});
