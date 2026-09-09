import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { ITab } from '@app/types/tabs';
import { useDirtyTabCloseDialog } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import { requireDocumentRef } from '@contracts/documentRef';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const scopes: Array<ReturnType<typeof effectScope>> = [];

function createTab(id: string, fileName: string, documentInstanceId: string): ITab {
    return {
        id,
        fileName,
        originalPath: requireDocumentRef(`/documents/${fileName}`),
        documentInstanceId: documentInstanceId as Exclude<ITab['documentInstanceId'], undefined>,
        isDirty: true,
        isDjvu: false,
    };
}

function createHarness(initialTabs: ITab[]) {
    const tabs = ref(initialTabs);
    const scope = effectScope();
    scopes.push(scope);
    const dialog = scope.run(() => useDirtyTabCloseDialog({tabs}))!;
    return {
        dialog,
        tabs,
    };
}

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

describe('useDirtyTabCloseDialog', () => {
    it('resolves confirmation with true when confirmed', async () => {
        const tabs = ref<ITab[]>([{
            id: 'tab-1',
            fileName: 'a.pdf',
            originalPath: requireDocumentRef('/docs/a.pdf'),
            isDirty: true,
            isDjvu: false,
        }]);
        const dialog = useDirtyTabCloseDialog({tabs});

        const confirmationPromise = dialog.requestDirtyTabCloseConfirmation('tab-1');
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(true);
        expect(dialog.dirtyTabCloseTargetName.value).toBe('a.pdf');

        dialog.confirmDirtyTabClose();
        await expect(confirmationPromise).resolves.toBe(true);
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
    });

    it('resolves a native window close with an explicit decision', async () => {
        const target = createTab('target', 'Zaliznyak.pdf', 'generation-1');
        const {
            dialog,
            tabs,
        } = createHarness([target]);

        const decision = dialog.requestDirtyWindowCloseConfirmation();
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(true);
        expect(dialog.dirtyTabCloseDialogMode.value).toBe('window');

        tabs.value = [];
        await nextTick();
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(true);

        dialog.resolveDirtyTabCloseDialog('save');
        await expect(decision).resolves.toBe('save');
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
    });

    it('falls back to new-tab label and resolves false on external close', async () => {
        const tabs = ref([]);
        const dialog = useDirtyTabCloseDialog({tabs});

        const confirmationPromise = dialog.requestDirtyTabCloseConfirmation('missing-tab');
        expect(dialog.dirtyTabCloseTargetName.value).toBe('tabs.newTab');
        await expect(confirmationPromise).resolves.toBe(false);
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
    });

    it('settles a pending confirmation when its scope is disposed', async () => {
        const tabs = ref([]);
        const scope = effectScope();
        const dialog = scope.run(() => useDirtyTabCloseDialog({tabs}));

        if (!dialog) {
            throw new Error('Expected dialog composable to initialize in scope');
        }

        const confirmationPromise = dialog.requestDirtyTabCloseConfirmation('tab-1');
        scope.stop();

        await expect(confirmationPromise).resolves.toBe(false);
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
    });

    it('keeps the requested name when the tab list is regenerated', async () => {
        const target = createTab('target', 'Zaliznyak.pdf', 'generation-1');
        const other = createTab('other', 'Other.pdf', 'generation-1');
        const {
            dialog,
            tabs,
        } = createHarness([
            target,
            other,
        ]);

        const confirmation = dialog.requestDirtyTabCloseConfirmation(target.id);
        expect(dialog.dirtyTabCloseTargetName.value).toBe('Zaliznyak.pdf');

        tabs.value = [
            createTab(target.id, 'Replacement.pdf', 'generation-2'),
            other,
        ];
        expect(dialog.dirtyTabCloseTargetName.value).toBe('Zaliznyak.pdf');
        await nextTick();

        expect(dialog.dirtyTabCloseTargetName.value).not.toBe('tabs.newTab');
        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
        await expect(confirmation).resolves.toBe(false);
        expect(tabs.value.find(tab => tab.id === other.id)?.isDirty).toBe(true);
    });

    it('dismisses when the requested tab disappears without affecting another dirty tab', async () => {
        const target = createTab('target', 'Zaliznyak.pdf', 'generation-1');
        const other = createTab('other', 'Other.pdf', 'generation-1');
        const {
            dialog,
            tabs,
        } = createHarness([
            target,
            other,
        ]);

        const confirmation = dialog.requestDirtyTabCloseConfirmation(target.id);
        tabs.value = [other];
        await nextTick();

        expect(dialog.dirtyTabCloseDialogOpen.value).toBe(false);
        await expect(confirmation).resolves.toBe(false);
        expect(other.isDirty).toBe(true);
    });
});
