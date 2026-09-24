import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    effectScope,
    nextTick,
    shallowRef,
    triggerRef,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDirtyTabCloseDialog } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import {
    createWorkspaceDocumentController,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireDocumentInstanceId } from '@contracts/documentInstanceId';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const scopes: Array<ReturnType<typeof effectScope>> = [];

function createDirtyTab(id: string, fileName: string, documentInstanceId: string) {
    return createWorkspaceDocumentController({
        tabId: id,
        assignment: {
            fileName,
            originalPath: requireDocumentRef(`/documents/${fileName}`),
            documentInstanceId: requireDocumentInstanceId(documentInstanceId),
            isDirty: true,
            isDjvu: false,
        },
    });
}

function createHarness(initialTabs: IWorkspaceDocumentController[]) {
    const sessions = shallowRef(new Map(initialTabs.map(session => [
        session.tabId,
        session,
    ])));
    const scope = effectScope();
    scopes.push(scope);
    const dialog = scope.run(() => useDirtyTabCloseDialog({getSession: tabId => sessions.value.get(tabId) ?? null}))!;
    return {
        dialog,
        removeTab(tabId: string) {
            sessions.value.delete(tabId);
            triggerRef(sessions);
        },
    };
}

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

describe('useDirtyTabCloseDialog', () => {
    it('names the document and resolves with the chosen decision', async () => {
        const {dialog} = createHarness([createDirtyTab('tab-1', 'a.pdf', 'generation-1')]);

        const discard = dialog.requestDirtyTabCloseConfirmation('tab-1');
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(true);
        expect(dialog.dirtyTabCloseTargetName.value).toBe('a.pdf');
        dialog.resolveDirtyTabCloseDialog('discard');
        await expect(discard).resolves.toBe('discard');
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);

        const save = dialog.requestDirtyTabCloseConfirmation('tab-1');
        dialog.resolveDirtyTabCloseDialog('save');
        await expect(save).resolves.toBe('save');
    });

    it('keeps a native window close prompt open when tabs change underneath it', async () => {
        const {
            dialog,
            removeTab,
        } = createHarness([createDirtyTab('target', 'Zaliznyak.pdf', 'generation-1')]);

        const decision = dialog.requestDirtyWindowCloseConfirmation();
        expect(dialog.dirtyTabCloseDialogMode.value).toBe('window');
        removeTab('target');
        await nextTick();
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(true);

        dialog.resolveDirtyTabCloseDialog('save');
        await expect(decision).resolves.toBe('save');
    });

    it('cancels for a tab that does not exist', async () => {
        const {dialog} = createHarness([]);

        await expect(dialog.requestDirtyTabCloseConfirmation('missing-tab')).resolves.toBe('cancel');
        expect(dialog.dirtyTabCloseTargetName.value).toBe('tabs.newTab');
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
    });

    it('settles a pending confirmation when its scope is disposed', async () => {
        const target = createDirtyTab('tab-1', 'a.pdf', 'generation-1');
        const scope = effectScope();
        const dialog = scope.run(() => useDirtyTabCloseDialog({getSession: () => target}))!;

        const confirmation = dialog.requestDirtyTabCloseConfirmation('tab-1');
        scope.stop();

        await expect(confirmation).resolves.toBe('cancel');
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
    });

    it('dismisses when the tab now holds another document', async () => {
        const target = createDirtyTab('target', 'Zaliznyak.pdf', 'generation-1');
        const other = createDirtyTab('other', 'Other.pdf', 'generation-1');
        const {dialog} = createHarness([
            target,
            other,
        ]);

        const confirmation = dialog.requestDirtyTabCloseConfirmation(target.tabId);
        target.assign({
            fileName: 'Replacement.pdf',
            originalPath: requireDocumentRef('/documents/Replacement.pdf'),
            documentInstanceId: requireDocumentInstanceId('generation-2'),
            isDirty: true,
            isDjvu: false,
        });
        await nextTick();

        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
        await expect(confirmation).resolves.toBe('cancel');
        expect(other.snapshot.value.dirty).toBe(true);
    });

    it('dismisses when the tab closes without affecting another dirty tab', async () => {
        const other = createDirtyTab('other', 'Other.pdf', 'generation-1');
        const {
            dialog,
            removeTab,
        } = createHarness([
            createDirtyTab('target', 'Zaliznyak.pdf', 'generation-1'),
            other,
        ]);

        const confirmation = dialog.requestDirtyTabCloseConfirmation('target');
        removeTab('target');
        await nextTick();

        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
        await expect(confirmation).resolves.toBe('cancel');
        expect(other.snapshot.value.dirty).toBe(true);
    });
});
