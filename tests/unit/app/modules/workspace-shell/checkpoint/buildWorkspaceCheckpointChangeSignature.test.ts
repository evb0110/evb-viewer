// @vitest-environment happy-dom
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    ref,
    shallowRef,
} from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
    TPaneId,
} from '@contracts/editorPanes';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requireDocumentInstanceId } from '@contracts/documentInstanceId';
import { requirePaneId } from '@contracts/editorPanes';
import type { TTabId } from '@contracts/windowTabs';
import { requireTabId } from '@contracts/windowTabs';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {
    createWorkspaceExposeFixture,
    setTestDocumentDirty,
} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import { buildWorkspaceCheckpointChangeSignature } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import {
    buildWorkspaceCheckpoint,
    WorkspaceCheckpointCaptureError,
} from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import { useWorkspaceCrashCheckpoint } from '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

function createSession(tabId: string) {
    return createWorkspaceDocumentController({
        tabId,
        assignment: {
            fileName: `${tabId}.pdf`,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        },
    });
}

function toolbar(overrides: Partial<ReturnType<typeof createDefaultWorkspaceToolbarSnapshot>>) {
    return {
        ...createDefaultWorkspaceToolbarSnapshot(),
        ...overrides,
    };
}

function createSignatureOptions() {
    const pane: IEditorPaneState = {
        paneId: requirePaneId('pane-1'),
        tabIds: [
            requireTabId('tab-a'),
            requireTabId('tab-b'),
        ],
        activeTabId: requireTabId('tab-a'),
    };
    return {
        panes: ref([pane]),
        tabs: ref([
            {id: 'tab-a'},
            {id: 'tab-b'},
        ]),
        layout: ref<TEditorLayoutNode | null>(null),
        activePaneId: ref<TPaneId | null>(requirePaneId('pane-1')),
        activeTabId: ref<TTabId | null>(requireTabId('tab-a')),
        documentSessionsByTabId: shallowRef({
            'tab-a': createSession('tab-a'),
            'tab-b': createSession('tab-b'),
        }),
        getPaneByTabId: (): IEditorPaneState | null => pane,
    };
}

