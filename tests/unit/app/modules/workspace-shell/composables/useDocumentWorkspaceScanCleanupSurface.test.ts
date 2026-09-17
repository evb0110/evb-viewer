// @vitest-environment happy-dom
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {useDocumentWorkspaceScanCleanupSurface} from '@app/modules/workspace-shell/composables/useDocumentWorkspaceScanCleanupSurface';
import type {IDocumentWorkspaceProps} from '@app/modules/workspace-shell/composables/createDocumentWorkspaceCommandBindings';
import type {IWorkspaceDocumentIdentity} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import { requireJobId } from '@contracts/shared';
import {
    scanCleanupAutoDetectionCanceledDocuments,
    scanCleanupDetectionSessionCache,
} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';

type TDocumentSession = NonNullable<IDocumentWorkspaceProps['documentSession']>;

function identity(overrides: Partial<IWorkspaceDocumentIdentity> = {}): IWorkspaceDocumentIdentity {
    return {
        documentSessionKey: 'session-1',
        documentInstanceId: null,
        documentRef: requireDocumentRef('/docs/current.pdf'),
        originalPath: requireDocumentRef('/docs/current.pdf'),
        workingCopyPath: requireDocumentRef('/work/current.pdf'),
        fileName: 'current.pdf',
        isDjvu: false,
        revisionInfo: null,
        ...overrides,
    };
}

function emptyIdentity(): IWorkspaceDocumentIdentity {
    return identity({
        documentSessionKey: null,
        documentRef: null,
        originalPath: null,
        workingCopyPath: null,
        fileName: null,
    });
}

function viewState(overrides: Partial<ITabViewSessionState> = {}): ITabViewSessionState {
    return {
        surfaceMode: 'reader',
        zoom: 1,
        effectiveZoom: 1,
        zoomMode: 'custom',
        fitMode: 'width',
        viewMode: 'single',
        showSidebar: false,
        continuousScroll: true,
        ...overrides,
    };
}

function detectionCacheEntry() {
    return {
        ownerId: 'owner-1',
        results: [],
        signatures: new Map<number, string>(),
        state: {
            jobId: requireJobId('detect-1'),
            status: 'completed' as const,
            progress: {
                stage: 'detecting' as const,
                completedUnits: 1,
                totalUnits: 1,
                percent: 100,
                completedPageNumbers: [1],
            },
            results: [],
            updatedAtMs: requireEpochMs(0),
        },
        totalPages: 1,
    };
}

