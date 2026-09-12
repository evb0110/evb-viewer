import type { IAnnotationTextEditPoint } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    normalizeAnnotationText,
    type ITextBoxEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

interface ITextBoxInlineEditOptions {
    entity: ComputedRef<ITextBoxEntity>;
    editing: Readonly<Ref<boolean>>;
    recoveredDraftText?: Readonly<Ref<string | null>>;
    caretPoint?: Readonly<Ref<IAnnotationTextEditPoint | null>>;
    onCommit: (text: string, options?: {restoreFocus: boolean}) => void;
    onCancel: () => void;
}

interface ITextBoxInputEvent {
    currentTarget: EventTarget | null;
    target?: EventTarget | null;
    isComposing?: boolean;
}

interface ITextBoxKeydownEvent {
    key: string;
    isComposing?: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    preventDefault: () => void;
}

export interface ITextBoxInlineEdit {
    readonly editorRef: Ref<HTMLElement | null>;
    readonly draftText: Ref<string>;
    commit(): void;
    handleInput(event: ITextBoxInputEvent): void;
    handleKeydown(event: ITextBoxKeydownEvent): void;
    handleBlur(event?: Pick<FocusEvent, 'relatedTarget'>): void;
}

function readEditorText(element: HTMLElement) {
    const innerText = element.innerText;
    return normalizeAnnotationText(typeof innerText === 'string' ? innerText : element.textContent ?? '');
}

function placeEditorCaret(element: HTMLElement, point: IAnnotationTextEditPoint | null) {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return;
    }
    element.focus();
    const selection = window.getSelection();
    if (!selection) {
        return;
    }
    const position = point ? document.caretPositionFromPoint?.(point.clientX, point.clientY) : null;
    const range = document.createRange();
    if (position && element.contains(position.offsetNode)) {
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
    } else {
        range.selectNodeContents(element);
        range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
}

function isEditorElement(value: EventTarget | null): value is HTMLElement {
    return typeof value === 'object'
        && value !== null
        && 'textContent' in value;
}

export const useTextBoxInlineEdit = (
    options: ITextBoxInlineEditOptions,
): ITextBoxInlineEdit => {
    const editorRef = ref<HTMLElement | null>(null);
    const draftText = ref(options.entity.value.text);
    let completed = false;
    let ignoreBlur = false;

    async function focusEditor() {
        await nextTick();
        if (options.editing.value && editorRef.value) {
            editorRef.value.textContent = draftText.value;
            placeEditorCaret(editorRef.value, options.caretPoint?.value ?? null);
        }
    }

    watch(options.editing, (editing) => {
        if (!editing) {
            return;
        }
        completed = false;
        ignoreBlur = false;
        draftText.value = options.recoveredDraftText?.value ?? options.entity.value.text;
        void focusEditor();
    }, {immediate: true});

    watch(options.entity, (entity) => {
        if (!options.editing.value) {
            draftText.value = entity.text;
        }
    });

    function handleInput(event: ITextBoxInputEvent) {
        if (!options.editing.value || event.isComposing) {
            return;
        }
        const target = event.currentTarget ?? event.target ?? null;
        if (!isEditorElement(target)) {
            return;
        }
        draftText.value = readEditorText(target);
    }

    function commit(restoreFocus = false) {
        if (!options.editing.value || completed) {
            return;
        }
        completed = true;
        options.onCommit(draftText.value, {restoreFocus});
    }

    function cancel() {
        if (!options.editing.value || completed) {
            return;
        }
        completed = true;
        ignoreBlur = true;
        options.onCancel();
    }

    function handleKeydown(event: ITextBoxKeydownEvent) {
        if (event.isComposing || !options.editing.value) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
            return;
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit(true);
        }
    }

    function isInspectorTarget(target: EventTarget | null | undefined) {
        return typeof HTMLElement !== 'undefined'
            && target instanceof HTMLElement
            && Boolean(target.closest('[data-annotation-inspector]'));
    }

    function isTextContextTarget(target: EventTarget | null | undefined) {
        return isInspectorTarget(target)
            || (typeof Node !== 'undefined' && target instanceof Node && Boolean(editorRef.value?.contains(target)));
    }

    function handleContextFocusOut(event: FocusEvent) {
        if (options.editing.value && isInspectorTarget(event.target) && !isTextContextTarget(event.relatedTarget)) {
            commit();
        }
    }

    watch(options.editing, (editing) => {
        if (typeof document === 'undefined') {
            return;
        }
        if (editing) document.addEventListener('focusout', handleContextFocusOut);
        else document.removeEventListener('focusout', handleContextFocusOut);
    }, {immediate: true});

    function handleBlur(event?: Pick<FocusEvent, 'relatedTarget'>) {
        if (ignoreBlur) {
            ignoreBlur = false;
            return;
        }
        if (!isInspectorTarget(event?.relatedTarget)) commit();
    }

    onScopeDispose(() => {
        if (typeof document !== 'undefined') document.removeEventListener('focusout', handleContextFocusOut);
        completed = true;
        ignoreBlur = true;
    });

    return {
        editorRef,
        draftText,
        commit,
        handleInput,
        handleKeydown,
        handleBlur,
    };
};
