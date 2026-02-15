import {
    ref,
    shallowRef,
    computed,
    watch,
    type Ref,
} from 'vue';
import { useDebounceFn } from '@vueuse/core';
import { delay } from 'es-toolkit/promise';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { ANNOTATION_NOTE_SAVE_DEBOUNCE_MS } from '@app/constants/timeouts';
import {
    annotationCommentsMatch,
    selectPreferredAnnotationComment,
} from '@app/composables/pdf/annotationNoteWindowHelpers';
import { runGuardedTask } from '@app/utils/async-guard';

export {
    annotationCommentsMatch,
    annotationCommentEditScore,
    selectPreferredAnnotationComment,
} from '@app/composables/pdf/annotationNoteWindowHelpers';

export interface IAnnotationNotePosition {
    x: number;
    y: number;
    width?: number;
    height?: number;
}

export interface IAnnotationNoteWindowState {
    comment: IAnnotationCommentSummary;
    text: string;
    lastSavedText: string;
    saving: boolean;
    error: string | null;
    order: number;
    saveMode: 'auto' | 'embedded';
}

export interface IAnnotationNoteWindowDeps {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    markAnnotationDirty: () => void;
    updateAnnotationCommentInViewer: (
        comment: IAnnotationCommentSummary,
        text: string,
    ) => boolean;
    updateEmbeddedAnnotationByRef: (
        comment: IAnnotationCommentSummary,
        text: string,
    ) => Promise<Uint8Array | false>;
    serializeCurrentPdfForEmbeddedFallback: () => Promise<boolean>;
    loadPdfFromData: (
        data: Uint8Array,
        options: {
            pushHistory: boolean;
            persistWorkingCopy: boolean;
        },
    ) => Promise<void>;
    workingCopyPath: Ref<string | null>;
    currentPage: Ref<number>;
    waitForPdfReload: (page: number) => Promise<void>;
}

