import {
    ref,
    shallowRef,
} from 'vue';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
    TPaneId,
} from '@contracts/editorPanes';
import { requirePaneId } from '@contracts/editorPanes';
import { requireDocumentRef } from '@contracts/documentRef';
import type { TTabId } from '@contracts/windowTabs';
import { requireTabId } from '@contracts/windowTabs';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';

describe('buildWorkspaceCheckpoint', () => {
    it('persists the cleanup surface without copying a document-sized page mapping', () => {
        const toolbar = {
            ...createDefaultWorkspaceToolbarSnapshot(),
            hasPdf: true,
            totalPages: 138_000,
        };
        const viewState = {
            ...createTabViewSessionState(toolbar),
            surfaceMode: 'scan-cleanup' as const,
            scanCleanup: {
                ownerId: 'cleanup-owner',
                previewPage: 138_000,
                previewViewMode: 'original' as const,
                pageMapping: Object.fromEntries(
                    Array.from(
                        {length: 138_000},
                        (_value, index) => [
                            String(index + 1),
                            [index + 1],
                        ],
                    ),
                ),
            },
        };
        const paneId = requirePaneId('pane-1');
        const tabId = requireTabId('tab-1');
        const originalPath = requireDocumentRef('/documents/large.pdf');
        const pane: IEditorPaneState = {
            paneId,
            tabIds: [tabId],
            activeTabId: tabId,
        };
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            assignment: {
                fileName: 'large.pdf',
                originalPath,
                isDirty: false,
                isDjvu: false,
            },
        });
        session.publishToolbarSnapshot(toolbar);
        session.applyViewState(viewState);
        const checkpoint = buildWorkspaceCheckpoint({
            panes: ref<IEditorPaneState[]>([pane]),
            tabs: ref([{id: 'tab-1'}]),
            layout: ref<TEditorLayoutNode | null>({
                type: 'leaf',
                paneId,
            }),
            activePaneId: ref<TPaneId | null>(paneId),
            activeTabId: ref<TTabId | null>(tabId),
            documentSessionsByTabId: shallowRef({'tab-1': session}),
            getPaneByTabId: () => pane,
        });

        expect(checkpoint.tabs[0]).not.toHaveProperty('surfaceMode');
        expect(checkpoint.tabs[0]).not.toHaveProperty('scanCleanup');
        expect(JSON.stringify(checkpoint)).not.toContain('pageMapping');
        expect(JSON.stringify(checkpoint)).not.toContain('138000');
    });
});
