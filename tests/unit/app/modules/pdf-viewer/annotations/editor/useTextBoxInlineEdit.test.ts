import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    ref,
} from 'vue';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { useTextBoxInlineEdit } from '@app/modules/pdf-viewer/annotations/editor/useTextBoxInlineEdit';

const entity = ref<ITextBoxEntity>({
    kind: 'text-box',
    identity: {id: 'text-box' as ITextBoxEntity['identity']['id']},
    pageIndex: 0,
    revision: 1,
    persistedRevision: 1,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    text: 'before',
    rect: {
        left: 0.1,
        top: 0.1,
        width: 0.3,
        height: 0.1,
    },
    rotation: 0,
    fontSize: 14,
    color: '#111827',
});

describe('useTextBoxInlineEdit', () => {
    const scopes = new Set<ReturnType<typeof effectScope>>();

    afterEach(() => {
        scopes.forEach(scope => scope.stop());
        scopes.clear();
        entity.value = {
            ...entity.value,
            text: 'before',
        };
    });

    it('commits normalized editor text once on blur', async () => {
        const editing = ref(false);
        const commit = vi.fn();
        const cancel = vi.fn();
        const scope = effectScope();
        scopes.add(scope);
        const editor = scope.run(() => useTextBoxInlineEdit({
            entity: computed(() => entity.value),
            editing,
            onCommit: commit,
            onCancel: cancel,
        }))!;

        editing.value = true;
        await Promise.resolve();
        const element = {textContent: 'after\u200B'} as HTMLElement;
        editor.editorRef.value = element;
        editor.handleInput({currentTarget: element});
        editor.handleBlur();
        editor.handleBlur();

        expect(commit).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledWith('after');
        expect(cancel).not.toHaveBeenCalled();
    });

    it('cancels on Escape and does not commit the following blur', async () => {
        const editing = ref(false);
        const commit = vi.fn();
        const cancel = vi.fn();
        const scope = effectScope();
        scopes.add(scope);
        const editor = scope.run(() => useTextBoxInlineEdit({
            entity: computed(() => entity.value),
            editing,
            onCommit: commit,
            onCancel: cancel,
        }))!;

        editing.value = true;
        await Promise.resolve();
        editor.handleKeydown({
            key: 'Escape',
            ctrlKey: false,
            metaKey: false,
            preventDefault: vi.fn(),
        });
        editor.handleBlur();

        expect(cancel).toHaveBeenCalledOnce();
        expect(commit).not.toHaveBeenCalled();
    });
});
