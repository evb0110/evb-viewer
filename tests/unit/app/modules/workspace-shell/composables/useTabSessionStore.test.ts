import {
    describe,
    expect,
    it,
} from 'vitest';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/tabs/resolveTabLifecycleStates';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import { requireDocumentRef } from '@contracts/documentRef';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';

function tab(id: string): ITab {
    return {
        id,
        fileName: `${id}.pdf`,
        originalPath: requireDocumentRef(`/docs/${id}.pdf`),
        isDirty: false,
        isDjvu: false,
    };
}

function pane(id: string, activeTabId: string, tabIds: string[]): IEditorPaneState {
    return {
        paneId: requirePaneId(id),
        activeTabId: requireTabId(activeTabId),
        tabIds: tabIds.map(tabId => requireTabId(tabId)),
    };
}

describe('tab session memory policy', () => {
    it('persists document page position in tab view state', () => {
        const state = createTabViewSessionState({
            hasPdf: true,
            initialVisualReady: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
                sidebar: true,
            },
            isOpeningDocument: false,
            hasOpenError: false,
            isPreparingPrint: false,
            isPreparingCurrentPagePrint: false,
            canSave: true,
            canRepairSave: true,
            canOptimizePdf: true,
            canUndo: false,
            canRedo: false,
            canExportDocx: false,
            isSaving: false,
            isSavingAs: false,
            isAnySaving: false,
            isHistoryBusy: false,
            isExportingDocx: false,
            isFitWidthActive: true,
            isFitHeightActive: false,
            showSidebar: false,
            sidebarTab: 'search',
            sidebarWidth: 384,
            dragMode: false,
            continuousScroll: true,
            isDjvuMode: false,
            isCapturingRegion: false,
            isCropSelecting: false,
            isPlacingPageNote: false,
            zoom: 1,
            effectiveZoom: 1,
            zoomMode: 'fit-width',
            fitMode: 'width',
            viewMode: 'single',
            viewRotation: 0,
            currentPage: 42,
            totalPages: 100,
        });

        expect(state.currentPage).toBe(42);
        expect(state.sidebarTab).toBe('search');
        expect(state.sidebarWidth).toBe(384);
    });

    it('merges surface mode without changing toolbar-derived reader state', () => {
        const readerState = createTabViewSessionState({
            ...createDefaultWorkspaceToolbarSnapshot(),
            currentPage: 23,
            zoom: 1.8,
            effectiveZoom: 1.8,
            zoomMode: 'custom',
        });
        const cleanupState = createTabViewSessionState({
            ...createDefaultWorkspaceToolbarSnapshot(),
            currentPage: 23,
            zoom: 1.8,
            effectiveZoom: 1.8,
            zoomMode: 'custom',
        }, {
            ...readerState,
            surfaceMode: 'scan-cleanup',
            scanCleanup: {
                ownerId: 'cleanup-owner',
                previewPage: 17,
                previewViewMode: 'original',
            },
        });

        expect(cleanupState).toMatchObject({
            surfaceMode: 'scan-cleanup',
            currentPage: 23,
            zoom: 1.8,
            effectiveZoom: 1.8,
            zoomMode: 'custom',
            scanCleanup: {
                ownerId: 'cleanup-owner',
                previewPage: 17,
                previewViewMode: 'original',
            },
        });
        expect(readerState.surfaceMode).toBe('reader');
    });

    it.each([
        {
            targetWarmViewers: 0,
            expectedWarmTabIds: [],
        },
        {
            targetWarmViewers: 1,
            expectedWarmTabIds: ['d'],
        },
        {
            targetWarmViewers: 2,
            expectedWarmTabIds: [
                'b',
                'd',
            ],
        },
        {
            targetWarmViewers: 5,
            expectedWarmTabIds: [
                'b',
                'c',
                'd',
            ],
        },
    ])('keeps $targetWarmViewers recent inactive tabs warm in conservative mode', ({
        targetWarmViewers,
        expectedWarmTabIds,
    }) => {
        const states = resolveTabLifecycleStates({
            tabs: [
                tab('a'),
                tab('b'),
                tab('c'),
                tab('d'),
            ],
            panes: [pane('pane-1', 'a', [
                'a',
                'b',
                'c',
                'd',
            ])],
            activationOrder: [
                'a',
                'd',
                'b',
                'c',
            ],
            policy: 'conservative',
            tier: 'high',
            targetWarmViewers,
        });

        expect(states.filter(state => state.temperature === 'hot').map(state => state.tabId)).toEqual(['a']);
        expect(states.filter(state => state.temperature === 'warm').map(state => state.tabId)).toEqual(expectedWarmTabIds);
    });

    it.each([
        0,
        1,
        2,
        5,
    ])('cools non-active tabs aggressively at a target of %i except visible split panes', (targetWarmViewers) => {
        const states = resolveTabLifecycleStates({
            tabs: [
                tab('a'),
                tab('b'),
                tab('c'),
            ],
            panes: [
                pane('pane-1', 'a', [
                    'a',
                    'b',
                ]),
                pane('pane-2', 'c', ['c']),
            ],
            activationOrder: [
                'a',
                'b',
                'c',
            ],
            policy: 'aggressive',
            tier: 'high',
            targetWarmViewers,
        });

        expect(Object.fromEntries(states.map(state => [
            state.tabId,
            state.temperature,
        ]))).toEqual({
            a: 'hot',
            b: 'cold',
            c: 'hot',
        });
    });

    it('keeps dirty inactive tabs warm but not reclaimable', () => {
        const dirtyTab = {
            ...tab('b'),
            isDirty: true,
        };
        const states = resolveTabLifecycleStates({
            tabs: [
                tab('a'),
                dirtyTab,
                tab('c'),
            ],
            panes: [pane('pane-1', 'a', [
                'a',
                'b',
                'c',
            ])],
            activationOrder: [
                'a',
                'c',
                'b',
            ],
            policy: 'aggressive',
            tier: 'low',
            targetWarmViewers: 0,
        });

        expect(Object.fromEntries(states.map(state => [
            state.tabId,
            {
                isReclaimCandidate: state.isReclaimCandidate,
                shouldMountHost: state.shouldMountHost,
                temperature: state.temperature,
                viewerResidency: state.viewerResidency,
            },
        ]))).toEqual({
            a: {
                isReclaimCandidate: false,
                shouldMountHost: true,
                temperature: 'hot',
                viewerResidency: 'active',
            },
            b: {
                isReclaimCandidate: false,
                shouldMountHost: true,
                temperature: 'warm',
                viewerResidency: 'warm',
            },
            c: {
                isReclaimCandidate: false,
                shouldMountHost: false,
                temperature: 'cold',
                viewerResidency: 'hibernated',
            },
        });
    });

    it.each([
        {
            policy: 'conservative' as const,
            expectedWarmTabIds: ['d'],
        },
        {
            policy: 'aggressive' as const,
            expectedWarmTabIds: [],
        },
    ])('caps low-tier inactive warm tabs in $policy mode', ({
        policy,
        expectedWarmTabIds,
    }) => {
        const states = resolveTabLifecycleStates({
            tabs: [
                tab('a'),
                tab('b'),
                tab('c'),
                tab('d'),
            ],
            panes: [pane('pane-1', 'a', [
                'a',
                'b',
                'c',
                'd',
            ])],
            activationOrder: [
                'a',
                'd',
                'b',
                'c',
            ],
            policy,
            tier: 'low',
            targetWarmViewers: 5,
        });

        expect(states.filter(state => state.temperature === 'warm').map(state => state.tabId))
            .toEqual(expectedWarmTabIds);
    });
});
