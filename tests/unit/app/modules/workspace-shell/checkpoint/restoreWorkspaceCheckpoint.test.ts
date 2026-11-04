import {
    nextTick,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';
import { requireEpochMs } from '@contracts/timestamps';
import type { ITab } from '@app/types/tabs';
import { useWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { restoreWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint';
import { cast } from '@tests/helpers/cast';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

const originalPath = requireDocumentRef('/documents/shared.pdf');
const workingCopyRef = requireDocumentRef('/managed/working.pdf');

function checkpointTab(tabId: string, paneId: string, place: {
    currentPage: number;
    zoom: number;
    zoomMode: 'custom' | 'fit-width';
}) {
    return {
        tabId: requireTabId(tabId),
        paneId: requirePaneId(paneId),
        fileName: 'shared.pdf',
        sourceRef: originalPath,
        workingCopyRef,
        isDirty: false,
        isDjvu: false,
        continuousScroll: true,
        viewMode: 'single' as const,
        viewRotation: 0 as const,
        ...place,
    };
}

vi.stubGlobal('useToast', () => ({add: vi.fn()}));

describe('restoreWorkspaceCheckpoint', () => {
    it('restores hidden linked and clean tabs at their own page, zoom and layout before they mount', async () => {
        const tabs = ref<ITab[]>([]);
        const documentSessions = useWorkspaceDocumentSessions({
            activeTabId: ref(null),
            tabs,
        });
        // The right pane shows another tab, so the linked tab is hidden and mounts nothing.
        const checkpoint = cast<IWorkspaceCheckpoint>({
            version: 1,
            capturedAt: requireEpochMs(1),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('tab-1'),
            layout: null,
            panes: [
                {
                    paneId: requirePaneId('pane-1'),
                    tabIds: [
                        requireTabId('tab-1'),
                        requireTabId('tab-4'),
                    ],
                    activeTabId: requireTabId('tab-1'),
                },
                {
                    paneId: requirePaneId('pane-2'),
                    tabIds: [
                        requireTabId('tab-2'),
                        requireTabId('tab-3'),
                    ],
                    activeTabId: requireTabId('tab-3'),
                },
            ],
            tabs: [
                checkpointTab('tab-1', 'pane-1', {
                    currentPage: 2,
                    zoom: 1,
                    zoomMode: 'fit-width',
                }),
                checkpointTab('tab-2', 'pane-2', {
                    currentPage: 5,
                    zoom: 1.5,
                    zoomMode: 'custom',
                }),
                {
                    ...checkpointTab('tab-3', 'pane-2', {
                        currentPage: 1,
                        zoom: 1,
                        zoomMode: 'fit-width',
                    }),
                    sourceRef: requireDocumentRef('/documents/other.pdf'),
                    workingCopyRef: requireDocumentRef('/managed/other.pdf'),
                },
                // An ordinary clean tab behind tab-1: it opens only when shown.
                {
                    ...checkpointTab('tab-4', 'pane-1', {
                        currentPage: 7,
                        zoom: 2,
                        zoomMode: 'custom',
                    }),
                    viewMode: 'facing' as const,
                    continuousScroll: false,
                    sourceRef: requireDocumentRef('/documents/hidden.pdf'),
                    workingCopyRef: requireDocumentRef('/managed/hidden.pdf'),
                },
            ],
        });

        const restoring = restoreWorkspaceCheckpoint(checkpoint, {
            activeTabId: ref(null),
            documentSessions,
            restoreGraph: () => {
                tabs.value = [
                    {id: 'tab-1'},
                    {id: 'tab-2'},
                    {id: 'tab-3'},
                    {id: 'tab-4'},
                ];
            },
            activateTab: () => {},
        });
        await nextTick();
        const document = documentSessions.getSession('tab-1')!;
        document.attachWorkspace('tab-1', createWorkspaceExposeFixture({waitForDocumentOpenSettled: async () => {
            await document.runOpen({
                kind: 'open',
                target: {
                    fileName: 'shared.pdf',
                    originalPath,
                },
            }, async () => {
                document.commitDocument({
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
                document.markPresented();
                return true;
            });
        }}));
        documentSessions.getSession('tab-3')!.attachWorkspace('tab-3', createWorkspaceExposeFixture());
        await restoring;

        expect(documentSessions.getSession('tab-2')).toBe(document);
        const hiddenView = documentSessions.getView('tab-2')!;
        expect(hiddenView.mountedWorkspace.value).toBeNull();
        expect(hiddenView.viewState.value).toMatchObject({
            currentPage: 5,
            zoom: 1.5,
            zoomMode: 'custom',
        });

        // The hidden clean tab mounts nothing yet, but keeps its own place, so
        // its first open starts there rather than at the defaults.
        const hiddenPrimary = documentSessions.getView('tab-4')!;
        expect(hiddenPrimary.mountedWorkspace.value).toBeNull();
        expect(hiddenPrimary.restored).toBe(true);
        expect(hiddenPrimary.viewState.value).toMatchObject({
            currentPage: 7,
            zoom: 2,
            zoomMode: 'custom',
            viewMode: 'facing',
            continuousScroll: false,
        });
    });

    it('relinks clean views that kept no working copy, and leaves a separate open of the file alone', async () => {
        const tabs = ref<ITab[]>([]);
        const documentSessions = useWorkspaceDocumentSessions({
            activeTabId: ref(null),
            tabs,
        });
        const place = {
            currentPage: 1,
            zoom: 1,
            zoomMode: 'fit-width' as const,
        };
        const checkpoint = cast<IWorkspaceCheckpoint>({
            version: 1,
            capturedAt: requireEpochMs(1),
            activePaneId: requirePaneId('pane-1'),
            activeTabId: requireTabId('tab-1'),
            layout: null,
            panes: [{
                paneId: requirePaneId('pane-1'),
                tabIds: [
                    requireTabId('tab-1'),
                    requireTabId('tab-2'),
                    requireTabId('tab-3'),
                ],
                activeTabId: requireTabId('tab-1'),
            }],
            tabs: [
                {
                    ...checkpointTab('tab-1', 'pane-1', place),
                    workingCopyRef: null,
                },
                {
                    ...checkpointTab('tab-2', 'pane-1', {
                        currentPage: 4,
                        zoom: 1.75,
                        zoomMode: 'custom',
                    }),
                    workingCopyRef: null,
                    linkedToTabId: requireTabId('tab-1'),
                },
                {
                    ...checkpointTab('tab-3', 'pane-1', place),
                    workingCopyRef: null,
                },
            ],
        });

        const restoring = restoreWorkspaceCheckpoint(checkpoint, {
            activeTabId: ref(null),
            documentSessions,
            restoreGraph: () => {
                tabs.value = [
                    {id: 'tab-1'},
                    {id: 'tab-2'},
                    {id: 'tab-3'},
                ];
            },
            activateTab: () => {},
        });
        await nextTick();
        const document = documentSessions.getSession('tab-1')!;
        document.attachWorkspace('tab-1', createWorkspaceExposeFixture({waitForDocumentOpenSettled: async () => {
            await document.runOpen({
                kind: 'open',
                target: {
                    fileName: 'shared.pdf',
                    originalPath,
                },
            }, async () => {
                document.commitDocument({
                    fileName: 'shared.pdf',
                    originalPath,
                    isDjvu: false,
                    revisionInfo: null,
                });
                document.markPresented();
                return true;
            });
        }}));
        await restoring;

        expect(documentSessions.getSession('tab-2')).toBe(document);
        expect(documentSessions.getSession('tab-3')).not.toBe(document);
        // The hidden linked view first opens at its own checkpointed place.
        const linked = documentSessions.getView('tab-2')!;
        expect(linked.restored).toBe(true);
        expect(linked.viewState.value).toMatchObject({
            currentPage: 4,
            zoom: 1.75,
            zoomMode: 'custom',
        });
    });
});
