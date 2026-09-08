// @vitest-environment happy-dom

import {
    afterEach,
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
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    type AnnotationEntity,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { useAnnotationNoteWindows } from '@app/modules/workspace-shell/composables/useAnnotationNoteWindows';
import {
    mountAnnotationCommentsList,
    unmountAnnotationCommentsLists,
} from '@tests/helpers/pdfAnnotationCommentsListHarness';
import { requirePageIndex } from '@contracts/pageNumbers';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

afterEach(unmountAnnotationCommentsLists);

const rect = {
    left: 0.1,
    top: 0.2,
    width: 0.3,
    height: 0.1,
};

function note(id = 'note-1'): INoteEntity {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: 'Original Author',
        kind: 'note',
        position: rect,
        contents: 'Before',
        color: '#ff0000',
        open: false,
        replies: [],
    };
}

function applicationWith(entity: AnnotationEntity) {
    const application = new AnnotationApplication('projection-test');
    application.store.replaceFromDocument([entity], []);
    return application;
}

it.each([
    'text-box',
    'note',
    'text-markup',
    'shape',
] as const)('renders canonical %s color even without a document-text preview', async (kind) => {
    const source = note();
    const entity: AnnotationEntity = kind === 'text-box'
        ? {
            ...source,
            kind,
            rect,
            text: 'Colored text',
            fontSize: 12,
            rotation: 0,
        }
        : kind === 'text-markup'
            ? {
                ...source,
                kind,
                subtype: 'Highlight',
                contents: '',
                selectedText: null,
                quadPoints: [rect],
                opacity: 0.4,
            }
            : kind === 'shape'
                ? {
                    ...source,
                    kind,
                    tool: 'rectangle',
                    rect,
                    strokeColor: '#ff0000',
                    strokeWidth: 2,
                    fill: '#00ff00',
                    opacity: 0.5,
                }
                : source;
    const application = applicationWith(entity);
    const mounted = mountAnnotationCommentsList({comments: application.listCommentSummaries()});
    await nextTick();
    const row = mounted.host.querySelector<HTMLElement>('.note-item');
    const chip = row?.querySelector<HTMLElement>('.note-item-color-chip');

    expect(row?.dataset.annotationId).toBe('note-1');
    expect(row?.dataset.annotationKind).toBe(kind);
    expect(chip?.style.getPropertyValue('--note-item-chip-color')).toBe('#ff0000');
    expect(row?.textContent).toContain('Original Author');
    if (kind === 'shape') {
        expect(row?.querySelector<HTMLElement>('.note-item-shape-fill')?.style.backgroundColor).toBe('#00ff00');
    }
});

it('keeps the shape row identity and author across its first save binding', async () => {
    const application = applicationWith({
        ...note('shape-1'),
        persistedRevision: -1,
        kind: 'shape',
        tool: 'rectangle',
        rect,
        strokeColor: '#ff0000',
        strokeWidth: 2,
        fill: null,
        opacity: 1,
    });
    const before = application.listCommentSummaries()[0]!;
    const mounted = mountAnnotationCommentsList({comments: [before]});
    const session = application.beginSave();
    application.acknowledgeSave(session, null, [{
        annotationId: 'shape-1',
        pdfRef: '11 0 R',
    }]);
    await mounted.setComments(application.listCommentSummaries());

    expect(application.listCommentSummaries()[0]).toMatchObject({
        appAnnotationId: 'shape-1',
        author: 'Original Author',
    });
    expect(mounted.host.querySelector<HTMLElement>('.note-item')?.dataset.annotationId).toBe('shape-1');
});

it('activates a text box for inline editing instead of opening a note window', async () => {
    const application = applicationWith({
        ...note('text-1'),
        kind: 'text-box',
        rect,
        text: 'Text on the page',
        fontSize: 12,
        rotation: 0,
    });
    const mounted = mountAnnotationCommentsList({comments: application.listCommentSummaries()});
    await nextTick();
    mounted.host.querySelector('.note-item-content')?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));

    expect(mounted.events.edited).toHaveLength(1);
    expect(mounted.events.opened).toHaveLength(0);
});

it.each([
    'text-box',
    'note',
] as const)('opens a canonical %s with Enter while a pointer click only selects it', async (kind) => {
    const entity: AnnotationEntity = kind === 'text-box' ? {
        ...note('text-1'),
        kind,
        rect,
        text: 'Text on the page',
        fontSize: 12,
        rotation: 0,
    } : note();
    const application = applicationWith(entity);
    const mounted = mountAnnotationCommentsList({comments: application.listCommentSummaries()});
    await nextTick();
    const button = mounted.host.querySelector<HTMLButtonElement>('.note-item-content')!;
    button.click();
    expect(mounted.events.focused).toHaveLength(1);
    expect(mounted.events.edited).toHaveLength(0);
    expect(mounted.events.opened).toHaveLength(0);

    const propagatedKeydown = vi.fn();
    mounted.host.addEventListener('keydown', propagatedKeydown);
    button.focus();
    const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
    });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(propagatedKeydown).not.toHaveBeenCalled();
    expect(mounted.events.focused).toHaveLength(2);
    expect(mounted.events.edited).toHaveLength(kind === 'text-box' ? 1 : 0);
    expect(mounted.events.opened).toHaveLength(kind === 'note' ? 1 : 0);
});

