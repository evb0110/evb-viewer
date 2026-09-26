// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
    ref,
} from 'vue';
import WorkspaceAnnotationOverlays from '@app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue';
import {
    provideDocumentContext,
    type TDocumentContext,
} from '@app/modules/workspace-shell/documentContext';
import { cast } from '@tests/helpers/cast';
import type {IAnnotationNoteWindowEntry} from '@app/modules/workspace-shell/annotations/annotationNoteWindowEntry';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const disposals: Array<() => void> = [];
afterEach(() => disposals.splice(0).forEach(dispose => dispose()));

function mountNotes() {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = document.createElement('div');
    editor.tabIndex = 0;
    host.append(editor);
    const notes = reactive<IAnnotationNoteWindowEntry[]>([{
        annotationId: 'note-1',
        pageIndex: 0,
        pageNumber: 1,
        author: null,
        createdAt: null,
        modifiedAt: null,
        markerRect: null,
        subtype: 'Text',
        source: 'pdf',
        hasNote: true,
        draftText: 'Note',
        saving: false,
        error: null,
        order: 1,
        isMinimized: false,
    }]);
    const state = reactive({visible: true});
    const focusReturned = vi.fn(() => editor.focus());
    const overlayHost = document.createElement('div');
    host.append(overlayHost);
    const annotations = {
        sortedAnnotationNoteWindows: computed(() => notes),
        annotationNotePositions: ref({}),
        annotationContextMenu: ref({
            visible: false,
            x: 0,
            y: 0,
            comment: null,
            hasSelection: false,
            selectionText: '',
            pageNumber: null,
            pageX: null,
            pageY: null,
        }),
        annotationContextMenuStyle: ref({}),
        annotationContextMenuCanCopy: ref(false),
        annotationContextMenuCanCopySelection: ref(false),
        annotationContextMenuCanCreateFree: ref(false),
        annotationContextMenuCanInsertImage: ref(false),
        annotationContextMenuIsImage: ref(false),
        contextMenuAnnotationLabel: ref(''),
        contextMenuDeleteActionLabel: ref(''),
        minimizeAnnotationNote: (id: string) => {
            const note = notes.find(item => item.annotationId === id);
            if (note) note.isMinimized = true;
        },
        focusAnnotationNote: focusReturned,
        updateAnnotationNoteText: vi.fn(),
        updateAnnotationNotePosition: vi.fn(),
        bringAnnotationNoteToFront: vi.fn(),
    };
    const context = {
        annotations,
        annotationActions: {},
        pageContextMenu: {
            pageContextMenu: ref({
                visible: false,
                x: 0,
                y: 0,
                clickedPage: null,
                pages: [],
                selection: null,
            }),
            pageContextMenuStyle: ref({}),
        },
        pageOps: {isPageOperationInProgress: ref(false)},
        file: {isDjvuMode: ref(false)},
        view: {
            pdfViewerRef: ref(null),
            effectiveZoom: ref(1),
        },
    };
    const app = createApp(defineComponent({setup: () => {
        provideDocumentContext(cast<TDocumentContext>(context));
        return () => h(WorkspaceAnnotationOverlays, {visible: state.visible});
    }}));
    app.component('UIcon', defineComponent({setup: () => () => h('span')}));
    app.component('AppTooltip', defineComponent({setup: (_props, {slots}) => () => slots.default?.()}));
    app.mount(overlayHost);
    disposals.push(() => {
        app.unmount();
        host.remove();
    });
    return {
        host,
        editor,
        notes,
        state,
        focusReturned,
    };
}

it('returns focus after the focused close button is removed', async () => {
    const mounted = mountNotes();
    await nextTick();
    await nextTick();
    const close = mounted.host.querySelector<HTMLButtonElement>('.note-window__close')!;
    close.focus();
    close.click();
    await nextTick();
    await nextTick();
    expect(mounted.host.querySelector('.note-window')).toBeNull();
    expect(mounted.focusReturned).toHaveBeenCalledExactlyOnceWith('note-1');
    expect(document.activeElement).toBe(mounted.editor);
});

it('does not take focus from another note while the first window closes', async () => {
    const mounted = mountNotes();
    mounted.notes.push({
        ...mounted.notes[0]!,
        annotationId: 'note-2',
        order: 2,
    });
    await nextTick();
    await nextTick();
    const close = mounted.host.querySelector<HTMLButtonElement>('.note-window__close')!;
    close.focus();
    close.click();
    const otherInput = mounted.host.querySelector<HTMLTextAreaElement>('[data-annotation-id="note-2"] textarea')!;
    otherInput.focus();
    await nextTick();
    await nextTick();
    expect(mounted.focusReturned).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(otherInput);
});

it('does not return focus after the workspace becomes inactive', async () => {
    const mounted = mountNotes();
    await nextTick();
    await nextTick();
    const close = mounted.host.querySelector<HTMLButtonElement>('.note-window__close')!;
    close.focus();
    close.click();
    mounted.state.visible = false;
    await nextTick();
    await nextTick();
    expect(mounted.focusReturned).not.toHaveBeenCalled();
});