describe('buildWorkspaceCheckpointChangeSignature', () => {
    it('is stable across rebuilds of identical state', () => {
        const options = createSignatureOptions();
        const first = buildWorkspaceCheckpointChangeSignature(options);
        const second = buildWorkspaceCheckpointChangeSignature(options);
        expect(second.workspace).toBe(first.workspace);
        expect([...second.tabSignatures.entries()]).toEqual([...first.tabSignatures.entries()]);
    });

    it('changes only the affected tab signature when a document record changes', () => {
        const options = createSignatureOptions();
        const before = buildWorkspaceCheckpointChangeSignature(options);
        options.documentSessionsByTabId.value['tab-b'].getView('tab-b')?.publishToolbarSnapshot(toolbar({
            hasPdf: true,
            currentPage: 7,
            totalPages: 30,
        }));
        const after = buildWorkspaceCheckpointChangeSignature(options);
        expect(after.tabSignatures.get('tab-a')).toBe(before.tabSignatures.get('tab-a'));
        expect(after.tabSignatures.get('tab-b')).not.toBe(before.tabSignatures.get('tab-b'));
        expect(after.workspace).not.toBe(before.workspace);
    });

    it('tracks toolbar view state the checkpoint persists', () => {
        const options = createSignatureOptions();
        const session = options.documentSessionsByTabId.value['tab-a'];
        session.getView('tab-a')?.publishToolbarSnapshot(toolbar({
            hasPdf: true,
            currentPage: 7,
            totalPages: 30,
        }));
        const before = buildWorkspaceCheckpointChangeSignature(options);
        session.getView('tab-a')?.publishToolbarSnapshot(toolbar({
            hasPdf: true,
            currentPage: 8,
            totalPages: 30,
        }));
        const after = buildWorkspaceCheckpointChangeSignature(options);
        expect(after.tabSignatures.get('tab-a')).not.toBe(before.tabSignatures.get('tab-a'));
    });

    it('tracks tab dirtiness, mount state, and pane membership', () => {
        const options = createSignatureOptions();
        const base = buildWorkspaceCheckpointChangeSignature(options);

        const session = options.documentSessionsByTabId.value['tab-a'];
        setTestDocumentDirty(session, true);
        const afterDirty = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterDirty.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));
        expect(afterDirty.tabSignatures.get('tab-b')).toBe(base.tabSignatures.get('tab-b'));

        setTestDocumentDirty(session, false);
        const workspace = {getToolbarSnapshot: createDefaultWorkspaceToolbarSnapshot} as IWorkspaceExpose;
        session.attachWorkspace('tab-a', workspace);
        const afterMount = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterMount.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));

        session.detachWorkspace('tab-a', workspace);
        const detachedOptions = {
            ...options,
            getPaneByTabId: (): IEditorPaneState | null => null,
        };
        const afterPaneChange = buildWorkspaceCheckpointChangeSignature(detachedOptions);
        expect(afterPaneChange.tabSignatures.get('tab-a')).not.toBe(base.tabSignatures.get('tab-a'));
    });

    it('tracks the document identity', () => {
        const options = createSignatureOptions();
        const session = options.documentSessionsByTabId.value['tab-a'];
        const before = buildWorkspaceCheckpointChangeSignature(options);
        session.assign({
            fileName: 'tab-a.pdf',
            originalPath: null,
            documentInstanceId: requireDocumentInstanceId('document-1'),
            isDirty: false,
            isDjvu: false,
        });
        expect(buildWorkspaceCheckpointChangeSignature(options).tabSignatures.get('tab-a')).not.toBe(before.tabSignatures.get('tab-a'));
    });

    it('tracks live document refs owned by a mounted workspace', () => {
        const options = createSignatureOptions();
        let originalPath: TDocumentRef | null = null;
        const workspace = {getToolbarSnapshot: createDefaultWorkspaceToolbarSnapshot} as IWorkspaceExpose;
        workspace.getWorkspaceDocumentRefsSignature = () => [
            originalPath,
            null,
            false,
        ];
        options.documentSessionsByTabId.value['tab-a'].attachWorkspace('tab-a', workspace);
        const before = buildWorkspaceCheckpointChangeSignature(options);

        originalPath = requireDocumentRef('/restored.pdf');
        const after = buildWorkspaceCheckpointChangeSignature(options);

        expect(after.tabSignatures.get('tab-a')).not.toBe(before.tabSignatures.get('tab-a'));
        expect(after.workspace).not.toBe(before.workspace);
    });

    it('changes the workspace signature for workspace-only state', () => {
        const options = createSignatureOptions();
        const before = buildWorkspaceCheckpointChangeSignature(options);

        options.activeTabId.value = requireTabId('tab-b');
        const afterActiveTab = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterActiveTab.workspace).not.toBe(before.workspace);
        expect([...afterActiveTab.tabSignatures.entries()]).toEqual([...before.tabSignatures.entries()]);

        options.activeTabId.value = requireTabId('tab-a');
        options.panes.value = [{
            paneId: requirePaneId('pane-1'),
            tabIds: [
                requireTabId('tab-b'),
                requireTabId('tab-a'),
            ],
            activeTabId: requireTabId('tab-a'),
        }];
        const afterTabOrder = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterTabOrder.workspace).not.toBe(before.workspace);
    });
});

describe('buildWorkspaceCheckpointChangeSignature structure', () => {
    it('ignores view state and tracks which documents the window presents', () => {
        const options = createSignatureOptions();
        const session = options.documentSessionsByTabId.value['tab-a'];
        const base = buildWorkspaceCheckpointChangeSignature(options);

        session.getView('tab-a')?.publishToolbarSnapshot(toolbar({
            hasPdf: true,
            currentPage: 4,
            totalPages: 30,
            zoom: 1.5,
        }));
        options.activeTabId.value = requireTabId('tab-b');
        const afterView = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterView.workspace).not.toBe(base.workspace);
        expect(afterView.structure).toBe(base.structure);

        session.assign({
            fileName: 'opened.pdf',
            originalPath: requireDocumentRef('/opened.pdf'),
            documentInstanceId: requireDocumentInstanceId('document-opened'),
            isDirty: false,
            isDjvu: false,
        });
        const afterOpen = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterOpen.structure).not.toBe(afterView.structure);

        setTestDocumentDirty(session, true);
        const afterEdit = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterEdit.structure).not.toBe(afterOpen.structure);
        setTestDocumentDirty(session, false);
        const afterSave = buildWorkspaceCheckpointChangeSignature(options);
        expect(afterSave.structure).not.toBe(afterEdit.structure);

        options.tabs.value = [...options.tabs.value, {id: 'tab-c'}];
        expect(buildWorkspaceCheckpointChangeSignature(options).structure).not.toBe(afterSave.structure);
    });
});

