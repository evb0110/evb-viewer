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
    onCommit: (text: string, options?: {restoreFocus: boolean}) => void | Promise<void>;
    onCancel: () => void | Promise<void>;
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
    readonly pendingCompletion: Promise<void> | null;
    commit(): void | Promise<void>;
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
    let completion: Promise<void> | null = null;

    async function focusEditor() {
        await nextTick();
        if (options.editing.value && editorRef.value) {
            editorRef.value.textContent = draftText.value;
            placeEditorCaret(editorRef.value, options.caretPoint?.value ?? null);
        }
    }

    watch(options.editing, (editing) => {
        if (typeof document !== 'undefined') {
            if (editing) document.addEventListener('focusout', handleContextFocusOut);
            else document.removeEventListener('focusout', handleContextFocusOut);
        }
        if (!editing) {
            return;
        }
        completion = null;
        draftText.value = options.recoveredDraftText?.value ?? options.entity.value.text;
        void focusEditor();
    }, {immediate: true});

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

    function complete(action: () => void | Promise<void>) {
        if (!options.editing.value) {
            return;
        }
        if (completion) return completion;
        const pending = (async () => {
            if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;
            await action();
        })();
        completion = pending;
        void pending.catch(() => {
            if (completion === pending) {
                completion = null;
                if (editorRef.value?.ownerDocument.activeElement !== editorRef.value) void focusEditor();
            }
        });
        return pending;
    }

    const commit = (restoreFocus = false) => complete(() => options.onCommit(draftText.value, {restoreFocus}));

    function handleKeydown(event: ITextBoxKeydownEvent) {
        if (event.isComposing || !options.editing.value) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            void complete(options.onCancel);
            return;
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void commit(true);
        }
    }

    function isInspectorTarget(target: EventTarget | null | undefined) {
        return typeof HTMLElement !== 'undefined'
            && target instanceof HTMLElement
            && Boolean(target.closest('[data-annotation-inspector]'));
    }

    function handleContextFocusOut(event: FocusEvent) {
        const target = event.relatedTarget;
        if (options.editing.value && isInspectorTarget(event.target) && !isInspectorTarget(target)
            && !(typeof Node !== 'undefined' && target instanceof Node && editorRef.value?.contains(target))) {
            void commit();
        }
    }

    function handleBlur(event?: Pick<FocusEvent, 'relatedTarget'>) {
        if (!isInspectorTarget(event?.relatedTarget)) void commit();
    }

    onScopeDispose(() => {
        if (typeof document !== 'undefined') document.removeEventListener('focusout', handleContextFocusOut);
    });

    return {
        editorRef,
        draftText,
        get pendingCompletion() { return options.editing.value ? completion : null; },
        commit,
        handleInput,
        handleKeydown,
        handleBlur,
    };
};