export const useAnnotationNoteWindows = (deps: IAnnotationNoteWindowDeps) => {
    const { t } = useTypedI18n();

    const {
        annotationComments,
        markAnnotationDirty,
        updateAnnotationCommentInViewer,
        updateEmbeddedAnnotationByRef,
        serializeCurrentPdfForEmbeddedFallback,
        loadPdfFromData,
        workingCopyPath,
        currentPage,
        waitForPdfReload,
    } = deps;

    const annotationNoteWindows = ref<IAnnotationNoteWindowState[]>([]);
    const annotationNotePositions = shallowRef<
        Record<string, IAnnotationNotePosition>
    >({});
    const annotationNoteDebouncers = new Map<
        string,
        ReturnType<typeof useDebounceFn>
    >();
    let annotationNoteOrderCounter = 0;

    const sortedAnnotationNoteWindows = computed(() =>
        [...annotationNoteWindows.value].sort(
            (left, right) => left.order - right.order,
        ),
    );

    const isAnyAnnotationNoteSaving = computed(() =>
        annotationNoteWindows.value.some((note) => note.saving),
    );

    function findAnnotationNoteWindowIndex(stableKey: string) {
        return annotationNoteWindows.value.findIndex(
            (note) => note.comment.stableKey === stableKey,
        );
    }

    function findAnnotationNoteWindow(stableKey: string) {
        const index = findAnnotationNoteWindowIndex(stableKey);
        if (index === -1) {
            return null;
        }
        return annotationNoteWindows.value[index] ?? null;
    }

    function bringAnnotationNoteToFront(stableKey: string) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }
        annotationNoteOrderCounter += 1;
        note.order = annotationNoteOrderCounter;
    }

    function ensureAnnotationNoteDefaultPosition(stableKey: string) {
        if (annotationNotePositions.value[stableKey]) {
            return;
        }
        const noteCount = annotationNoteWindows.value.length;
        const lane = Math.max(0, noteCount - 1) % 5;
        annotationNotePositions.value = {
            ...annotationNotePositions.value,
            [stableKey]: {
                x: 14 + lane * 20,
                y: 72 + lane * 14,
            },
        };
    }

    function findMatchingAnnotationComment(comment: IAnnotationCommentSummary) {
        return annotationComments.value.find((candidate) =>
            annotationCommentsMatch(candidate, comment),
        );
    }

    function isSameAnnotationComment(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        return annotationCommentsMatch(left, right);
    }

    function upsertAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
        const key = comment.stableKey;
        const existing = findAnnotationNoteWindow(key);
        if (existing) {
            const hasUnsavedLocalChanges = existing.text !== existing.lastSavedText;
            existing.comment = selectPreferredAnnotationComment(
                existing.comment,
                comment,
            );
            existing.error = null;
            if (!hasUnsavedLocalChanges) {
                const nextText = comment.text || '';
                existing.text = nextText;
                existing.lastSavedText = nextText;
            }
            bringAnnotationNoteToFront(key);
            return;
        }

        annotationNoteOrderCounter += 1;
        const initialText = comment.text || '';
        annotationNoteWindows.value = [
            ...annotationNoteWindows.value,
            {
                comment,
                text: initialText,
                lastSavedText: initialText,
                saving: false,
                error: null,
                order: annotationNoteOrderCounter,
                saveMode: 'auto',
            },
        ];
        ensureAnnotationNoteDefaultPosition(key);
    }

    function removeAnnotationNoteWindow(stableKey: string) {
        const before = annotationNoteWindows.value.length;
        annotationNoteWindows.value = annotationNoteWindows.value.filter(
            (note) => note.comment.stableKey !== stableKey,
        );
        if (annotationNoteWindows.value.length !== before) {
            const debounced = annotationNoteDebouncers.get(stableKey) as
        | ({ cancel?: () => void } & (() => void))
        | undefined;
            debounced?.cancel?.();
            annotationNoteDebouncers.delete(stableKey);
        }
    }

    function setAnnotationNoteWindowError(
        stableKey: string,
        message: string | null,
    ) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }
        note.error = message;
    }

    function getAnnotationNoteDebouncedSaver(stableKey: string) {
        const existing = annotationNoteDebouncers.get(stableKey);
        if (existing) {
            return existing;
        }
        const saver = useDebounceFn(() => {
            runGuardedTask(() => persistAnnotationNote(stableKey, false), {
                scope: 'annotations',
                message: `Failed to persist annotation note for ${stableKey}`,
            });
        }, ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
        annotationNoteDebouncers.set(stableKey, saver);
        return saver;
    }

    function schedulePersistAnnotationNote(stableKey: string) {
        getAnnotationNoteDebouncedSaver(stableKey)();
    }

    function updateAnnotationNoteText(stableKey: string, text: string) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }
        note.text = text;
        note.error = null;
        if (note.text !== note.lastSavedText) {
            markAnnotationDirty();
        }
        schedulePersistAnnotationNote(stableKey);
    }

    function updateAnnotationNotePosition(
        stableKey: string,
        position: IAnnotationNotePosition,
    ) {
        annotationNotePositions.value = {
            ...annotationNotePositions.value,
            [stableKey]: {
                x: Math.round(position.x),
                y: Math.round(position.y),
                width:
          typeof position.width === 'number'
              ? Math.round(position.width)
              : undefined,
                height:
          typeof position.height === 'number'
              ? Math.round(position.height)
              : undefined,
            },
        };
    }

    async function persistAnnotationNote(stableKey: string, force = false) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return true;
        }

        const current = note.comment;
        const nextText = note.text;
        if (!force && nextText === note.lastSavedText) {
            return true;
        }

        if (!force && note.saveMode === 'embedded') {
            return true;
        }

        if (note.saving) {
            return false;
        }

        note.saving = true;
        note.error = null;
        try {
            let saved = updateAnnotationCommentInViewer(current, nextText);
            if (!saved && !force) {
                note.saveMode = 'embedded';
                return true;
            }
            if (!saved) {
                const result = await updateEmbeddedAnnotationByRef(current, nextText);
                if (result instanceof Uint8Array) {
                    const pageToRestore = currentPage.value;
                    const restorePromise = waitForPdfReload(pageToRestore);
                    await loadPdfFromData(result, {
                        pushHistory: true,
                        persistWorkingCopy: !!workingCopyPath.value,
                    });
                    await restorePromise;
                    saved = true;
                }
            }
            if (!saved && force) {
                const materialized = await serializeCurrentPdfForEmbeddedFallback();
                if (materialized) {
                    const result = await updateEmbeddedAnnotationByRef(current, nextText);
                    if (result instanceof Uint8Array) {
                        const pageToRestore = currentPage.value;
                        const restorePromise = waitForPdfReload(pageToRestore);
                        await loadPdfFromData(result, {
                            pushHistory: true,
                            persistWorkingCopy: !!workingCopyPath.value,
                        });
                        await restorePromise;
                        saved = true;
                    }
                }
            }
            if (!saved) {
                note.error = t('errors.annotation.updateNote');
                return false;
            }

            note.saveMode =
                saved && note.saveMode === 'embedded' ? 'embedded' : 'auto';

            const localUpdated: IAnnotationCommentSummary = {
                ...current,
                text: nextText,
                modifiedAt: Date.now(),
            };
            note.comment = localUpdated;
            note.text = nextText;
            note.lastSavedText = nextText;

            const latest = findMatchingAnnotationComment(current);
            if (latest && latest.text === nextText) {
                note.comment = latest;
                note.text = latest.text || '';
                note.lastSavedText = latest.text || '';
                return true;
            }
            return true;
        } finally {
            const latestNote = findAnnotationNoteWindow(stableKey);
            if (latestNote) {
                latestNote.saving = false;
                if (latestNote.text !== latestNote.lastSavedText) {
                    schedulePersistAnnotationNote(stableKey);
                }
            }
        }
    }

    async function persistAllAnnotationNotes(force = false) {
        const notes = [...annotationNoteWindows.value];
        for (const note of notes) {
            const saved = await persistAnnotationNote(note.comment.stableKey, force);
            if (!saved) {
                return false;
            }
        }
        return true;
    }

    async function closeAnnotationNote(
        stableKey: string,
        options: { saveIfDirty?: boolean } = {},
    ) {
        const saveIfDirty = options.saveIfDirty ?? true;
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }

        if (saveIfDirty) {
            if (note.saving) {
                let attempts = 0;
                while (note.saving && attempts < 20) {
                    await delay(25);
                    attempts += 1;
                }
            }
            const saved = await persistAnnotationNote(stableKey, true);
            if (!saved) {
                setAnnotationNoteWindowError(
                    stableKey,
                    t('errors.annotation.saveBeforeClose'),
                );
                return;
            }
        }

        removeAnnotationNoteWindow(stableKey);
    }

    async function closeAllAnnotationNotes(
        options: { saveIfDirty?: boolean } = {},
    ) {
        const saveIfDirty = options.saveIfDirty ?? true;
        if (saveIfDirty) {
            const saved = await persistAllAnnotationNotes(true);
            if (!saved) {
                return false;
            }
        }

        annotationNoteWindows.value.forEach((note) => {
            const debounced = annotationNoteDebouncers.get(note.comment.stableKey) as
        | ({ cancel?: () => void } & (() => void))
        | undefined;
            debounced?.cancel?.();
            annotationNoteDebouncers.delete(note.comment.stableKey);
        });
        annotationNoteWindows.value = [];
        return true;
    }

    function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
        const matched = findMatchingAnnotationComment(comment);
        if (matched) {
            upsertAnnotationNoteWindow(
                selectPreferredAnnotationComment(comment, matched),
            );
        } else {
            upsertAnnotationNoteWindow(comment);
        }
    }

    watch(annotationComments, (comments) => {
        if (annotationNoteWindows.value.length === 0) {
            return;
        }

        const byStableKey = new Map<string, IAnnotationCommentSummary>();
        const byAnnotationIdPage = new Map<string, IAnnotationCommentSummary>();
        const byUidPage = new Map<string, IAnnotationCommentSummary>();
        const byIdPageSource = new Map<string, IAnnotationCommentSummary>();

        for (const comment of comments) {
            if (comment.stableKey) {
                byStableKey.set(comment.stableKey, comment);
            }
            if (comment.annotationId) {
                byAnnotationIdPage.set(
                    `${comment.annotationId}:${comment.pageIndex}`,
                    comment,
                );
            }
            if (comment.uid) {
                byUidPage.set(`${comment.uid}:${comment.pageIndex}`, comment);
            }
            byIdPageSource.set(
                `${comment.id}:${comment.pageIndex}:${comment.source}`,
                comment,
            );
        }

        function findUpdatedComment(noteComment: IAnnotationCommentSummary) {
            if (noteComment.stableKey) {
                const match = byStableKey.get(noteComment.stableKey);
                if (match) {
                    return match;
                }
            }
            if (noteComment.annotationId) {
                const match = byAnnotationIdPage.get(
                    `${noteComment.annotationId}:${noteComment.pageIndex}`,
                );
                if (match) {
                    return match;
                }
            }
            if (noteComment.uid) {
                const match = byUidPage.get(
                    `${noteComment.uid}:${noteComment.pageIndex}`,
                );
                if (match) {
                    return match;
                }
            }
            return (
                byIdPageSource.get(
                    `${noteComment.id}:${noteComment.pageIndex}:${noteComment.source}`,
                ) ?? null
            );
        }

        annotationNoteWindows.value.forEach((note) => {
            const updated = findUpdatedComment(note.comment);
            if (!updated) {
                return;
            }
            const preferred = selectPreferredAnnotationComment(note.comment, updated);

            const savedText = note.lastSavedText.trim();
            const updatedText = updated.text.trim();
            const currentTimestamp = note.comment.modifiedAt ?? 0;
            const updatedTimestamp = updated.modifiedAt ?? 0;
            const staleEmptySync =
                !note.saving &&
        savedText.length > 0 &&
        updatedText.length === 0 &&
        updatedTimestamp <= currentTimestamp;

            if (staleEmptySync) {
                note.comment = {
                    ...preferred,
                    text: note.lastSavedText,
                    modifiedAt: currentTimestamp || updatedTimestamp || null,
                };
                return;
            }

            note.comment = preferred;
            const hasUnsavedLocalChanges = note.text !== note.lastSavedText;
            if (!note.saving && !hasUnsavedLocalChanges) {
                const nextText = updated.text || '';
                note.text = nextText;
                note.lastSavedText = nextText;
            }
        });
    });

    return {
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        isAnyAnnotationNoteSaving,
        findAnnotationNoteWindow,
        upsertAnnotationNoteWindow,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        persistAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
        findMatchingAnnotationComment,
        selectPreferredAnnotationComment,
    };
};