describe('buildWorkspaceCheckpointChangeSignature structure across views', () => {
    it('keeps the structure while a clean tab\'s view mounts, unmounts or reports refs, and changes it when a tab moves or closes', () => {
        const options = createSignatureOptions();
        const session = options.documentSessionsByTabId.value['tab-a'];
        const base = buildWorkspaceCheckpointChangeSignature(options);
        let workingCopy: TDocumentRef | null = null;
        const workspace = {getToolbarSnapshot: createDefaultWorkspaceToolbarSnapshot} as IWorkspaceExpose;
        workspace.getWorkspaceDocumentRefsSignature = () => [null, workingCopy, false];

        // A memory policy unmounts background views on every tab switch.
        session.attachWorkspace('tab-a', workspace);
        const mounted = buildWorkspaceCheckpointChangeSignature(options);
        expect(mounted.workspace).not.toBe(base.workspace);
        expect(mounted.structure).toBe(base.structure);
        workingCopy = requireDocumentRef('/working.pdf');
        expect(buildWorkspaceCheckpointChangeSignature(options).structure).toBe(base.structure);
        session.detachWorkspace('tab-a', workspace);
        expect(buildWorkspaceCheckpointChangeSignature(options).structure).toBe(base.structure);

        const otherPane: IEditorPaneState = {
            paneId: requirePaneId('pane-2'),
            tabIds: [requireTabId('tab-a')],
            activeTabId: requireTabId('tab-a'),
        };
        expect(buildWorkspaceCheckpointChangeSignature({
            ...options,
            getPaneByTabId: () => otherPane,
        }).structure).not.toBe(base.structure);

        options.tabs.value = [{id: 'tab-a'}];
        expect(buildWorkspaceCheckpointChangeSignature(options).structure).not.toBe(base.structure);
    });
});

describe('buildWorkspaceCheckpoint', () => {
    it('fails closed when a mounted workspace snapshot cannot be captured', () => {
        const options = createSignatureOptions();
        const workspace = {getToolbarSnapshot: createDefaultWorkspaceToolbarSnapshot} as IWorkspaceExpose;
        workspace.getAutomationStateSnapshot = () => {
            throw new Error('snapshot unavailable');
        };
        options.documentSessionsByTabId.value['tab-a'].attachWorkspace('tab-a', workspace);

        let error: unknown;
        try {
            buildWorkspaceCheckpoint(options);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(WorkspaceCheckpointCaptureError);
        expect(error).toHaveProperty('message', expect.stringContaining('tab tab-a'));
    });
});

describe('useWorkspaceCrashCheckpoint', () => {
    it('writes the next checkpoint when persistence was disabled during the first capture', async () => {
        const options = createSignatureOptions();
        const enabled = ref(true);
        const workspace = createWorkspaceExposeFixture();
        const capture = workspace.getAutomationStateSnapshot;
        vi.spyOn(workspace, 'getAutomationStateSnapshot').mockImplementationOnce(() => {
            enabled.value = false;
            return capture();
        });
        options.documentSessionsByTabId.value['tab-a'].attachWorkspace('tab-a', workspace);

        const saveWorkspaceCheckpoint = vi.fn(async () => true);
        const originalElectronApi = window.electronAPI;
        window.electronAPI = createElectronPlatformApiFixture({windowTabs: {saveWorkspaceCheckpoint}});
        let checkpoint!: ReturnType<typeof useWorkspaceCrashCheckpoint>;
        const app = createApp({
            setup() {
                checkpoint = useWorkspaceCrashCheckpoint({
                    ...options,
                    enabled,
                    isStartupOpenClaimPending: ref(false),
                });
                return () => null;
            },
        });
        app.mount(document.createElement('div'));
        const {persistCheckpointNow} = checkpoint;
        try {
            // The early guard passed. Only the writer sees the disabled state.
            await persistCheckpointNow();
            expect(enabled.value).toBe(false);
            expect(saveWorkspaceCheckpoint).not.toHaveBeenCalled();

            enabled.value = true;
            options.activeTabId.value = requireTabId('tab-b');
            await persistCheckpointNow();
            expect(saveWorkspaceCheckpoint).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({activeTabId: 'tab-b'}));
        } finally {
            app.unmount();
            if (originalElectronApi === undefined) {
                delete window.electronAPI;
            } else {
                window.electronAPI = originalElectronApi;
            }
        }
    });

    it('writes a checkpoint queued during the writer\'s entry yield before the second caller resolves', async () => {
        const options = createSignatureOptions();
        const secondPaneId = requirePaneId('pane-2');
        options.panes.value.push({
            paneId: secondPaneId,
            tabIds: [],
            activeTabId: null,
        });
        const firstLayout: TEditorLayoutNode = {
            type: 'split',
            id: 'split-1',
            orientation: 'horizontal',
            ratio: 0.5,
            first: {
                type: 'leaf',
                paneId: requirePaneId('pane-1'),
            },
            second: {
                type: 'leaf',
                paneId: secondPaneId,
            },
        };
        const secondLayout = {
            ...firstLayout,
            ratio: 0.7,
        };
        options.layout.value = firstLayout;

        const writeStarted = Promise.withResolvers<void>();
        const finishWrite = Promise.withResolvers<void>();
        const savedLayouts: IWorkspaceCheckpoint['layout'][] = [];
        const saveWorkspaceCheckpoint = vi.fn(async ({layout}: IWorkspaceCheckpoint) => {
            writeStarted.resolve();
            await finishWrite.promise;
            savedLayouts.push(layout);
            return true;
        });
        const originalElectronApi = window.electronAPI;
        window.electronAPI = createElectronPlatformApiFixture({windowTabs: {saveWorkspaceCheckpoint}});
        let checkpoint!: ReturnType<typeof useWorkspaceCrashCheckpoint>;
        const app = createApp({
            setup() {
                checkpoint = useWorkspaceCrashCheckpoint({
                    ...options,
                    enabled: ref(true),
                    isStartupOpenClaimPending: ref(false),
                });
                return () => null;
            },
        });
        app.mount(document.createElement('div'));
        const {persistCheckpointNow} = checkpoint;
        try {
            // Change the layout between the two nextTick captures, before the writer resumes.
            const first = persistCheckpointNow();
            queueMicrotask(() => {
                options.layout.value = secondLayout;
            });
            const savedWhenSecondCallerResolves = persistCheckpointNow().then(() => savedLayouts.at(-1));

            await writeStarted.promise;
            // Let any prematurely resolved caller finish while the save is still blocked.
            await nextEventLoopTurn();
            finishWrite.resolve();
            await first;
            const layoutAtResolution = await savedWhenSecondCallerResolves;
            expect(savedLayouts.at(-1)).toEqual(secondLayout);
            expect(layoutAtResolution).toEqual(secondLayout);
        } finally {
            finishWrite.resolve();
            app.unmount();
            if (originalElectronApi === undefined) {
                delete window.electronAPI;
            } else {
                window.electronAPI = originalElectronApi;
            }
        }
    });
});