it('finds a shape by the type label rendered in its card', async () => {
    const application = applicationWith({
        ...note('shape-1'),
        kind: 'shape',
        tool: 'rectangle',
        rect,
        strokeColor: '#ff0000',
        strokeWidth: 2,
        fill: null,
        opacity: 1,
    });
    const mounted = mountAnnotationCommentsList({comments: application.listCommentSummaries()});
    await nextTick();
    const typeLabel = mounted.host.querySelector('.note-item-type')?.textContent?.trim();
    expect(typeLabel).toBeTruthy();
    mounted.host.querySelector<HTMLButtonElement>('.notes-header-btn:not(.notes-header-btn--place)')?.click();
    await nextTick();
    const searchInput = mounted.host.querySelector<HTMLInputElement>('input');
    expect(searchInput).not.toBeNull();
    searchInput!.value = typeLabel!;
    searchInput!.dispatchEvent(new Event('input', {bubbles: true}));
    await nextTick();

    expect(mounted.host.querySelectorAll('.note-item')).toHaveLength(1);
    expect(mounted.host.querySelector('.note-match')?.textContent).toBe(typeLabel);
});

it('presents an image as an image without inventing a color or an empty note', async () => {
    const application = applicationWith({
        ...note('image-1'),
        kind: 'placed-image',
        rect,
        rotation: 0,
        image: {
            objectNumber: 8,
            generationNumber: 0,
            byteLength: 16,
            sha256: 'abcdef',
        },
    });
    const mounted = mountAnnotationCommentsList({comments: application.listCommentSummaries()});
    await nextTick();

    expect(mounted.host.querySelector('.note-item')?.getAttribute('data-annotation-kind')).toBe('placed-image');
    expect(mounted.host.querySelector('.note-item-type')?.textContent).toContain('annotations.imageLabel');
    expect(mounted.host.querySelector('.note-item-text')?.textContent).toContain('annotations.imageLabel');
    expect(mounted.host.querySelector('.note-item-color-chip')).toBeNull();
});

function noteWindows(application = applicationWith(note())) {
    const comments = ref([...application.listCommentSummaries()]);
    const syncReady = ref(true);
    const unsubscribe = application.store.subscribe(() => {
        comments.value = [...application.listCommentSummaries()];
    });
    const scope = effectScope();
    const windows = scope.run(() => useAnnotationNoteWindows({
        annotationComments: comments,
        markAnnotationDirty: () => {},
        updateAnnotationCommentInViewer: (id, contents) => Boolean(application.store.updateNote(id, {contents})),
        getDeletedCanonicalAnnotationIds: () => application.store.deletedAnnotationIds(),
        isAnnotationCommentSyncReady: () => syncReady.value,
    }))!;
    return {
        application,
        comments,
        syncReady,
        windows,
        dispose() {
            scope.stop();
            unsubscribe();
        },
    };
}

it('refreshes an open clean note after canonical edits and undo', async () => {
    const harness = noteWindows();
    try {
        harness.windows.handleOpenAnnotationNote(harness.application.listCommentSummaries()[0]!);
        harness.application.store.updateNote(asAnnotationId('note-1'), {contents: 'External'});
        await nextTick();
        expect(harness.windows.findAnnotationNoteWindow('note-1')?.draftText).toBe('External');
        harness.windows.updateAnnotationNoteText('note-1', 'Local edit');
        await harness.windows.persistAnnotationNote('note-1');
        await nextTick();
        harness.application.store.undo();
        await nextTick();
        expect(harness.application.listCommentSummaries()[0]?.text).toBe('External');
        expect(harness.windows.findAnnotationNoteWindow('note-1')?.draftText).toBe('External');
    } finally {
        harness.dispose();
    }
});

it('preserves an uncommitted draft while tracking the newer canonical text and color', async () => {
    const harness = noteWindows();
    try {
        harness.windows.handleOpenAnnotationNote(harness.application.listCommentSummaries()[0]!);
        harness.windows.updateAnnotationNoteText('note-1', 'Uncommitted');
        harness.application.store.updateNote(asAnnotationId('note-1'), {
            contents: 'External',
            color: '#00ff00',
        });
        await nextTick();
        expect(harness.windows.findAnnotationNoteWindow('note-1')).toMatchObject({
            draftText: 'Uncommitted',
            dirty: true,
            color: '#00ff00',
        });
        expect(harness.application.listCommentSummaries()[0]?.text).toBe('External');
    } finally {
        harness.dispose();
    }
});

