import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { AnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { ANNOTATION_NOTE_SAVE_DEBOUNCE_MS } from '@app/constants/timeouts';
import { useAnnotationNoteWindows } from '@app/modules/workspace-shell/composables/useAnnotationNoteWindows';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    const comment: IAnnotationCommentSummary = {
        id: 'note-1',
        stableKey: 'ann:0:note-1:0',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Initial note',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: 'ann-1',
        source: 'editor',
        hasNote: true,
        ...overrides,
    };
    return {
        ...comment,
        appAnnotationId: overrides.appAnnotationId ?? comment.stableKey,
    };
}

function createHarness(comment = createComment()) {
    const deps = {
        annotationComments: ref<IAnnotationCommentSummary[]>([comment]),
        markAnnotationDirty: vi.fn(),
        updateAnnotationCommentInViewer: vi.fn<
            (annotationId: AnnotationId, text: string) => boolean
        >(() => true),
        isAnnotationCommentSyncReady: vi.fn(() => true),
    };

    return {
        deps,
        windows: useAnnotationNoteWindows(deps),
    };
}

describe('useAnnotationNoteWindows', () => {
    it('skips forced no-op persistence when note text is unchanged', async () => {
        const {
            deps,
            windows,
        } = createHarness();

        windows.handleOpenAnnotationNote(createComment());

        const saved = await windows.persistAllAnnotationNotes();

        expect(saved).toBe(true);
        expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
    });

    it('does not materialize a full PDF reload when force-saving viewer-backed note edits', async () => {
        const {
            deps,
            windows,
        } = createHarness();

        windows.handleOpenAnnotationNote(createComment());
        const note = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            throw new Error('Expected an annotation note window for ann:0:note-1:0');
        }

        note.draftText = 'Updated text';
        note.dirty = true;
        const saved = windows.persistAnnotationNote('ann:0:note-1:0');

        expect(saved).toBe(true);
        expect(note.draftText).toBe('Updated text');
        expect(note.dirty).toBe(false);
        expect(note.draftText).toBe('Updated text');
        expect(deps.annotationComments.value.find(comment => comment.stableKey === 'ann:0:note-1:0')?.text).toBe('Initial note');
    });

    it('keeps an imported note dirty until asynchronous viewer reconciliation finishes', async () => {
        const {
            deps,
            windows,
        } = createHarness(createComment({
            source: 'pdf',
            annotationName: null,
        }));
        let resolveUpdate!: (updated: boolean) => void;
        deps.updateAnnotationCommentInViewer.mockImplementation(() => new Promise<boolean>((resolve) => {
            resolveUpdate = resolve;
        }) as never);
        windows.handleOpenAnnotationNote(deps.annotationComments.value[0]!);
        const note = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.draftText = 'Reconciled note';
        note.dirty = true;

        const saved = windows.persistAnnotationNote(note.annotationId);
        expect(saved).toBeInstanceOf(Promise);
        expect(note.dirty).toBe(true);
        expect(note.saving).toBe(true);
        resolveUpdate(true);

        await expect(saved).resolves.toBe(true);
        expect(note.dirty).toBe(false);
        expect(note.saving).toBe(false);
    });

    it('keeps a note dirty when the draft changes during an asynchronous save', async () => {
        const {
            deps,
            windows,
        } = createHarness(createComment({
            source: 'pdf',
            annotationName: null,
        }));
        let resolveUpdate!: (updated: boolean) => void;
        deps.updateAnnotationCommentInViewer.mockImplementation(() => new Promise<boolean>((resolve) => {
            resolveUpdate = resolve;
        }) as never);
        windows.handleOpenAnnotationNote(deps.annotationComments.value[0]!);
        const note = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.draftText = 'Submitted text';
        note.dirty = true;

        const saved = windows.persistAnnotationNote(note.annotationId);
        expect(saved).toBeInstanceOf(Promise);
        note.draftText = 'Edited while saving';
        resolveUpdate(true);

        await expect(saved).resolves.toBe(false);
        expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledWith('ann:0:note-1:0', 'Submitted text');
        const metadata = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        expect(metadata?.dirty).toBe(true);
        expect(metadata?.draftText).toBe('Edited while saving');
        expect(metadata?.saving).toBe(false);
    });

    it('preserves a note creation timestamp when saving through a synchronized summary without one', () => {
        const opened = createComment({
            createdAt: 111,
            modifiedAt: null,
        });
        const syncedWithoutCreatedAt = createComment({
            createdAt: null,
            modifiedAt: 222,
        });
        const {
            deps,
            windows,
        } = createHarness(opened);

        windows.handleOpenAnnotationNote(opened);
        deps.annotationComments.value = [syncedWithoutCreatedAt];

        const note = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.draftText = 'Updated through sync';
        note.dirty = true;
        const saved = windows.persistAnnotationNote('ann:0:note-1:0');

        expect(saved).toBe(true);
        expect(note.createdAt).toBe(111);
        expect(deps.annotationComments.value[0]?.createdAt).toBeNull();
    });

    it('mirrors existing PDF note saves into the embedded serialization pipeline', () => {
        const comment = createComment({
            id: '3856R',
            stableKey: 'ann:0:3856R',
            annotationId: '3856R',
            uid: null,
            source: 'pdf',
            text: 'Initial note',
        });
        const {
            deps,
            windows,
        } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:3856R');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.draftText = 'Updated PDF note';
        note.dirty = true;
        const saved = windows.persistAnnotationNote('ann:0:3856R');

        expect(saved).toBe(true);
        expect(note.draftText).toBe('Updated PDF note');
        expect(note.dirty).toBe(false);
        expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledWith(
            expect.any(String),
            'Updated PDF note',
        );
    });

    it('mirrors reopened editor-sourced notes with durable annotation ids into embedded serialization', () => {
        const comment = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: '3856R',
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'Initial note',
        });
        const {
            deps,
            windows,
        } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.draftText = 'Updated reopened note';
        note.dirty = true;
        const saved = windows.persistAnnotationNote('ann:0:pdfjs_internal_editor_0');

        expect(saved).toBe(true);
        expect(note.draftText).toBe('Updated reopened note');
        expect(note.dirty).toBe(false);
        expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledWith(
            expect.any(String),
            'Updated reopened note',
        );
    });

    it('does not migrate pending text from a legacy binding without an explicit app annotation id', async () => {
        const initialComment = createComment({
            id: 'runtime-note',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: '3856R',
            uid: 'pdfjs_internal_editor_0',
            source: 'pdf',
            text: 'Initial note',
        });
        const {
            deps,
            windows,
        } = createHarness(initialComment);

        windows.handleOpenAnnotationNote(initialComment);
        const note = windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.draftText = 'Updated PDF note';
        note.dirty = true;
        expect(windows.persistAnnotationNote('ann:0:pdfjs_internal_editor_0')).toBe(true);

        deps.annotationComments.value = [createComment({
            ...initialComment,
            id: '3856R',
            stableKey: 'ann:0:3856R',
            uid: null,
            text: 'Updated PDF note',
        })];
        await nextTick();

        expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);
    });

    it('keeps replayable editor-only notes dirty when forced viewer persistence fails', () => {
        const comment = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
        });
        const {
            deps,
            windows,
        } = createHarness(comment);

        deps.updateAnnotationCommentInViewer.mockReturnValue(false);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.draftText = 'Unsaved sticky note text';
        note.dirty = true;
        const saved = windows.persistAnnotationNote('ann:0:pdfjs_internal_editor_0');

        expect(saved).toBe(false);
        expect(note.pendingEmbeddedSave).toBe(false);
        expect(note.draftText).toBe('Unsaved sticky note text');
        expect(note.dirty).toBe(true);
        expect(note.error).not.toBeNull();
    });

    it('marks an embedded save pending when the auto path fails without force', () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);

        deps.updateAnnotationCommentInViewer.mockReturnValue(false);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        if (!note) {
            return;
        }
        note.draftText = 'Changed';
        note.dirty = true;
        const saved = windows.persistAnnotationNote('ann:0:note-1:0');

        expect(saved).toBe(false);
        expect(note.pendingEmbeddedSave).toBe(true);
        expect(note.dirty).toBe(true);
    });

    it('keeps the exact draft dirty when asynchronous viewer persistence rejects', async () => {
        const {
            deps,
            windows,
        } = createHarness();
        deps.updateAnnotationCommentInViewer.mockImplementation(() => (
            Promise.reject(new Error('viewer unavailable')) as never
        ));

        windows.handleOpenAnnotationNote(deps.annotationComments.value[0]!);
        const note = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.draftText = 'Must survive rejection';
        note.dirty = true;

        await expect(windows.persistAnnotationNote(note.annotationId)).resolves.toBe(false);
        expect(note.draftText).toBe('Must survive rejection');
        expect(note.dirty).toBe(true);
        expect(note.error).not.toBeNull();
    });

    it('closes an open note window when its backing annotation disappears from a ready sync', async () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.createdAtMs = Date.now() - 10_000;

        deps.annotationComments.value = [];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('ann:0:note-1:0')).toBeNull();
    });

    it('keeps a freshly opened note window while annotation sync catches up', async () => {
        vi.useFakeTimers();
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);

        try {
            windows.handleOpenAnnotationNote(comment);

            deps.annotationComments.value = [];
            await nextTick();

            await vi.advanceTimersByTimeAsync(4_999);
            expect(windows.findAnnotationNoteWindow('ann:0:note-1:0')).not.toBeNull();

            await vi.advanceTimersByTimeAsync(1);
            expect(windows.findAnnotationNoteWindow('ann:0:note-1:0')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a dirty note window when annotation sync temporarily misses it', async () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.createdAtMs = Date.now() - 10_000;
        windows.updateAnnotationNoteText('ann:0:note-1:0', 'Unsynced typed note');

        deps.annotationComments.value = [];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('ann:0:note-1:0')).not.toBeNull();
    });

    it('keeps an open note window during transient document reload sync gaps', async () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);
        deps.isAnnotationCommentSyncReady.mockReturnValue(false);

        windows.handleOpenAnnotationNote(comment);

        deps.annotationComments.value = [];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('ann:0:note-1:0')).not.toBeNull();
    });

    it('keeps locally saved new note comments as a read-only window projection', () => {
        const comment = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: '',
            subtype: 'FreeText',
            markerRect: {
                left: 0.2,
                top: 0.2,
                width: 0.01,
                height: 0.01,
            },
        });
        const {
            deps,
            windows,
        } = createHarness(comment);
        deps.annotationComments.value = [];

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.draftText = 'Replayable new note text';
        note.dirty = true;
        const saved = windows.persistAnnotationNote('ann:0:pdfjs_internal_editor_0');

        expect(saved).toBe(true);
        expect(note).toEqual(expect.objectContaining({
            annotationId: expect.any(String),
            draftText: 'Replayable new note text',
            hasNote: true,
            markerRect: comment.markerRect,
        }));
        expect(Object.isFrozen(note.markerRect)).toBe(true);
        expect(deps.annotationComments.value).toEqual([]);
    });

    it('keeps existing PDF notes when forced-saving a new editor note with a recycled runtime id', async () => {
        const existingPdfNote = createComment({
            id: '13275R',
            stableKey: 'ann:0:13275R',
            annotationId: '13275R',
            uid: null,
            source: 'pdf',
            text: 'existing embedded note',
            subtype: 'FreeText',
            markerRect: {
                left: 0.78,
                top: 0.08,
                width: 0.0016,
                height: 0.0016,
            },
        });
        const newEditorNote = createComment({
            id: 'pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'new editor note',
            subtype: 'Typewriter',
            markerRect: {
                left: 0.72,
                top: 0.24,
                width: 0.0016,
                height: 0.0016,
            },
        });
        const {
            deps,
            windows,
        } = createHarness(existingPdfNote);
        deps.annotationComments.value = [
            existingPdfNote,
            newEditorNote,
        ];

        windows.handleOpenAnnotationNote(newEditorNote);
        const note = windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.draftText = 'saved new editor note';
        note.dirty = true;
        const saved = await windows.persistAllAnnotationNotes();

        expect(saved).toBe(true);
        expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalled();
        expect(deps.annotationComments.value).toEqual(expect.arrayContaining([
            expect.objectContaining({
                stableKey: 'ann:0:13275R',
                text: 'existing embedded note',
                source: 'pdf',
            }),
            expect.objectContaining({
                stableKey: 'ann:0:pdfjs_internal_editor_0',
                text: 'new editor note',
                source: 'editor',
            }),
        ]));
        expect(note.draftText).toBe('saved new editor note');
    });

    it('preserves the latest marker rect when forced save races a stale open note window', async () => {
        const originalRect = {
            left: 0.2,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        };
        const movedRect = {
            left: 0.42,
            top: 0.31,
            width: 0.0016,
            height: 0.0016,
        };
        const original = createComment({
            text: 'Open note text',
            markerRect: originalRect,
            modifiedAt: 100,
        });
        const moved = createComment({
            text: 'Open note text',
            markerRect: movedRect,
            modifiedAt: 200,
        });
        const {
            deps,
            windows,
        } = createHarness(original);

        windows.handleOpenAnnotationNote(original);
        deps.annotationComments.value = [moved];

        const saved = await windows.persistAllAnnotationNotes();

        expect(saved).toBe(true);
        expect(deps.annotationComments.value[0]?.markerRect).toEqual(movedRect);
        expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
    });

    it('does not retarget a fresh transient note window to an unrelated same-page annotation by text only', async () => {
        const transient = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'Same visible note text',
            subtype: 'FreeText',
            markerRect: {
                left: 0.58,
                top: 0.2,
                width: 0.001,
                height: 0.001,
            },
        });
        const unrelated = createComment({
            id: '4860R',
            stableKey: 'ann:0:4860R',
            annotationId: '4860R',
            uid: null,
            source: 'pdf',
            text: 'Same visible note text',
            subtype: 'Text',
            markerRect: {
                left: 0.2,
                top: 0.1,
                width: 0.001,
                height: 0.001,
            },
        });
        const {
            deps,
            windows,
        } = createHarness(transient);

        windows.handleOpenAnnotationNote(transient);
        deps.annotationComments.value = [unrelated];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_0')).not.toBeNull();
        expect(windows.findAnnotationNoteWindow('ann:0:4860R')).toBeNull();
    });

    it('keeps distinct same-source note windows separate even when their markers are nearby', () => {
        const first = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: '',
            subtype: 'FreeText',
            markerRect: {
                left: 0.5,
                top: 0.5,
                width: 0.001,
                height: 0.001,
            },
        });
        const second = createComment({
            id: 'editor:0:pdfjs_internal_editor_1',
            stableKey: 'ann:0:pdfjs_internal_editor_1',
            annotationId: null,
            uid: 'pdfjs_internal_editor_1',
            source: 'editor',
            text: '',
            subtype: 'FreeText',
            markerRect: {
                left: 0.504,
                top: 0.504,
                width: 0.001,
                height: 0.001,
            },
        });
        const { windows } = createHarness(first);

        windows.handleOpenAnnotationNote(first);
        windows.handleOpenAnnotationNote(second);

        expect(windows.annotationNoteWindows.value).toHaveLength(2);
        expect(windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_0')).not.toBeNull();
        expect(windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_1')).not.toBeNull();
        expect(windows.annotationNotePositions.value['ann:0:pdfjs_internal_editor_1']?.y).toBeGreaterThanOrEqual(
            (windows.annotationNotePositions.value['ann:0:pdfjs_internal_editor_0']?.y ?? 0) + 32,
        );
    });

    it('does not merge an open note with a persisted summary from geometry alone', () => {
        const markerRect = {
            left: 0.42,
            top: 0.24,
            width: 0.01,
            height: 0.01,
        };
        const openEditorNote = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'Unsaved note window text',
            subtype: 'FreeText',
            markerRect,
        });
        const persistedDeleteSummary = createComment({
            id: '3856R',
            stableKey: 'ann:0:3856R',
            annotationId: '3856R',
            uid: null,
            source: 'pdf',
            text: '',
            subtype: 'FreeText',
            markerRect,
        });
        const { windows } = createHarness(openEditorNote);

        windows.handleOpenAnnotationNote(openEditorNote);
        const note = windows.findAnnotationNoteWindow('ann:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.draftText = 'Dirty text that should not keep a deleted note alive';
        note.dirty = true;

        expect(windows.isSameAnnotationComment(openEditorNote, persistedDeleteSummary)).toBe(false);
    });

    it('keeps a transient note window bound by its explicit app annotation id after persistence', async () => {
        const transient = createComment({
            appAnnotationId: 'anno-point-note',
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'Placed note text',
            subtype: 'FreeText',
            markerRect: {
                left: 0.58,
                top: 0.2,
                width: 0.001,
                height: 0.001,
            },
        });
        const persisted = createComment({
            appAnnotationId: 'anno-point-note',
            id: '9999R',
            stableKey: 'ann:0:9999R',
            annotationId: '9999R',
            uid: null,
            source: 'pdf',
            text: 'Placed note text',
            subtype: 'Text',
            markerRect: {
                left: 0.5805,
                top: 0.2005,
                width: 0.001,
                height: 0.001,
            },
        });
        const {
            deps,
            windows,
        } = createHarness(transient);

        windows.handleOpenAnnotationNote(transient);
        deps.annotationComments.value = [persisted];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('anno-point-note')).not.toBeNull();
        expect(windows.annotationNoteWindows.value).toHaveLength(1);
    });

    describe('debounced persistence during an in-flight save', () => {
        const noteId = 'ann:0:note-1:0';

        function createAsyncSaveHarness() {
            const harness = createHarness(createComment({
                source: 'pdf',
                annotationName: null,
            }));
            const pending: Array<(updated: boolean) => void> = [];
            const rejections: Array<(reason: unknown) => void> = [];
            harness.deps.updateAnnotationCommentInViewer.mockImplementation(() => (
                new Promise<boolean>((resolve, reject) => {
                    pending.push(resolve);
                    rejections.push(reject);
                }) as never
            ));
            harness.windows.handleOpenAnnotationNote(harness.deps.annotationComments.value[0]!);
            return {
                ...harness,
                rejections,
                settle: async (updated: boolean) => {
                    pending[pending.length - 1]!(updated);
                    await vi.advanceTimersByTimeAsync(0);
                },
                settleRequest: async (index: number, updated: boolean) => {
                    pending[index]!(updated);
                    await vi.advanceTimersByTimeAsync(0);
                },
                typeText: async (text: string) => {
                    harness.windows.updateAnnotationNoteText(noteId, text);
                    await nextTick();
                },
            };
        }

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('submits the latest draft after a save that blocked the debounce settles', async () => {
            const {
                deps,
                windows,
                settle,
                typeText,
            } = createAsyncSaveHarness();

            await typeText('First draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'First draft');

            await typeText('Second draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);

            await settle(true);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Second draft');

            await settle(true);
            await vi.advanceTimersByTimeAsync(5_000);

            const note = windows.findAnnotationNoteWindow(noteId);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(note?.draftText).toBe('Second draft');
            expect(note?.dirty).toBe(false);
            expect(note?.saving).toBe(false);
            expect(note?.error).toBeNull();
        });

        it('coalesces repeated edits made during a save into one follow-up submission', async () => {
            const {
                deps,
                windows,
                settle,
                typeText,
            } = createAsyncSaveHarness();

            await typeText('First draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
            await typeText('Second draft');
            await typeText('Third draft');
            await typeText('Fourth draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);

            await settle(true);
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Fourth draft');

            await settle(true);
            await vi.advanceTimersByTimeAsync(5_000);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(windows.findAnnotationNoteWindow(noteId)?.dirty).toBe(false);
        });

        it('leaves a debounce that is already waiting for a newer draft alone', async () => {
            const {
                deps,
                settle,
                typeText,
            } = createAsyncSaveHarness();

            await typeText('First draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
            await typeText('Second draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            await typeText('Third draft');
            await vi.advanceTimersByTimeAsync(100);
            await settle(true);
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS - 100);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Third draft');
        });

        it('stops after a rescheduled submission fails without a newer draft', async () => {
            const {
                deps,
                windows,
                settle,
                typeText,
            } = createAsyncSaveHarness();

            await typeText('First draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
            await typeText('Second draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
            await settle(false);
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Second draft');

            await settle(false);
            await vi.advanceTimersByTimeAsync(10_000);

            const note = windows.findAnnotationNoteWindow(noteId);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(note?.dirty).toBe(true);
            expect(note?.saving).toBe(false);
            expect(note?.error).not.toBeNull();
        });

        it('surfaces a rejected save without retrying the same draft', async () => {
            const {
                deps,
                rejections,
                windows,
                typeText,
            } = createAsyncSaveHarness();

            await typeText('First draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
            expect(windows.persistAnnotationNote(noteId)).toBe(false);

            rejections[0]!(new Error('viewer unavailable'));
            await vi.advanceTimersByTimeAsync(10_000);

            const note = windows.findAnnotationNoteWindow(noteId);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);
            expect(note?.dirty).toBe(true);
            expect(note?.error).not.toBeNull();
        });

        it('does not reschedule persistence for a note removed while its save is in flight', async () => {
            const {
                deps,
                windows,
                settle,
                typeText,
            } = createAsyncSaveHarness();

            await typeText('First draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
            await typeText('Second draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            windows.removeAnnotationNoteWindow(noteId);
            await settle(true);

            expect(vi.getTimerCount()).toBe(0);

            await vi.advanceTimersByTimeAsync(10_000);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);
            expect(windows.findAnnotationNoteWindow(noteId)).toBeNull();
        });

        it('does not reschedule persistence for notes closed while a save is in flight', async () => {
            const {
                deps,
                windows,
                settle,
                typeText,
            } = createAsyncSaveHarness();

            await typeText('First draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
            await typeText('Second draft');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            await expect(windows.closeAllAnnotationNotes({saveIfDirty: false})).resolves.toBe(true);
            await settle(true);
            await vi.advanceTimersByTimeAsync(10_000);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);
            expect(windows.annotationNoteWindows.value).toHaveLength(0);
        });

        it('keeps a replaced save from stealing the retry owed to a reopened window', async () => {
            const {
                deps,
                windows,
                settleRequest,
                typeText,
            } = createAsyncSaveHarness();

            await typeText('Draft A');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Draft A');

            // The projection drops the note and hands it straight back, so the
            // same annotation id is now a different window while the first
            // request is still in flight.
            windows.removeAnnotationNoteWindow(noteId);
            windows.handleOpenAnnotationNote(deps.annotationComments.value[0]!);
            await nextTick();

            await typeText('Draft B');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Draft B');

            await typeText('Draft C');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);

            await settleRequest(0, true);
            await vi.advanceTimersByTimeAsync(10_000);

            const reopened = windows.findAnnotationNoteWindow(noteId);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(reopened?.draftText).toBe('Draft C');
            expect(reopened?.dirty).toBe(true);
            expect(reopened?.saving).toBe(true);

            await settleRequest(1, true);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(3);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Draft C');

            await settleRequest(2, true);
            await vi.advanceTimersByTimeAsync(10_000);

            const settled = windows.findAnnotationNoteWindow(noteId);
            const draftCSubmissions = deps.updateAnnotationCommentInViewer.mock.calls
                .filter(call => call[1] === 'Draft C');
            expect(draftCSubmissions).toHaveLength(1);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(3);
            expect(settled?.dirty).toBe(false);
            expect(settled?.saving).toBe(false);
            expect(settled?.error).toBeNull();
        });
    });

    describe('closes that outlive their own save', () => {
        const noteId = 'ann:0:note-1:0';

        function createClosingHarness() {
            const harness = createHarness(createComment({
                source: 'pdf',
                annotationName: null,
            }));
            const pending: Array<(updated: boolean) => void> = [];
            harness.deps.updateAnnotationCommentInViewer.mockImplementation(() => (
                new Promise<boolean>((resolve) => {
                    pending.push(resolve);
                }) as never
            ));
            harness.windows.handleOpenAnnotationNote(harness.deps.annotationComments.value[0]!);
            return {
                ...harness,
                settleRequest: async (index: number, updated: boolean) => {
                    pending[index]!(updated);
                    await vi.advanceTimersByTimeAsync(0);
                },
                reopenUnderSameId: async () => {
                    harness.windows.removeAnnotationNoteWindow(noteId);
                    harness.windows.handleOpenAnnotationNote(harness.deps.annotationComments.value[0]!);
                    await nextTick();
                },
                typeText: async (text: string) => {
                    harness.windows.updateAnnotationNoteText(noteId, text);
                    await nextTick();
                },
            };
        }

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('keeps a note reopened under the same id while a single close drains the old save', async () => {
            const {
                deps,
                reopenUnderSameId,
                settleRequest,
                typeText,
                windows,
            } = createClosingHarness();

            await typeText('Draft A');
            const closing = windows.closeAnnotationNote(noteId);
            await nextTick();

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Draft A');

            await reopenUnderSameId();
            expect(windows.findAnnotationNoteWindow(noteId)).not.toBeNull();

            await settleRequest(0, true);
            await closing;
            await vi.advanceTimersByTimeAsync(10_000);

            const reopened = windows.findAnnotationNoteWindow(noteId);
            expect(reopened).not.toBeNull();
            expect(reopened?.draftText).toBe('Initial note');
            expect(windows.annotationNoteWindows.value).toHaveLength(1);
        });

        it('keeps a note reopened under the same id while a close-all drains the old saves', async () => {
            const {
                deps,
                reopenUnderSameId,
                settleRequest,
                typeText,
                windows,
            } = createClosingHarness();

            await typeText('Draft A');
            const closing = windows.closeAllAnnotationNotes();
            await nextTick();

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);

            await reopenUnderSameId();

            await settleRequest(0, true);
            await expect(closing).resolves.toBe(true);
            await vi.advanceTimersByTimeAsync(10_000);

            const reopened = windows.findAnnotationNoteWindow(noteId);
            expect(reopened).not.toBeNull();
            expect(reopened?.draftText).toBe('Initial note');
            expect(windows.annotationNoteWindows.value).toHaveLength(1);
        });

        it('keeps a note opened while a close-all was still draining its saves', async () => {
            const otherId = 'ann:1:note-2:0';
            const {
                deps,
                settleRequest,
                typeText,
                windows,
            } = createClosingHarness();

            await typeText('Draft A');
            const closing = windows.closeAllAnnotationNotes();
            await nextTick();

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(1);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(noteId, 'Draft A');

            // The projection opens an unrelated note while the close-all is
            // still waiting on the first save. The user never asked for this
            // one to close.
            const otherComment = createComment({
                id: 'note-2',
                stableKey: otherId,
                pageIndex: 1,
                pageNumber: 2,
                annotationId: 'ann-2',
                source: 'pdf',
                annotationName: null,
                text: 'Other note',
            });
            deps.annotationComments.value = [
                deps.annotationComments.value[0]!,
                otherComment,
            ];
            windows.handleOpenAnnotationNote(otherComment);
            await nextTick();
            windows.updateAnnotationNoteText(otherId, 'Typed during the drain');
            await nextTick();

            await settleRequest(0, true);
            await expect(closing).resolves.toBe(true);

            const survivor = windows.findAnnotationNoteWindow(otherId);
            expect(windows.findAnnotationNoteWindow(noteId)).toBeNull();
            expect(survivor).not.toBeNull();
            expect(survivor?.draftText).toBe('Typed during the drain');
            expect(windows.annotationNoteWindows.value).toHaveLength(1);

            // Its debounce survived the close-all as well, so the draft the
            // user typed mid-drain still reaches the viewer.
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledTimes(2);
            expect(deps.updateAnnotationCommentInViewer).toHaveBeenLastCalledWith(otherId, 'Typed during the drain');

            await settleRequest(1, true);

            expect(windows.findAnnotationNoteWindow(otherId)?.dirty).toBe(false);
        });

        it('still closes the windows a close-all owned when one of them is reopened mid-flight', async () => {
            const otherId = 'ann:1:note-2:0';
            const {
                deps,
                reopenUnderSameId,
                settleRequest,
                typeText,
                windows,
            } = createClosingHarness();
            const otherComment = createComment({
                id: 'note-2',
                stableKey: otherId,
                pageIndex: 1,
                pageNumber: 2,
                annotationId: 'ann-2',
                source: 'pdf',
                annotationName: null,
                text: 'Other note',
            });
            deps.annotationComments.value = [
                deps.annotationComments.value[0]!,
                otherComment,
            ];
            windows.handleOpenAnnotationNote(otherComment);
            await nextTick();

            await typeText('Draft A');
            const closing = windows.closeAllAnnotationNotes();
            await nextTick();

            await reopenUnderSameId();

            await settleRequest(0, true);
            await expect(closing).resolves.toBe(true);
            await vi.advanceTimersByTimeAsync(10_000);

            expect(windows.findAnnotationNoteWindow(otherId)).toBeNull();
            expect(windows.findAnnotationNoteWindow(noteId)).not.toBeNull();
        });
    });

    describe('teardown of the owning effect scope', () => {
        const noteId = 'ann:0:note-1:0';

        function createScopedAsyncSaveHarness() {
            const scope = effectScope();
            const harness = scope.run(() => createHarness(createComment({
                source: 'pdf',
                annotationName: null,
            })))!;
            const pending: Array<(updated: boolean) => void> = [];
            const rejections: Array<(reason: unknown) => void> = [];
            harness.deps.updateAnnotationCommentInViewer.mockImplementation(() => (
                new Promise<boolean>((resolve, reject) => {
                    pending.push(resolve);
                    rejections.push(reject);
                }) as never
            ));
            harness.windows.handleOpenAnnotationNote(harness.deps.annotationComments.value[0]!);
            return {
                ...harness,
                scope,
                submittedTexts: () => harness.deps.updateAnnotationCommentInViewer.mock.calls
                    .map(call => call[1]),
                settleRequest: async (index: number, updated: boolean) => {
                    pending[index]!(updated);
                    await vi.advanceTimersByTimeAsync(0);
                },
                rejectRequest: async (index: number, reason: unknown) => {
                    rejections[index]!(reason);
                    await vi.advanceTimersByTimeAsync(0);
                },
                typeText: async (text: string) => {
                    harness.windows.updateAnnotationNoteText(noteId, text);
                    await nextTick();
                },
            };
        }

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('drops a deferred draft when the scope stops before the in-flight save settles', async () => {
            const {
                scope,
                settleRequest,
                submittedTexts,
                typeText,
                windows,
            } = createScopedAsyncSaveHarness();

            await typeText('Draft A');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(submittedTexts()).toEqual(['Draft A']);

            await typeText('Draft B');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(submittedTexts()).toEqual(['Draft A']);

            scope.stop();

            expect(vi.getTimerCount()).toBe(0);

            await settleRequest(0, true);
            await vi.advanceTimersByTimeAsync(10_000);

            expect(submittedTexts()).toEqual(['Draft A']);
            expect(vi.getTimerCount()).toBe(0);
            expect(windows.annotationNoteWindows.value).toHaveLength(0);
            expect(windows.findAnnotationNoteWindow(noteId)).toBeNull();
            expect(windows.isAnyAnnotationNoteSaving.value).toBe(false);
        });

        it('cancels a debounce that has not fired yet when the scope stops', async () => {
            const {
                deps,
                scope,
                typeText,
                windows,
            } = createScopedAsyncSaveHarness();

            await typeText('Draft A');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS - 1);

            expect(vi.getTimerCount()).toBe(1);

            scope.stop();

            expect(vi.getTimerCount()).toBe(0);

            await vi.advanceTimersByTimeAsync(10_000);

            expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            expect(windows.annotationNoteWindows.value).toHaveLength(0);
        });

        it('lets a save rejected after the scope stops fail without retrying', async () => {
            const {
                rejectRequest,
                scope,
                submittedTexts,
                typeText,
                windows,
            } = createScopedAsyncSaveHarness();

            await typeText('Draft A');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
            await typeText('Draft B');
            await vi.advanceTimersByTimeAsync(ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);

            expect(submittedTexts()).toEqual(['Draft A']);

            scope.stop();

            await rejectRequest(0, new Error('viewer unavailable'));
            await vi.advanceTimersByTimeAsync(10_000);

            expect(submittedTexts()).toEqual(['Draft A']);
            expect(vi.getTimerCount()).toBe(0);
            expect(windows.annotationNoteWindows.value).toHaveLength(0);
        });

        it('refuses to arm new work through the public surface after the scope stops', async () => {
            const {
                deps,
                scope,
                typeText,
                windows,
            } = createScopedAsyncSaveHarness();

            scope.stop();

            windows.handleOpenAnnotationNote(deps.annotationComments.value[0]!);
            await nextTick();

            expect(windows.annotationNoteWindows.value).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);

            await typeText('Draft after teardown');
            expect(windows.persistAnnotationNote(noteId)).toBe(true);
            await expect(windows.persistAllAnnotationNotes()).resolves.toBe(true);
            await vi.advanceTimersByTimeAsync(10_000);

            expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('ignores a comment projection update delivered after the scope stops', async () => {
            const {
                deps,
                scope,
                windows,
            } = createScopedAsyncSaveHarness();

            scope.stop();

            deps.annotationComments.value = [createComment({
                source: 'pdf',
                annotationName: null,
                text: 'Rewritten by a late projection',
            })];
            await nextTick();
            await vi.advanceTimersByTimeAsync(10_000);

            expect(windows.annotationNoteWindows.value).toHaveLength(0);
            expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('leaves a note retained past teardown untouched when its save fulfils', async () => {
            const {
                scope,
                settleRequest,
                typeText,
                windows,
            } = createScopedAsyncSaveHarness();

            await typeText('Draft A');
            const retained = windows.findAnnotationNoteWindow(noteId);
            expect(retained).not.toBeNull();
            if (!retained) {
                throw new Error(`Expected an annotation note window for ${noteId}`);
            }
            const saving = windows.persistAnnotationNote(noteId);
            expect(saving).toBeInstanceOf(Promise);
            expect(retained.saving).toBe(true);
            expect(retained.dirty).toBe(true);

            scope.stop();

            await settleRequest(0, true);
            await expect(saving).resolves.toBe(true);
            await vi.advanceTimersByTimeAsync(10_000);

            // The record retired with a save in flight, and that is exactly what
            // the retained view model keeps reporting. A success that landed
            // after teardown belongs to no window and may not mark the draft
            // saved, queue an embedded rewrite, or clear the in-flight marker.
            expect(retained.dirty).toBe(true);
            expect(retained.error).toBeNull();
            expect(retained.pendingEmbeddedSave).toBe(false);
            expect(retained.saving).toBe(true);
            expect(windows.isAnyAnnotationNoteSaving.value).toBe(false);
            expect(windows.annotationNoteWindows.value).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('leaves a note retained past teardown untouched when its save refuses the update', async () => {
            const {
                scope,
                settleRequest,
                typeText,
                windows,
            } = createScopedAsyncSaveHarness();

            await typeText('Draft A');
            const retained = windows.findAnnotationNoteWindow(noteId);
            expect(retained).not.toBeNull();
            if (!retained) {
                throw new Error(`Expected an annotation note window for ${noteId}`);
            }
            const saving = windows.persistAnnotationNote(noteId);
            expect(saving).toBeInstanceOf(Promise);

            scope.stop();

            await settleRequest(0, false);
            await expect(saving).resolves.toBe(true);
            await vi.advanceTimersByTimeAsync(10_000);

            // A refusal is the settlement that writes the most: an error string
            // and, for a PDF-backed note, a queued embedded rewrite. Arriving
            // after teardown, it may write neither.
            expect(retained.pendingEmbeddedSave).toBe(false);
            expect(retained.error).toBeNull();
            expect(retained.dirty).toBe(true);
            expect(retained.saving).toBe(true);
            expect(windows.isAnyAnnotationNoteSaving.value).toBe(false);
            expect(windows.annotationNoteWindows.value).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('leaves a note retained past teardown untouched when its save rejects', async () => {
            const {
                rejectRequest,
                scope,
                typeText,
                windows,
            } = createScopedAsyncSaveHarness();

            await typeText('Draft A');
            const retained = windows.findAnnotationNoteWindow(noteId);
            expect(retained).not.toBeNull();
            if (!retained) {
                throw new Error(`Expected an annotation note window for ${noteId}`);
            }
            const saving = windows.persistAnnotationNote(noteId);
            expect(saving).toBeInstanceOf(Promise);

            scope.stop();

            await rejectRequest(0, new Error('viewer unavailable'));
            await expect(saving).resolves.toBe(true);
            await vi.advanceTimersByTimeAsync(10_000);

            expect(retained.error).toBeNull();
            expect(retained.dirty).toBe(true);
            expect(retained.saving).toBe(true);
            expect(windows.isAnyAnnotationNoteSaving.value).toBe(false);
            expect(windows.annotationNoteWindows.value).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('tolerates a scope stop after every note was already closed', async () => {
            const {
                deps,
                scope,
                typeText,
                windows,
            } = createScopedAsyncSaveHarness();

            await typeText('Draft A');
            await expect(windows.closeAllAnnotationNotes({saveIfDirty: false})).resolves.toBe(true);

            expect(vi.getTimerCount()).toBe(0);

            scope.stop();
            scope.stop();

            await vi.advanceTimersByTimeAsync(10_000);

            expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
            expect(windows.annotationNoteWindows.value).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});