describe('useWorkspaceCrashCheckpoint write timing', () => {
    function mountCheckpoint(saveWorkspaceCheckpoint: (checkpoint: IWorkspaceCheckpoint) => Promise<boolean>) {
        const options = createSignatureOptions();
        const originalElectronApi = window.electronAPI;
        window.electronAPI = createElectronPlatformApiFixture({windowTabs: {saveWorkspaceCheckpoint}});
        let checkpoint!: ReturnType<typeof useWorkspaceCrashCheckpoint>;
        const app = createApp({
            setup() {
                checkpoint = useWorkspaceCrashCheckpoint({
                    ...options,
                    enabled: ref(true),
                    isStartupOpenClaimPending: ref(false),
                });
                return () => null;
            },
        });
        app.mount(document.createElement('div'));
        return {
            options,
            checkpoint,
            dispose() {
                app.unmount();
                if (originalElectronApi === undefined) {
                    delete window.electronAPI;
                } else {
                    window.electronAPI = originalElectronApi;
                }
            },
        };
    }

    async function settle() {
        for (let turn = 0; turn < 5; turn += 1) await nextEventLoopTurn();
    }

    it('writes an opened document at once and waits for the debounce on page and zoom changes', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const saveWorkspaceCheckpoint = vi.fn(async (_checkpoint: IWorkspaceCheckpoint) => true);
        const {options, dispose} = mountCheckpoint(saveWorkspaceCheckpoint);
        try {
            await settle();
            saveWorkspaceCheckpoint.mockClear();
            const session = options.documentSessionsByTabId.value['tab-a'];

            session.getView('tab-a')?.publishToolbarSnapshot(toolbar({
                hasPdf: true,
                currentPage: 5,
                totalPages: 30,
                zoom: 2,
            }));
            await settle();
            expect(saveWorkspaceCheckpoint).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_000);
            await settle();
            expect(saveWorkspaceCheckpoint).toHaveBeenCalledOnce();
            saveWorkspaceCheckpoint.mockClear();

            // Mounting a view, as a tab switch does, waits for the debounce too.
            session.attachWorkspace('tab-a', createWorkspaceExposeFixture());
            await settle();
            expect(saveWorkspaceCheckpoint).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_000);
            await settle();
            expect(saveWorkspaceCheckpoint).toHaveBeenCalledOnce();
            saveWorkspaceCheckpoint.mockClear();

            session.assign({
                fileName: 'opened.pdf',
                originalPath: requireDocumentRef('/opened.pdf'),
                documentInstanceId: requireDocumentInstanceId('document-opened'),
                isDirty: false,
                isDjvu: false,
            });
            await settle();
            // No timer advanced: a crash now still finds the opened document.
            expect(saveWorkspaceCheckpoint).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                tabs: expect.arrayContaining([expect.objectContaining({
                    tabId: 'tab-a',
                    sourceRef: '/opened.pdf',
                })]),
            }));

            saveWorkspaceCheckpoint.mockClear();
            setTestDocumentDirty(session, true);
            await settle();
            setTestDocumentDirty(session, false);
            await settle();
            // Saving clears dirtiness, which is written at once too.
            expect(saveWorkspaceCheckpoint).toHaveBeenCalledTimes(2);
            expect(saveWorkspaceCheckpoint.mock.lastCall?.[0].tabs[0]).toEqual(expect.objectContaining({isDirty: false}));
        } finally {
            dispose();
            vi.useRealTimers();
        }
    });

    it('coalesces documents opened while a write is in flight into one follow-up write', async () => {
        const finishWrite = Promise.withResolvers<void>();
        const saved: IWorkspaceCheckpoint[] = [];
        const saveWorkspaceCheckpoint = vi.fn(async (checkpoint: IWorkspaceCheckpoint) => {
            saved.push(checkpoint);
            if (saved.length === 2) await finishWrite.promise;
            return true;
        });
        const {options, dispose} = mountCheckpoint(saveWorkspaceCheckpoint);
        try {
            await settle();
            options.documentSessionsByTabId.value['tab-a'].assign({
                fileName: 'first.pdf',
                originalPath: requireDocumentRef('/first.pdf'),
                documentInstanceId: requireDocumentInstanceId('document-first'),
                isDirty: false,
                isDjvu: false,
            });
            await settle();
            // The first opened document's write is blocked. Three more documents open meanwhile.
            for (const name of ['second', 'third', 'fourth']) {
                options.documentSessionsByTabId.value['tab-b'].assign({
                    fileName: `${name}.pdf`,
                    originalPath: requireDocumentRef(`/${name}.pdf`),
                    documentInstanceId: requireDocumentInstanceId(`document-${name}`),
                    isDirty: false,
                    isDjvu: false,
                });
                await settle();
            }
            expect(saveWorkspaceCheckpoint).toHaveBeenCalledTimes(2);
            finishWrite.resolve();
            await settle();
            expect(saveWorkspaceCheckpoint).toHaveBeenCalledTimes(3);
            expect(saved.at(-1)?.tabs.map(tab => tab.sourceRef)).toEqual(['/first.pdf', '/fourth.pdf']);
        } finally {
            finishWrite.resolve();
            dispose();
        }
    });

    it('resolves a write that replaced a failed one and rejects when the latest write fails', async () => {
        const firstStarted = Promise.withResolvers<void>();
        const failFirst = Promise.withResolvers<void>();
        let calls = 0;
        const saveWorkspaceCheckpoint = vi.fn(async (_checkpoint: IWorkspaceCheckpoint) => {
            calls += 1;
            if (calls === 1) {
                firstStarted.resolve();
                await failFirst.promise;
                throw new Error('disk full');
            }
            if (calls === 3) throw new Error('still full');
            return true;
        });
        const {options, checkpoint, dispose} = mountCheckpoint(saveWorkspaceCheckpoint);
        try {
            // The mount's write is in flight. A newer checkpoint queues behind it.
            await firstStarted.promise;
            options.activeTabId.value = requireTabId('tab-b');
            const replacing = checkpoint.persistCheckpointNow();
            await settle();
            failFirst.resolve();
            await expect(replacing).resolves.toBeUndefined();
            expect(saveWorkspaceCheckpoint).toHaveBeenCalledTimes(2);
            expect(saveWorkspaceCheckpoint.mock.lastCall?.[0]).toEqual(expect.objectContaining({activeTabId: 'tab-b'}));

            await expect(checkpoint.persistCheckpointNow()).rejects.toThrow('still full');
        } finally {
            failFirst.resolve();
            dispose();
        }
    });
});
