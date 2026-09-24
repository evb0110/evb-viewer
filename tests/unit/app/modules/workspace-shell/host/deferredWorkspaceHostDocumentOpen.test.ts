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
import { requireDocumentRef } from '@contracts/documentRef';
import {
    createWorkspaceDocumentOpenTransactions,
    resolveDocumentOpenRunResult,
    resolveOpenSurfaceDocumentId,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createDeferredWorkspaceLoadGateway } from '@app/modules/workspace-shell/host/createDeferredWorkspaceLoadGateway';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type ICloseFileFromUiOptions,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { workspaceSessionHasOpenedDocument } from '@app/modules/workspace-shell/host/deferredWorkspaceHostState';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

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
            getActiveTransactionId: () => controller.snapshot.value.activeTransaction?.id ?? null,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: () => toolbarSnapshot,
            hasDocumentOrOpenError: () => toolbarSnapshot.hasOpenError
                || toolbarSnapshot.viewerCapabilities.pdfDocument,
            hasOpenedDocument: () => toolbarSnapshot.viewerCapabilities.pdfDocument,
            hasSessionOpenedDocument: () => workspaceSessionHasOpenedDocument(controller.snapshot.value),
            isHostUnmounted: () => false,
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
            getActiveTransactionId: () => controller.snapshot.value.activeTransaction?.id ?? null,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: () => toolbarSnapshot,
            hasDocumentOrOpenError: () => true,
            hasOpenedDocument: () => true,
            hasSessionOpenedDocument: () => workspaceSessionHasOpenedDocument(controller.snapshot.value),
            isHostUnmounted: () => false,
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
            getActiveTransactionId: () => activeTransactionId,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: () => toolbarSnapshot,
            hasDocumentOrOpenError: () => false,
            hasOpenedDocument: () => false,
            hasSessionOpenedDocument: () => false,
            isHostUnmounted: () => false,
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
            getActiveTransactionId: () => controller.snapshot.value.activeTransaction?.id ?? null,
            getInitialViewState: () => null,
            getSeedToolbarSnapshot: createDefaultWorkspaceToolbarSnapshot,
            hasDocumentOrOpenError: () => false,
            hasOpenedDocument: () => false,
            hasSessionOpenedDocument: () => false,
            isHostUnmounted: () => true,
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
