// @vitest-environment happy-dom
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
    nextTick,
    ref,
} from 'vue';
import {useTextBoxInlineEdit} from '@app/modules/pdf-viewer/annotations/editor/useTextBoxInlineEdit';
import {
    asAnnotationId,
    type ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';

describe('text box caret ownership', () => {
    const scopes: Array<ReturnType<typeof effectScope>> = [];
    afterEach(() => {
        scopes.splice(0).forEach(scope => scope.stop());
        document.body.replaceChildren();
        vi.restoreAllMocks();
        Reflect.deleteProperty(document, 'caretPositionFromPoint');
    });

    async function start(point?: {
        clientX: number;
        clientY: number
    }) {
        const entity: ITextBoxEntity = {
            kind: 'text-box',
            identity: {id: asAnnotationId('caret')},
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: 0,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            text: 'existing words',
            rect: {
                left: 0,
                top: 0,
                width: 0.3,
                height: 0.1,
            },
            rotation: 0,
            fontSize: 14,
            color: '#000000',
        };
        const scope = effectScope();
        scopes.push(scope);
        const commit = vi.fn();
        const editing = ref(true);
        const editor = scope.run(() => useTextBoxInlineEdit({
            entity: computed(() => entity),
            editing,
            caretPoint: ref(point ?? null),
            onCommit: commit,
            onCancel: vi.fn(),
        }))!;
        const element = document.createElement('div');
        element.contentEditable = 'true';
        element.tabIndex = 0;
        document.body.append(element);
        editor.editorRef.value = element;
        await nextTick();
        return {
            element,
            editor,
            commit,
        };
    }

    it('enters existing text with a collapsed caret instead of selecting replacement text', async () => {
        const {element} = await start();
        expect(document.activeElement).toBe(element);
        expect(window.getSelection()?.isCollapsed).toBe(true);
        expect(window.getSelection()?.toString()).toBe('');
        expect(element.textContent).toBe('existing words');
    });

    it('places the caret at the clicked character when the browser resolves the point', async () => {
        const resolvePoint = vi.fn(() => {
            const element = document.querySelector('[contenteditable]')!;
            return {
                offsetNode: element.firstChild!,
                offset: 4,
            };
        });
        Object.defineProperty(document, 'caretPositionFromPoint', {
            value: resolvePoint,
            configurable: true,
        });
        await start({
            clientX: 40,
            clientY: 50,
        });
        expect(resolvePoint).toHaveBeenCalledWith(40, 50);
        expect(window.getSelection()?.anchorOffset).toBe(4);
        expect(window.getSelection()?.isCollapsed).toBe(true);
    });

    it('restores object focus for explicit Done but preserves the destination on blur', async () => {
        const {
            editor,
            commit,
        } = await start();
        editor.handleKeydown({
            key: 'Enter',
            ctrlKey: false,
            metaKey: true,
            preventDefault: vi.fn(),
        });
        editor.handleBlur();
        expect(commit).toHaveBeenCalledExactlyOnceWith('existing words', {restoreFocus: true});
    });
    it('keeps a draft active while operating properties and commits when focus leaves both', async () => {
        const {
            element,
            editor,
            commit,
        } = await start();
        element.addEventListener('blur', event => editor.handleBlur(event));
        const inspector = document.createElement('section');
        inspector.dataset.annotationInspector = '';
        const property = document.createElement('input');
        property.type = 'number';
        inspector.append(property);
        const outside = document.createElement('button');
        document.body.append(inspector, outside);
        property.focus();
        expect(document.activeElement).toBe(property);
        expect(commit).not.toHaveBeenCalled();
        property.value = '24';
        property.dispatchEvent(new Event('change', {bubbles: true}));
        expect(commit).not.toHaveBeenCalled();
        outside.focus();
        expect(commit).toHaveBeenCalledExactlyOnceWith('existing words', {restoreFocus: false});
        expect(document.activeElement).toBe(outside);
    });

});
