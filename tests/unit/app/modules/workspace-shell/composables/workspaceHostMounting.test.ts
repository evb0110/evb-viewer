import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveWorkspaceRequestedState } from '@app/modules/workspace-shell/host/resolveWorkspaceRequestedState';
import { shouldAutoRequestWorkspace } from '@app/modules/workspace-shell/host/shouldAutoRequestWorkspace';
import { shouldPreloadWorkspaceOnHostMount } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceOnHostMount';
import { scheduleActiveEmptyWorkspacePremount } from '@app/modules/workspace-shell/host/scheduleActiveEmptyWorkspacePremount';
import {
    getWorkspaceViewerChunkTargetsForPaths,
    warmupDesktopViewerChunkForPaths,
    warmupDesktopViewerChunks,
} from '@app/modules/workspace-shell/host/warmupDesktopViewerChunks';
import type {
    TWorkspaceViewerChunkLoader,
    TWorkspaceViewerChunkTarget,
} from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import {
    shouldKeepWorkspacePendingDocumentHint,
    shouldShowWorkspacePlaceholder,
} from '@app/modules/workspace-shell/host/shouldShowWorkspacePlaceholder';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import { requireDocumentRef } from '@contracts/documentRef';

function createRecordingViewerChunkLoaders(loadedChunks: string[]) {
    const record = (target: TWorkspaceViewerChunkTarget) => () => {
        loadedChunks.push(target);
        return Promise.resolve();
    };
    return {
        chassis: record('chassis'),
        pdfjs: record('pdfjs'),
        'native-pdf': record('native-pdf'),
        'page-source': record('page-source'),
    } satisfies Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>;
}

function createAnimationFrameHost() {
    let nextHandle = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    return {
        host: {
            requestAnimationFrame(callback: FrameRequestCallback) {
                const handle = nextHandle;
                nextHandle += 1;
                callbacks.set(handle, callback);
                return handle;
            },
            cancelAnimationFrame(handle: number) {
                callbacks.delete(handle);
            },
        },
        runFrame() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach(callback => callback(0));
        },
        pendingCount: () => callbacks.size,
    };
}

describe('tabHasDocumentHint', () => {
    it('returns false for placeholder tabs', () => {
        expect(tabHasDocumentHint({
            fileName: null,
            originalPath: null,
            isDjvu: false,
        })).toBe(false);
    });

    it('returns true when file name exists', () => {
        expect(tabHasDocumentHint({
            fileName: 'invoice.pdf',
            originalPath: null,
            isDjvu: false,
        })).toBe(true);
    });

    it('returns true when original path exists', () => {
        expect(tabHasDocumentHint({
            fileName: null,
            originalPath: requireDocumentRef('/docs/invoice.pdf'),
            isDjvu: false,
        })).toBe(true);
    });

    it('returns true when tab is in DjVu mode', () => {
        expect(tabHasDocumentHint({
            fileName: null,
            originalPath: null,
            isDjvu: true,
        })).toBe(true);
    });
});

describe('workspace host mount request state', () => {
    it('opens the active-empty premount gate only after one committed paint', () => {
        const animationFrames = createAnimationFrameHost();
        let ready = false;
        scheduleActiveEmptyWorkspacePremount(() => { ready = true; }, animationFrames.host);

        expect(animationFrames.pendingCount()).toBe(1);
        animationFrames.runFrame();
        expect(ready).toBe(false);
        expect(animationFrames.pendingCount()).toBe(1);
        animationFrames.runFrame();
        expect(ready).toBe(true);
    });

    it('cancels active-empty premount work with the host lifecycle', () => {
        const animationFrames = createAnimationFrameHost();
        let ready = false;
        const cancel = scheduleActiveEmptyWorkspacePremount(() => { ready = true; }, animationFrames.host);

        animationFrames.runFrame();
        cancel();
        animationFrames.runFrame();
        expect(ready).toBe(false);
        expect(animationFrames.pendingCount()).toBe(0);
    });

    it('requests mount when split restore is queued', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: true,
            hasDocumentHint: false,
            isActive: false,
            canPremountActiveEmpty: false,
        })).toBe(true);
    });

    it('waits to mount inactive tabs with only a document hint', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: false,
            canPremountActiveEmpty: true,
        })).toBe(false);
    });

    it('requests mount when an active tab has a document hint', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
            canPremountActiveEmpty: false,
        })).toBe(true);
    });

    it('mounts the real workspace viewport behind an active empty tab only after its first paint', () => {
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
            canPremountActiveEmpty: false,
        })).toBe(false);
        expect(shouldAutoRequestWorkspace({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
            canPremountActiveEmpty: true,
        })).toBe(true);
    });

    it('keeps request latched after signals clear', () => {
        const requested = resolveWorkspaceRequestedState(true, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
            canPremountActiveEmpty: false,
        });
        expect(requested).toBe(true);
    });

    it('stays false when not requested and no signals are present', () => {
        const requested = resolveWorkspaceRequestedState(false, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
            canPremountActiveEmpty: true,
        });
        expect(requested).toBe(false);
    });

    it('requests a hinted workspace when its tab becomes active', () => {
        const requested = resolveWorkspaceRequestedState(false, {
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
            canPremountActiveEmpty: false,
        });
        expect(requested).toBe(true);
    });
});

