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
    onCommit: (text: string) => void;
    onCancel: () => void;
}

interface ITextBoxInputEvent {
    currentTarget: EventTarget | null;
    target?: EventTarget | null;
}

interface ITextBoxKeydownEvent {
    key: string;
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
    handleBlur(): void;
}

function readEditorText(element: HTMLElement) {
    const innerText = element.innerText;
    return normalizeAnnotationText(typeof innerText === 'string' ? innerText : element.textContent ?? '');
}

function selectEditorContents(element: HTMLElement) {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return;
    }
    element.focus();
    const selection = window.getSelection();
    if (!selection) {
        return;
    }
    const range = document.createRange();
    range.selectNodeContents(element);
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
            selectEditorContents(editorRef.value);
        }
    }

    watch(options.editing, (editing) => {
        if (!editing) {
            return;
        }
        completed = false;
        ignoreBlur = false;
        draftText.value = options.entity.value.text;
        void focusEditor();
    }, {immediate: true});

    watch(options.entity, (entity) => {
        if (!options.editing.value) {
            draftText.value = entity.text;
        }
    });

    function handleInput(event: ITextBoxInputEvent) {
        if (!options.editing.value) {
            return;
        }
        const target = event.currentTarget ?? event.target ?? null;
        if (!isEditorElement(target)) {
            return;
        }
        draftText.value = readEditorText(target);
    }

    function commit() {
        if (!options.editing.value || completed) {
            return;
        }
        completed = true;
        options.onCommit(draftText.value);
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
        if (!options.editing.value) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
            return;
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit();
        }
    }

    function handleBlur() {
        if (ignoreBlur) {
            ignoreBlur = false;
            return;
        }
        commit();
    }

    onScopeDispose(() => {
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