describe('useDocumentWorkspaceScanCleanupSurface', () => {
    beforeEach(() => {
        localStorage.clear();
        scanCleanupDetectionSessionCache.clear();
        scanCleanupAutoDetectionCanceledDocuments.clear();
    });

    it('owns scan-cleanup transitions when no document session is available', () => {
        const closeAllDropdowns = vi.fn();
        const surface = useDocumentWorkspaceScanCleanupSurface({
            documentSession: null,
            initialViewState: viewState(),
            closeAllDropdowns,
            readDocumentKey: () => null,
        });

        surface.openScanCleanup();
        expect(closeAllDropdowns).toHaveBeenCalledOnce();
        expect(surface.surfaceMode.value).toBe('scan-cleanup');

        surface.closeScanCleanup();
        expect(surface.surfaceMode.value).toBe('reader');
        expect(surface.scanCleanupSessionState.value).toBeNull();
    });

    it('reads, writes, and clears the document session view state', () => {
        const snapshot = ref({
            ...({} as TDocumentSession['snapshot']['value']),
            identity: identity(),
            viewState: viewState({scanCleanup: {
                ownerId: 'cleanup-owner',
                previewPage: 3,
                previewViewMode: 'cleaned',
            }}),
        });
        const applyViewState = vi.fn((viewState: typeof snapshot.value.viewState) => {
            snapshot.value = {
                ...snapshot.value,
                viewState,
            };
        });
        const documentSession: TDocumentSession = {
            ...({} as TDocumentSession),
            snapshot,
            applyViewState,
        };
        const surface = useDocumentWorkspaceScanCleanupSurface({
            documentSession,
            initialViewState: null,
            closeAllDropdowns: vi.fn(),
            readDocumentKey: () => '/docs/current.pdf',
        });

        expect(surface.scanCleanupSessionState.value?.previewPage).toBe(3);
        surface.openScanCleanup();
        expect(applyViewState).toHaveBeenLastCalledWith({
            ...viewState(),
            surfaceMode: 'scan-cleanup',
        });

        surface.discardScanCleanupState();
        expect(applyViewState).toHaveBeenLastCalledWith({
            ...viewState(),
            surfaceMode: 'scan-cleanup',
        });
    });

    it('preserves an existing scan-cleanup page while restoring an already-open surface', () => {
        const snapshot = ref({
            ...({} as TDocumentSession['snapshot']['value']),
            identity: identity(),
            viewState: viewState({
                surfaceMode: 'scan-cleanup',
                scanCleanup: {
                    ownerId: 'cleanup-owner',
                    previewPage: 3,
                    previewViewMode: 'cleaned',
                },
            }),
        });
        const documentSession: TDocumentSession = {
            ...({} as TDocumentSession),
            snapshot,
            applyViewState: vi.fn(),
        };

        const surface = useDocumentWorkspaceScanCleanupSurface({
            documentSession,
            initialViewState: null,
            closeAllDropdowns: vi.fn(),
            readDocumentKey: () => '/docs/current.pdf',
        });

        expect(surface.surfaceMode.value).toBe('scan-cleanup');
        expect(surface.scanCleanupSessionState.value?.previewPage).toBe(3);
        expect(documentSession.applyViewState).not.toHaveBeenCalled();
    });

    it('leaves the scan-cleanup surface when the document identity empties', async () => {
        const snapshot = ref({
            ...({} as TDocumentSession['snapshot']['value']),
            identity: identity(),
            viewState: viewState({
                surfaceMode: 'scan-cleanup',
                scanCleanup: {
                    ownerId: 'cleanup-owner',
                    previewPage: 3,
                    previewViewMode: 'cleaned',
                },
            }),
        });
        const documentSession: TDocumentSession = {
            ...({} as TDocumentSession),
            snapshot,
            applyViewState: vi.fn((next: typeof snapshot.value.viewState) => {
                snapshot.value = {
                    ...snapshot.value,
                    viewState: next,
                };
            }),
        };

        const surface = useDocumentWorkspaceScanCleanupSurface({
            documentSession,
            initialViewState: null,
            closeAllDropdowns: vi.fn(),
            readDocumentKey: () => '/docs/current.pdf',
        });
        expect(surface.surfaceMode.value).toBe('scan-cleanup');

        snapshot.value = {
            ...snapshot.value,
            identity: emptyIdentity(),
        };
        await nextTick();

        expect(surface.surfaceMode.value).toBe('reader');
        expect(surface.scanCleanupSessionState.value).toBeNull();
    });

    it('retains authoritative detection for panel close but discards both aliases on document close', () => {
        const sourceSha256 = 'e'.repeat(64);
        const documentKey = '/docs/current.pdf';
        const provisionalKey = `${documentKey}\u0000revision-1`;
        const authoritativeKey = `${sourceSha256}\u0000revision-1`;
        const snapshot = ref({
            ...({} as TDocumentSession['snapshot']['value']),
            identity: identity(),
            viewState: viewState({surfaceMode: 'scan-cleanup'}),
        });
        const documentSession: TDocumentSession = {
            ...({} as TDocumentSession),
            snapshot,
            applyViewState: vi.fn((next: typeof snapshot.value.viewState) => {
                snapshot.value = {
                    ...snapshot.value,
                    viewState: next,
                };
            }),
        };
        const surface = useDocumentWorkspaceScanCleanupSurface({
            documentSession,
            initialViewState: null,
            closeAllDropdowns: vi.fn(),
            readDocumentKey: () => documentKey,
            readSourceSha256: () => sourceSha256,
        });
        scanCleanupDetectionSessionCache.set(provisionalKey, detectionCacheEntry());
        scanCleanupDetectionSessionCache.set(authoritativeKey, detectionCacheEntry());
        scanCleanupAutoDetectionCanceledDocuments.add(provisionalKey);
        scanCleanupAutoDetectionCanceledDocuments.add(authoritativeKey);

        surface.closeScanCleanup();
        expect(scanCleanupDetectionSessionCache.has(authoritativeKey)).toBe(true);
        expect(scanCleanupAutoDetectionCanceledDocuments.has(authoritativeKey)).toBe(true);

        surface.discardScanCleanupState();
        expect(scanCleanupDetectionSessionCache.size).toBe(0);
        expect(scanCleanupAutoDetectionCanceledDocuments.size).toBe(0);
    });

    it('stays on the reader surface for a session that never had a document', async () => {
        const snapshot = ref({
            ...({} as TDocumentSession['snapshot']['value']),
            identity: emptyIdentity(),
            viewState: viewState(),
        });
        const documentSession: TDocumentSession = {
            ...({} as TDocumentSession),
            snapshot,
            applyViewState: vi.fn((next: typeof snapshot.value.viewState) => {
                snapshot.value = {
                    ...snapshot.value,
                    viewState: next,
                };
            }),
        };

        const surface = useDocumentWorkspaceScanCleanupSurface({
            documentSession,
            initialViewState: null,
            closeAllDropdowns: vi.fn(),
            readDocumentKey: () => null,
        });

        snapshot.value = {
            ...snapshot.value,
            identity: identity(),
        };
        await nextTick();
        surface.openScanCleanup();
        await nextTick();

        expect(surface.surfaceMode.value).toBe('scan-cleanup');
    });
});
