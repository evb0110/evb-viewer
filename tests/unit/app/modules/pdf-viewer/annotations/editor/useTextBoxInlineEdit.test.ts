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
import {requirePageIndex} from '@contracts/pageNumbers';

const entity = ref<ITextBoxEntity>({
    kind: 'text-box',
    identity: {id: 'text-box' as ITextBoxEntity['identity']['id']},
    pageIndex: requirePageIndex(0),
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
        expect(commit).toHaveBeenCalledWith('after', {restoreFocus: false});
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
    it('retains the latest completed input while ignoring an IME composition update', async () => {
        const editing = ref(true);
        const scope = effectScope();
        scopes.add(scope);
        const editor = scope.run(() => useTextBoxInlineEdit({
            entity: computed(() => entity.value),
            editing,
            onCommit: vi.fn(),
            onCancel: vi.fn(),
        }))!;
        await Promise.resolve();
        const element = {textContent: 'composition'} as HTMLElement;
        editor.editorRef.value = element;
        editor.handleInput({
            currentTarget: element,
            isComposing: true,
        });
        expect(editor.draftText.value).toBe('before');
        editor.handleInput({
            currentTarget: element,
            isComposing: false,
        });
        expect(editor.draftText.value).toBe('composition');
    });

    it('initializes a restored editor from its pending draft without changing the entity', async () => {
        const editing = ref(false);
        const recoveredDraftText = ref<string | null>('restored text');
        const scope = effectScope();
        scopes.add(scope);
        const editor = scope.run(() => useTextBoxInlineEdit({
            entity: computed(() => entity.value),
            editing,
            recoveredDraftText,
            onCommit: vi.fn(),
            onCancel: vi.fn(),
        }))!;
        editing.value = true;
        await Promise.resolve();

        expect(editor.draftText.value).toBe('restored text');
        expect(entity.value.text).toBe('before');
    });

    it.each([
        'Escape',
        'Enter',
    ])('leaves composing %s to the input method', async (key) => {
        const editing = ref(true);
        const commit = vi.fn();
        const cancel = vi.fn();
        const preventDefault = vi.fn();
        const scope = effectScope();
        scopes.add(scope);
        const editor = scope.run(() => useTextBoxInlineEdit({
            entity: computed(() => entity.value),
            editing,
            onCommit: commit,
            onCancel: cancel,
        }))!;
        await Promise.resolve();
        editor.handleKeydown({
            key,
            isComposing: true,
            ctrlKey: true,
            metaKey: false,
            preventDefault,
        });
        expect(commit).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        editor.handleBlur();
        expect(commit).toHaveBeenCalledOnce();
    });

});