describe('workspace preload policy', () => {
    it('skips viewer chunk warmup on the web so visitors never prefetch both engines', () => {
        const loadedChunks: string[] = [];
        const result = warmupDesktopViewerChunks({
            isDesktopRuntime: false,
            loaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        });
        expect(result).toBeNull();
        expect(loadedChunks).toEqual([]);
    });

    it('warms every viewer chunk loader on desktop', async () => {
        const loadedChunks: string[] = [];
        const result = warmupDesktopViewerChunks({
            isDesktopRuntime: true,
            loaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        });
        expect(result).not.toBeNull();
        await result;
        expect(loadedChunks).toEqual([
            'chassis',
            'pdfjs',
            'native-pdf',
            'page-source',
        ]);
    });

    it('keeps prioritized default targets aligned with every async boundary a PDF may mount', async () => {
        const loadedChunks: string[] = [];
        const result = warmupDesktopViewerChunkForPaths({
            isDesktopRuntime: true,
            paths: [
                '/docs/book.pdf?from=recent',
                '/docs/notes.PDF',
            ],
            loaderOverrides: createRecordingViewerChunkLoaders(loadedChunks),
        });
        await result;
        expect(loadedChunks).toEqual([
            'chassis',
            'pdfjs',
            'native-pdf',
        ]);
        expect(getWorkspaceViewerChunkTargetsForPaths(['/docs/book.pdf'])).toEqual(loadedChunks);
    });

    it('keeps prioritized default targets aligned with every async boundary DjVu mounts', async () => {
        expect(getWorkspaceViewerChunkTargetsForPaths([
            '/docs/book.djvu',
            '/docs/notes.DJV',
        ])).toEqual([
            'chassis',
            'page-source',
        ]);
    });

    it('deduplicates the shared chassis while warming mixed pending paths', () => {
        expect(getWorkspaceViewerChunkTargetsForPaths([
            '/docs/book.djvu',
            '/docs/notes.pdf',
        ])).toEqual([
            'chassis',
            'pdfjs',
            'native-pdf',
            'page-source',
        ]);
    });

    it('leaves active empty host mounting to the post-paint premount in every build', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
        })).toBe(false);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: true,
        })).toBe(false);
    });

    it('keeps immediate host preload for queued restores and active document work', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: true,
            hasDocumentHint: false,
            isActive: false,
        })).toBe(true);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: true,
        })).toBe(true);
    });

    it('skips host mount preload for inactive document and production placeholder tabs', () => {
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: true,
            isActive: false,
        })).toBe(false);
        expect(shouldPreloadWorkspaceOnHostMount({
            hasQueuedSplitRestore: false,
            hasDocumentHint: false,
            isActive: false,
        })).toBe(false);
    });
});

describe('workspace host startup visibility', () => {
    const emptyPlaceholderSignals = {
        hasAcceptedDocument: false,
        hasQueuedSplitRestore: false,
        hasPendingDocumentHint: false,
        hasVisibleDocument: false,
        isDocumentOpenInFlight: false,
    };

    it('shows the lightweight empty placeholder without a document or open', () => {
        expect(shouldShowWorkspacePlaceholder(emptyPlaceholderSignals)).toBe(true);
    });

    it('hands the empty surface to an active opening transaction before page geometry is ready', () => {
        expect(shouldShowWorkspacePlaceholder({
            ...emptyPlaceholderSignals,
            hasPendingDocumentHint: true,
            isDocumentOpenInFlight: true,
        })).toBe(false);
        expect(shouldShowWorkspacePlaceholder({
            ...emptyPlaceholderSignals,
            hasPendingDocumentHint: true,
            hasVisibleDocument: true,
            isDocumentOpenInFlight: true,
        })).toBe(false);
    });

    it('keeps Start hidden after a generated combine settles before its first page is presented', () => {
        expect(shouldShowWorkspacePlaceholder({
            ...emptyPlaceholderSignals,
            hasAcceptedDocument: true,
        })).toBe(false);
    });

    it('retains the Recent placeholder for a title-only pending record before open ownership', () => {
        expect(shouldShowWorkspacePlaceholder({
            ...emptyPlaceholderSignals,
            hasPendingDocumentHint: true,
        })).toBe(true);
    });

    it('releases a title-only pending hint from live committed workspace evidence', () => {
        expect(shouldKeepWorkspacePendingDocumentHint({
            hasDocumentHint: true,
            isClosingDocument: false,
            mountedSnapshot: null,
        })).toBe(true);
        expect(shouldKeepWorkspacePendingDocumentHint({
            hasDocumentHint: true,
            isClosingDocument: false,
            mountedSnapshot: {
                ...createDefaultWorkspaceToolbarSnapshot(),
                hasPdf: true,
                initialVisualReady: true,
                viewerCapabilities: {
                    ...createDefaultWorkspaceViewerCapabilities(),
                    closeableDocument: true,
                },
            },
        })).toBe(false);
    });

    it('releases a pending hint and toolbar opening state for a committed DjVu visual', () => {
        const mountedSnapshot = {
            ...createDefaultWorkspaceToolbarSnapshot(),
            hasPdf: false,
            initialVisualReady: true,
            isDjvuMode: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
            },
        };
        const hasPendingDocumentHint = shouldKeepWorkspacePendingDocumentHint({
            hasDocumentHint: true,
            isClosingDocument: false,
            mountedSnapshot,
        });

        expect(hasPendingDocumentHint).toBe(false);
        expect(mountedSnapshot.isOpeningDocument || hasPendingDocumentHint).toBe(false);
    });

    it('does not republish a stale title-only document hint while closing', () => {
        expect(shouldKeepWorkspacePendingDocumentHint({
            hasDocumentHint: true,
            isClosingDocument: true,
            mountedSnapshot: null,
        })).toBe(false);
        expect(shouldKeepWorkspacePendingDocumentHint({
            hasDocumentHint: true,
            isClosingDocument: false,
            mountedSnapshot: null,
        })).toBe(true);
    });
});
