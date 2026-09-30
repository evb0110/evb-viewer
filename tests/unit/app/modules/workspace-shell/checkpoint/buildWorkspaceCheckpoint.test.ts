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
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { requireEpochMs } from '@contracts/timestamps';
import type { TTabId } from '@contracts/windowTabs';
import { requireTabId } from '@contracts/windowTabs';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import type { ICanonicalAnnotationRecovery } from '@app/modules/pdf-viewer/annotations/domain/annotationRecovery';
import { cast } from '@tests/helpers/cast';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

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
        const view = session.getView('tab-1');
        if (!view) {
            throw new Error('The controller must create the tab view it was created for');
        }
        view.publishToolbarSnapshot(toolbar);
        view.applyViewState(viewState);
        // The capture below must have the cleanup state to leave out.
        expect(view.viewState.value.scanCleanup).toBeDefined();
        expect(view.viewState.value.surfaceMode).toBe(viewState.surfaceMode);
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

    // Two tabs viewing one PDF, side by side; only `mountedTabIds` have a workspace.
    function checkpointSharedDocument(options: {
        dirty: boolean;
        mountedTabIds: string[];
        /** Mounted tabs whose viewer can capture annotations yet; all of them by default. */
        capturingTabIds?: string[];
    }) {
        const workingCopyRef = requireDocumentRef('/managed/working.pdf');
        const originalPath = requireDocumentRef('/documents/shared.pdf');
        const session = createWorkspaceDocumentController({tabId: 'tab-1'});
        session.commitDocument({
            fileName: 'shared.pdf',
            originalPath,
            isDjvu: false,
            revisionInfo: {
                version: 1,
                token: requireDocumentRevisionToken('revision-1'),
                documentRef: workingCopyRef,
                authority: 'browser-document-store',
                contentRevision: 1,
                mintedAt: requireEpochMs(1),
            },
        });
        session.setDirty(options.dirty);
        session.addView('tab-2');
        const recovery = cast<ICanonicalAnnotationRecovery>({annotationMutationGeneration: 3});
        [
            'tab-1',
            'tab-2',
        ].forEach((tabId, index) => {
            if (options.mountedTabIds.includes(tabId)) {
                session.attachWorkspace(tabId, createWorkspaceExposeFixture({
                    captureCanonicalAnnotationRecovery: () => (
                        (options.capturingTabIds ?? options.mountedTabIds).includes(tabId) ? recovery : null
                    ),
                    getAutomationStateSnapshot: () => cast({
                        originalPath,
                        workingCopyPath: workingCopyRef,
                    }),
                }));
            }
            session.getView(tabId)!.publishToolbarSnapshot({
                ...createDefaultWorkspaceToolbarSnapshot(),
                hasPdf: true,
                totalPages: 6,
                currentPage: index === 0 ? 2 : 5,
            });
        });
        const left = requirePaneId('pane-1');
        const right = requirePaneId('pane-2');
        const panes: IEditorPaneState[] = [
            {
                paneId: left,
                tabIds: [requireTabId('tab-1')],
                activeTabId: requireTabId('tab-1'),
            },
            {
                paneId: right,
                tabIds: [requireTabId('tab-2')],
                activeTabId: requireTabId('tab-2'),
            },
        ];
        const checkpoint = buildWorkspaceCheckpoint({
            panes: ref(panes),
            tabs: ref([
                {id: 'tab-1'},
                {id: 'tab-2'},
            ]),
            layout: ref<TEditorLayoutNode | null>({
                type: 'split',
                id: 'split-1',
                orientation: 'horizontal',
                ratio: 0.5,
                first: {
                    type: 'leaf',
                    paneId: left,
                },
                second: {
                    type: 'leaf',
                    paneId: right,
                },
            }),
            activePaneId: ref<TPaneId | null>(right),
            activeTabId: ref<TTabId | null>(requireTabId('tab-2')),
            documentSessionsByTabId: shallowRef({
                'tab-1': session,
                'tab-2': session,
            }),
            getPaneByTabId: tabId => panes.find(pane => pane.tabIds.includes(requireTabId(tabId))) ?? null,
        });
        return {
            checkpoint,
            workingCopyRef,
        };
    }

    it('captures a dirty document shown in two views once, with a view record for each tab', () => {
        const {checkpoint} = checkpointSharedDocument({
            dirty: true,
            mountedTabIds: [
                'tab-1',
                'tab-2',
            ],
        });

        expect(checkpoint.tabs.map(tab => [
            tab.tabId,
            tab.isDirty,
            tab.currentPage,
        ])).toEqual([
            [
                'tab-1',
                true,
                2,
            ],
            [
                'tab-2',
                true,
                5,
            ],
        ]);
        // The document's unsaved annotations are recovered once, not once per view.
        expect(checkpoint.tabs.filter(tab => tab.annotationRecovery)).toHaveLength(1);
    });

    it('captures a dirty document\'s annotations through its surviving view when the first view lost its workspace', () => {
        const {
            checkpoint,
            workingCopyRef,
        } = checkpointSharedDocument({
            dirty: true,
            mountedTabIds: ['tab-2'],
        });

        // The first tab restores the document, so it carries the recovery.
        expect(checkpoint.tabs.map(tab => [
            tab.tabId,
            tab.workingCopyRef,
            tab.annotationRecovery?.payload ?? null,
        ])).toEqual([
            [
                'tab-1',
                workingCopyRef,
                {annotationMutationGeneration: 3},
            ],
            [
                'tab-2',
                workingCopyRef,
                null,
            ],
        ]);
    });

    it('puts the document\'s annotations on its first tab when only the second view can capture them', () => {
        const {
            checkpoint,
            workingCopyRef,
        } = checkpointSharedDocument({
            dirty: true,
            mountedTabIds: [
                'tab-1',
                'tab-2',
            ],
            // The first view's viewer is still mounting.
            capturingTabIds: ['tab-2'],
        });

        expect(checkpoint.tabs.map(tab => [
            tab.tabId,
            tab.workingCopyRef,
            tab.annotationRecovery?.payload ?? null,
        ])).toEqual([
            [
                'tab-1',
                workingCopyRef,
                {annotationMutationGeneration: 3},
            ],
            [
                'tab-2',
                workingCopyRef,
                null,
            ],
        ]);
    });

    it('names the shared working copy for a linked tab whose view is not mounted', () => {
        const {
            checkpoint,
            workingCopyRef,
        } = checkpointSharedDocument({
            dirty: false,
            mountedTabIds: ['tab-1'],
        });

        expect(checkpoint.tabs.map(tab => tab.workingCopyRef)).toEqual([
            workingCopyRef,
            workingCopyRef,
        ]);
    });
});