it.each([
    'delete',
    'undo-creation',
] as const)('closes a dirty window on definitive canonical %s', async (operation) => {
    const application = new AnnotationApplication('canonical-deletion');
    application.store.createNote({
        ...note(),
        persistedRevision: -1,
    });
    const harness = noteWindows(application);
    const original = application.listCommentSummaries()[0]!;
    try {
        harness.windows.handleOpenAnnotationNote(original);
        harness.windows.updateAnnotationNoteText('note-1', 'Uncommitted draft');
        if (operation === 'delete') {
            application.store.delete(asAnnotationId('note-1'));
        } else {
            application.store.undo();
        }
        await nextTick();
        expect(harness.windows.annotationNoteWindows.value).toHaveLength(0);
        await expect(harness.windows.persistAllAnnotationNotes()).resolves.toBe(true);
        harness.windows.handleOpenAnnotationNote(original);
        expect(harness.windows.annotationNoteWindows.value).toHaveLength(0);
        expect(application.listCommentSummaries()).toHaveLength(0);
    } finally {
        harness.dispose();
    }
});

it('preserves a dirty window through an empty loading projection without a canonical deletion', async () => {
    const harness = noteWindows();
    try {
        harness.windows.handleOpenAnnotationNote(harness.application.listCommentSummaries()[0]!);
        harness.windows.updateAnnotationNoteText('note-1', 'Uncommitted draft');
        harness.syncReady.value = false;
        harness.comments.value = [];
        await nextTick();
        expect(harness.windows.findAnnotationNoteWindow('note-1')?.draftText).toBe('Uncommitted draft');
        harness.syncReady.value = true;
        harness.comments.value = [...harness.application.listCommentSummaries()];
        await nextTick();
        expect(harness.windows.findAnnotationNoteWindow('note-1')).toMatchObject({
            draftText: 'Uncommitted draft',
            dirty: true,
        });
    } finally {
        harness.dispose();
    }
});

it('does not reopen a deleted window when its pending save settles', async () => {
    const application = applicationWith(note());
    const comments = ref([...application.listCommentSummaries()]);
    const unsubscribe = application.store.subscribe(() => {
        comments.value = [...application.listCommentSummaries()];
    });
    const scope = effectScope();
    let settle!: (value: boolean) => void;
    const windows = scope.run(() => useAnnotationNoteWindows({
        annotationComments: comments,
        markAnnotationDirty: () => {},
        getDeletedCanonicalAnnotationIds: () => application.store.deletedAnnotationIds(),
        updateAnnotationCommentInViewer: () => new Promise<boolean>((resolve) => { settle = resolve; }),
    }))!;
    try {
        windows.handleOpenAnnotationNote(comments.value[0]!);
        windows.updateAnnotationNoteText('note-1', 'Pending');
        const pending = windows.persistAnnotationNote('note-1');
        application.store.delete(asAnnotationId('note-1'));
        await nextTick();
        expect(windows.annotationNoteWindows.value).toHaveLength(0);
        expect(windows.isAnyAnnotationNoteSaving.value).toBe(false);
        settle(true);
        await pending;
        expect(windows.annotationNoteWindows.value).toHaveLength(0);
        expect(application.listCommentSummaries()).toHaveLength(0);
    } finally {
        scope.stop();
        unsubscribe();
    }
});

it('invalidates rendered order when an overlapping note is raised', () => {
    const application = applicationWith(note());
    application.store.createNote({
        ...note('note-2'),
        persistedRevision: -1,
    });
    const harness = noteWindows(application);
    try {
        application.listCommentSummaries().forEach(harness.windows.handleOpenAnnotationNote);
        expect(harness.windows.sortedAnnotationNoteWindows.value.map(window => window.annotationId)).toEqual([
            'note-1',
            'note-2',
        ]);
        harness.windows.bringAnnotationNoteToFront('note-1');
        expect(harness.windows.sortedAnnotationNoteWindows.value.map(window => window.annotationId)).toEqual([
            'note-2',
            'note-1',
        ]);
    } finally {
        harness.dispose();
    }
});

it('invalidates rendered saving and error state when an asynchronous update settles', async () => {
    const scope = effectScope();
    let settle!: (value: boolean) => void;
    const application = applicationWith(note());
    const windows = scope.run(() => useAnnotationNoteWindows({
        annotationComments: ref([...application.listCommentSummaries()]),
        markAnnotationDirty: () => {},
        updateAnnotationCommentInViewer: () => new Promise<boolean>((resolve) => { settle = resolve; }),
    }))!;
    windows.handleOpenAnnotationNote(application.listCommentSummaries()[0]!);
    const presentation = computed(() => ({
        saving: windows.findAnnotationNoteWindow('note-1')?.saving,
        error: windows.findAnnotationNoteWindow('note-1')?.error,
    }));
    try {
        expect(presentation.value.saving).toBe(false);
        expect(windows.isAnyAnnotationNoteSaving.value).toBe(false);
        windows.updateAnnotationNoteText('note-1', 'After');
        const pending = windows.persistAnnotationNote('note-1');
        expect(presentation.value.saving).toBe(true);
        expect(windows.isAnyAnnotationNoteSaving.value).toBe(true);
        settle(false);
        await pending;
        expect(presentation.value.saving).toBe(false);
        expect(presentation.value.error).toBeTruthy();
        expect(windows.isAnyAnnotationNoteSaving.value).toBe(false);
    } finally {
        scope.stop();
    }
});
