import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';

function createAssignedSession() {
    return createWorkspaceDocumentController({
        tabId: 'tab-1',
        assignment: {
            fileName: 'example.pdf',
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        },
    });
}

function activeDocumentOf(session: ReturnType<typeof createAssignedSession>) {
    return {
        activeDocumentSession: shallowRef(session),
        activeDocumentView: shallowRef(session.getView('tab-1')),
    };
}

describe('useWorkspaceShellState', () => {
    it('treats an assigned document as the active document before the workspace loads it', () => {
        const shellState = useWorkspaceShellState({
            ...activeDocumentOf(createAssignedSession()),
            tabs: ref([{id: 'tab-1'}]),
        });

        expect(shellState.activeWorkspaceHasDocument.value).toBe(false);
        expect(shellState.activeWorkspaceCanSave.value).toBe(false);
        expect(shellState.hasDocument.value).toBe(true);
        expect(shellState.tabCount.value).toBe(1);
    });

    it('has no document without an active tab', () => {
        const shellState = useWorkspaceShellState({
            activeDocumentSession: shallowRef(null),
            activeDocumentView: shallowRef(null),
            tabs: ref([]),
        });

        expect(shellState.activeWorkspaceCanSave.value).toBe(false);
        expect(shellState.hasDocument.value).toBe(false);
        expect(shellState.tabCount.value).toBe(0);
    });

    it('reads save availability from the active workspace toolbar', () => {
        const session = createAssignedSession();
        const shellState = useWorkspaceShellState({
            ...activeDocumentOf(session),
            tabs: ref([{id: 'tab-1'}]),
        });
        const view = session.getView('tab-1')!;
        view.publishToolbarSnapshot({
            ...createDefaultWorkspaceToolbarSnapshot(),
            hasPdf: true,
            canSave: false,
            canRepairSave: true,
        });

        expect(shellState.activeWorkspaceCanSave.value).toBe(false);
        expect(shellState.activeWorkspaceCanRepairSave.value).toBe(true);

        view.publishToolbarSnapshot({
            ...view.toolbarSnapshot.value,
            canSave: true,
        });

        expect(shellState.activeWorkspaceCanSave.value).toBe(true);
    });
});
