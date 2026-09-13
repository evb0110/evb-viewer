import type {Ref} from 'vue';
import {tryOnScopeDispose} from '@vueuse/core';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {
    IAnnotationNotePosition,
    IAnnotationNoteWindowState,
    IAnnotationNoteWindowViewModel,
} from '@app/types/annotationNoteWindow';
import {
    isNoteEligibleComment,
    annotationIdForSummary,
    asAnnotationId,
    type IAnnotationRecoveryDraft,
    type AnnotationId,
} from '@app/modules/pdf-viewer/public';
import {ANNOTATION_NOTE_SAVE_DEBOUNCE_MS} from '@app/constants/timeouts';
import {runGuardedTask} from '@app/utils/asyncGuard';

interface IAnnotationNoteWindowRuntime {
    requiresEmbeddedSave: boolean;
    canonicalText: string;
    pageIndex: number;
    pageNumber: number;
    author: string | null;
    color: string | null;
    createdAt: number | null;
    modifiedAt: number | null;
    markerRect: IAnnotationCommentSummary['markerRect'];
    subtype: string | null;
    source: IAnnotationCommentSummary['source'];
    hasNote: boolean;
    dirty: boolean;
    saving: boolean;
    error: string | null;
    order: number;
    pendingEmbeddedSave: boolean;
    createdAtMs: number;
    saveGeneration: number;
    persistDeferredForSave: number | null;
}

const ANNOTATION_NOTE_DISAPPEARANCE_GRACE_MS = 5_000;

export interface IAnnotationNoteWindowDeps {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    markAnnotationDirty: () => void;
    updateAnnotationCommentInViewer: (
        annotationId: AnnotationId,
        text: string,
    ) => boolean | Promise<boolean>;
    isAnnotationCommentSyncReady?: () => boolean;
    getDeletedCanonicalAnnotationIds?: () => readonly string[];
}

function commandId(comment: IAnnotationCommentSummary): AnnotationId {
    return annotationIdForSummary(comment);
}

function commentsHaveSameIdentity(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    return annotationIdForSummary(left) === annotationIdForSummary(right);
}

export const useAnnotationNoteWindows = (deps: IAnnotationNoteWindowDeps) => {
    const {t} = useTypedI18n();
    const states = ref<IAnnotationNoteWindowState[]>([]);
    const runtime = reactive(new Map<AnnotationId, IAnnotationNoteWindowRuntime>());
    const timers = new Map<AnnotationId, ReturnType<typeof setTimeout>>();
    const disappearanceTimers = new Map<AnnotationId, ReturnType<typeof setTimeout>>();
    let nextOrder = 0;
    const draftGenerations = new Map<AnnotationId, number>();
    const pendingRestoredDrafts = new Map<AnnotationId, IAnnotationRecoveryDraft>();
    // Teardown fence. Once the owning scope stops, this composable owns no
    // timers, no runtime records, and no right to talk to the viewer again.
    let disposed = false;

    function stateById(annotationId: string) {
        return states.value.find(state => state.annotationId === annotationId) ?? null;
    }

    function toViewModel(state: IAnnotationNoteWindowState): IAnnotationNoteWindowViewModel | null {
        const annotationId = asAnnotationId(state.annotationId);
        const metadata = runtime.get(annotationId);
        if (!metadata) {
            return null;
        }
        return Object.defineProperties({}, {
            annotationId: {
                enumerable: true,
                get: () => state.annotationId,
            },
            draftText: {
                enumerable: true,
                get: () => state.draftText,
                set: value => { state.draftText = String(value); },
            },
            minimized: {
                enumerable: true,
                get: () => state.minimized,
                set: value => { state.minimized = Boolean(value); },
            },
            position: {
                enumerable: true,
                get: () => state.position,
                set: value => { state.position = value as IAnnotationNotePosition; },
            },
            pageIndex: {
                enumerable: true,
                get: () => metadata.pageIndex,
            },
            pageNumber: {
                enumerable: true,
                get: () => metadata.pageNumber,
            },
            author: {
                enumerable: true,
                get: () => metadata.author,
            },
            color: {
                enumerable: true,
                get: () => metadata.color,
            },
            createdAt: {
                enumerable: true,
                get: () => metadata.createdAt,
            },
            modifiedAt: {
                enumerable: true,
                get: () => metadata.modifiedAt,
            },
            markerRect: {
                enumerable: true,
                get: () => metadata.markerRect ? Object.freeze({...metadata.markerRect}) : null,
            },
            subtype: {
                enumerable: true,
                get: () => metadata.subtype,
            },
            source: {
                enumerable: true,
                get: () => metadata.source,
            },
            hasNote: {
                enumerable: true,
                get: () => metadata.hasNote,
            },
            dirty: {
                enumerable: true,
                get: () => metadata.dirty,
                set: value => { metadata.dirty = Boolean(value); },
            },
            saving: {
                enumerable: true,
                get: () => metadata.saving,
            },
            error: {
                enumerable: true,
                get: () => metadata.error,
            },
            order: {
                enumerable: true,
                get: () => metadata.order,
            },
            pendingEmbeddedSave: {
                enumerable: true,
                get: () => metadata.pendingEmbeddedSave,
            },
            isMinimized: {
                enumerable: true,
                get: () => state.minimized,
            },
            createdAtMs: {
                enumerable: true,
                get: () => metadata.createdAtMs,
                set: value => { metadata.createdAtMs = Number(value); },
            },
        }) as IAnnotationNoteWindowViewModel;
    }

    const annotationNoteWindows = computed(() => states.value.flatMap((state) => {
        const viewModel = toViewModel(state);
        return viewModel ? [viewModel] : [];
    }));
    const sortedAnnotationNoteWindows = computed(() => (
        [...annotationNoteWindows.value].sort((left, right) => left.order - right.order)
    ));
    const annotationNotePositions = computed<Record<string, IAnnotationNotePosition>>(() => Object.fromEntries(
        states.value.flatMap((state) => {
            return [[
                state.annotationId,
                state.position,
            ]];
        }),
    ));
    const isAnyAnnotationNoteSaving = computed(() => (
        [...runtime.values()].some(value => value.saving)
    ));

    function resolveId(value: string) {
        const direct = states.value.find(state => state.annotationId === value);
        if (direct) {
            return asAnnotationId(direct.annotationId);
        }
        return null;
    }

    function findAnnotationNoteWindow(value: string) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        return state ? toViewModel(state) : null;
    }

    function findMatchingAnnotationComment(comment: IAnnotationCommentSummary) {
        return deps.annotationComments.value.find(candidate => commentsHaveSameIdentity(candidate, comment)) ?? null;
    }

    function ensureDefaultPosition() {
        const lane = states.value.length % 5;
        return {
            x: 14 + lane * 32,
            y: 112 + lane * 56,
        };
    }

    function applyCommentSnapshot(metadata: IAnnotationNoteWindowRuntime, comment: IAnnotationCommentSummary) {
        metadata.canonicalText = comment.text;
        metadata.requiresEmbeddedSave = comment.source === 'pdf' || Boolean(comment.annotationId);
        metadata.pageIndex = comment.pageIndex;
        metadata.pageNumber = comment.pageNumber;
        metadata.author = comment.author ?? null;
        metadata.color = comment.color;
        metadata.createdAt = comment.createdAt ?? metadata.createdAt;
        metadata.modifiedAt = comment.modifiedAt ?? null;
        metadata.markerRect = comment.markerRect ? {...comment.markerRect} : null;
        metadata.subtype = comment.subtype ?? null;
        metadata.source = comment.source;
        metadata.hasNote = comment.hasNote === true;
    }

    function upsertAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
        if (disposed || !isNoteEligibleComment(comment)) {
            return;
        }
        const annotationId = commandId(comment);
        if (deps.getDeletedCanonicalAnnotationIds?.().includes(annotationId)) {
            return;
        }
        const existing = stateById(annotationId);
        if (existing) {
            existing.minimized = false;
            const metadata = runtime.get(annotationId);
            if (!metadata) {
                return;
            }
            metadata.error = null;
            metadata.order = ++nextOrder;
            applyCommentSnapshot(metadata, comment);
            if (!metadata.dirty) existing.draftText = comment.text;
            return;
        }
        states.value.push({
            annotationId,
            draftText: comment.text,
            minimized: false,
            position: ensureDefaultPosition(),
        });
        runtime.set(annotationId, {
            requiresEmbeddedSave: comment.source === 'pdf' || Boolean(comment.annotationId),
            canonicalText: comment.text,
            pageIndex: comment.pageIndex,
            pageNumber: comment.pageNumber,
            author: comment.author ?? null,
            color: comment.color,
            createdAt: comment.createdAt ?? null,
            modifiedAt: comment.modifiedAt ?? null,
            markerRect: comment.markerRect ? {...comment.markerRect} : null,
            subtype: comment.subtype ?? null,
            source: comment.source,
            hasNote: comment.hasNote === true,
            dirty: false,
            saving: false,
            error: null,
            order: ++nextOrder,
            pendingEmbeddedSave: false,
            createdAtMs: Date.now(),
            saveGeneration: 0,
            persistDeferredForSave: null,
        });
    }

    function bringAnnotationNoteToFront(value: string) {
        const id = resolveId(value);
        const metadata = id ? runtime.get(id) : null;
        if (metadata) metadata.order = ++nextOrder;
    }

    function minimizeAnnotationNote(value: string) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        if (state) state.minimized = true;
    }

    function restoreAnnotationNote(value: string) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        if (!state || !id) {
            return;
        }
        state.minimized = false;
        const metadata = runtime.get(id);
        if (metadata) metadata.order = ++nextOrder;
    }

    function clearTimer(id: AnnotationId) {
        const timer = timers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(id);
    }

    function clearDisappearanceTimer(id: AnnotationId) {
        const timer = disappearanceTimers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        disappearanceTimers.delete(id);
    }

    function removeIfStillMissing(id: AnnotationId) {
        const metadata = runtime.get(id);
        if (
            !metadata
            || metadata.dirty
            || deps.annotationComments.value.some(comment => (
                isNoteEligibleComment(comment) && commandId(comment) === id
            ))
        ) {
            return;
        }
        removeAnnotationNoteWindow(id);
    }

    function scheduleRemovalAfterProjectionGap(id: AnnotationId) {
        if (disposed || disappearanceTimers.has(id)) {
            return;
        }
        const metadata = runtime.get(id);
        if (!metadata) {
            return;
        }
        const remainingGraceMs = Math.max(
            0,
            ANNOTATION_NOTE_DISAPPEARANCE_GRACE_MS - (Date.now() - metadata.createdAtMs),
        );
        if (remainingGraceMs === 0) {
            removeIfStillMissing(id);
            return;
        }
        disappearanceTimers.set(id, setTimeout(() => {
            disappearanceTimers.delete(id);
            removeIfStillMissing(id);
        }, remainingGraceMs));
    }

    function schedulePersist(id: AnnotationId) {
        if (disposed) {
            return;
        }
        clearTimer(id);
        timers.set(id, setTimeout(() => {
            timers.delete(id);
            runGuardedTask(() => Promise.resolve(persistAnnotationNote(id)), {
                category: 'background-diagnostic',
                scope: 'annotations',
                message: `Failed to persist annotation note ${id}`,
            });
        }, ANNOTATION_NOTE_SAVE_DEBOUNCE_MS));
    }

    function updateAnnotationNoteText(value: string, text: string) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        const metadata = id ? runtime.get(id) : null;
        if (!id || !state || !metadata) {
            return;
        }
        state.draftText = text;
        draftGenerations.set(id, (draftGenerations.get(id) ?? 0) + 1);
        metadata.dirty = text !== metadata.canonicalText;
        metadata.error = null;
        if (metadata.dirty) deps.markAnnotationDirty();
        schedulePersist(id);
    }

    function updateAnnotationNotePosition(value: string, position: IAnnotationNotePosition) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        if (!state) {
            return;
        }
        state.position = {
            x: Math.round(position.x),
            y: Math.round(position.y),
            ...(typeof position.width === 'number' ? {width: Math.round(position.width)} : {}),
            ...(typeof position.height === 'number' ? {height: Math.round(position.height)} : {}),
        };
    }

    function captureAnnotationNoteDrafts(
        getCanonicalRevision: (annotationId: AnnotationId) => number | null,
    ): readonly IAnnotationRecoveryDraft[] {
        return states.value.flatMap((state) => {
            const id = asAnnotationId(state.annotationId);
            const metadata = runtime.get(id);
            if (!metadata || !metadata.dirty) {
                return [];
            }
            const canonicalRevision = getCanonicalRevision(id);
            if (canonicalRevision === null) {
                return [];
            }
            return [{
                annotationId: id,
                kind: 'note' as const,
                canonicalRevision,
                text: state.draftText,
                generation: draftGenerations.get(id) ?? 0,
            }];
        });
    }

    function restoreAnnotationNoteDraft(draft: IAnnotationRecoveryDraft) {
        if (draft.kind !== 'note') {
            return;
        }
        const comment = deps.annotationComments.value.find(candidate => commandId(candidate) === draft.annotationId);
        if (!comment) {
            pendingRestoredDrafts.set(draft.annotationId, draft);
            return;
        }
        upsertAnnotationNoteWindow(comment);
        const state = stateById(draft.annotationId);
        const metadata = runtime.get(draft.annotationId);
        if (!state || !metadata) {
            return;
        }
        state.draftText = draft.text;
        metadata.dirty = true;
        metadata.error = null;
        draftGenerations.set(draft.annotationId, draft.generation);
        deps.markAnnotationDirty();
    }

    function persistAnnotationNote(value: string): boolean | Promise<boolean> {
        if (disposed) {
            return true;
        }
        const id = resolveId(value) ?? asAnnotationId(value);
        if (deps.getDeletedCanonicalAnnotationIds?.().includes(id)) {
            removeAnnotationNoteWindow(id);
            return true;
        }
        const state = stateById(id);
        const metadata = runtime.get(id);
        if (!state || !metadata || !metadata.dirty) {
            return true;
        }
        if (metadata.saving) {
            // The debounce fired mid-flight. Book the retry against the save
            // that is running right now so that exact save, and nothing else,
            // hands the newer draft back to the timer. A window reopened under
            // the same id gets a fresh runtime, so the request it replaced
            // cannot reach this marker.
            metadata.persistDeferredForSave = metadata.saveGeneration;
            return false;
        }
        const saveGeneration = ++metadata.saveGeneration;
        metadata.saving = true;
        metadata.error = null;
        const submittedText = state.draftText;
        // This attempt owns exactly the window it started on: that runtime
        // record, that state object, and its own generation. Teardown, a
        // removal, or a reopen under the same id retires it, and a retired
        // attempt writes nothing — a view model handed out before the window
        // went away still reads that runtime record, so a late fulfillment must
        // not repaint it with an outcome that arrived after the window's death.
        const ownsAttempt = () => (
            !disposed
            && runtime.get(id) === metadata
            && stateById(id) === state
        );
        const applyFulfilled = (updated: boolean) => {
            if (!updated) {
                if (metadata.requiresEmbeddedSave) {
                    metadata.pendingEmbeddedSave = true;
                }
                metadata.error = t('errors.annotation.updateNote');
                return false;
            }
            if (metadata.requiresEmbeddedSave) {
                metadata.pendingEmbeddedSave = true;
            }
            metadata.canonicalText = submittedText;
            if (state.draftText === submittedText) {
                metadata.dirty = false;
                return true;
            }
            return false;
        };
        const applyRejected = () => {
            metadata.error = t('errors.annotation.updateNote');
            return false;
        };
        const conclude = (apply: () => boolean) => {
            if (!ownsAttempt()) {
                // The request closed its own books and stops there. Reporting
                // what the viewer said would be a claim about a window that no
                // longer exists, so answer the way this function answers for
                // any id it does not own: nothing left to persist.
                return true;
            }
            metadata.saving = false;
            const result = apply();
            // Only the save the deferral was booked against may consume it.
            if (metadata.persistDeferredForSave !== saveGeneration) {
                return result;
            }
            metadata.persistDeferredForSave = null;
            // Resubmitting the same text would only repeat the same outcome, so
            // a newer draft is what earns another attempt. A timer already
            // waiting will carry that draft on its own.
            if (state.draftText === submittedText || timers.has(id)) {
                return result;
            }
            schedulePersist(id);
            return result;
        };
        try {
            const updated = deps.updateAnnotationCommentInViewer(id, submittedText);
            if (updated instanceof Promise) {
                return updated.then(
                    settled => conclude(() => applyFulfilled(settled)),
                    () => conclude(applyRejected),
                );
            }
            return conclude(() => applyFulfilled(updated));
        } catch {
            return conclude(applyRejected);
        }
    }

    async function persistAllAnnotationNotes() {
        const results = await Promise.all(
            states.value.map(state => Promise.resolve(
                persistAnnotationNote(state.annotationId),
            )),
        );
        return results.every(Boolean);
    }

    function deleteAnnotationNoteWindow(id: AnnotationId) {
        states.value = states.value.filter(state => state.annotationId !== id);
        runtime.delete(id);
        draftGenerations.delete(id);
        clearTimer(id);
        clearDisappearanceTimer(id);
    }

    function removeAnnotationNoteWindow(value: string) {
        const id = resolveId(value);
        if (!id) {
            return;
        }
        deleteAnnotationNoteWindow(id);
    }

    // A close that has to await a save owns the window it started on, not
    // whatever answers to that id once the save settles. Reopening a note under
    // the same id builds a fresh state object and a fresh runtime record, so
    // holding both instances is what tells the two windows apart.
    function captureOwnedAnnotationNoteWindow(id: AnnotationId | null) {
        return {
            id,
            state: id ? stateById(id) : null,
            metadata: id ? runtime.get(id) ?? null : null,
        };
    }

    function removeOwnedAnnotationNoteWindow(
        owned: ReturnType<typeof captureOwnedAnnotationNoteWindow>,
    ) {
        if (!owned.id || !owned.state || !owned.metadata) {
            return;
        }
        // Someone else already retired that window, or the user reopened the
        // note while the save was in flight. Either way this continuation has
        // nothing left to close.
        if (stateById(owned.id) !== owned.state || runtime.get(owned.id) !== owned.metadata) {
            return;
        }
        deleteAnnotationNoteWindow(owned.id);
    }

    async function closeAnnotationNote(value: string, options: {saveIfDirty?: boolean} = {}) {
        const owned = captureOwnedAnnotationNoteWindow(resolveId(value));
        if (options.saveIfDirty !== false && !await persistAnnotationNote(value)) {
            return;
        }
        removeOwnedAnnotationNoteWindow(owned);
    }

    function clearAllTimers() {
        timers.forEach(timer => clearTimeout(timer));
        disappearanceTimers.forEach(timer => clearTimeout(timer));
        timers.clear();
        disappearanceTimers.clear();
    }

    async function closeAllAnnotationNotes(options: {saveIfDirty?: boolean} = {}) {
        const owned = states.value.map(state => captureOwnedAnnotationNoteWindow(
            asAnnotationId(state.annotationId),
        ));
        if (options.saveIfDirty !== false && !await persistAllAnnotationNotes()) {
            return false;
        }
        // Closing everything means everything that was open when the user asked,
        // not a note the projection opened while the saves were draining.
        owned.forEach(entry => removeOwnedAnnotationNoteWindow(entry));
        return true;
    }

    function setAnnotationNoteWindowError(value: string, message: string | null) {
        const id = resolveId(value);
        const metadata = id ? runtime.get(id) : null;
        if (metadata) metadata.error = message;
    }

    const stopAnnotationCommentsWatch = watch(deps.annotationComments, (comments) => {
        const deletedIds = new Set(deps.getDeletedCanonicalAnnotationIds?.() ?? []);
        states.value.filter(state => deletedIds.has(state.annotationId)).forEach(state => {
            deleteAnnotationNoteWindow(asAnnotationId(state.annotationId));
        });
        if (!deps.isAnnotationCommentSyncReady?.() && deps.isAnnotationCommentSyncReady) {
            return;
        }
        const ids = new Set(comments.filter(isNoteEligibleComment).map(commandId));
        comments.filter(isNoteEligibleComment).forEach((comment) => {
            const id = commandId(comment);
            const metadata = runtime.get(id);
            if (!metadata) {
                return;
            }
            applyCommentSnapshot(metadata, comment);
            const state = stateById(id);
            if (state) {
                if (!metadata.dirty) {
                    state.draftText = comment.text;
                }
                metadata.dirty = state.draftText !== comment.text;
            }
            clearDisappearanceTimer(id);
        });
        states.value.filter(state => !ids.has(asAnnotationId(state.annotationId))).forEach((state) => {
            const metadata = runtime.get(asAnnotationId(state.annotationId));
            if (metadata && !metadata.dirty) {
                scheduleRemovalAfterProjectionGap(asAnnotationId(state.annotationId));
            }
        });
        pendingRestoredDrafts.forEach((draft, id) => {
            if (ids.has(id)) {
                pendingRestoredDrafts.delete(id);
                restoreAnnotationNoteDraft(draft);
            }
        });
    });

    // Idempotent, and safe after an explicit closeAllAnnotationNotes: the maps
    // and the state list are simply already empty by then. Stopping the watcher
    // here rather than leaning on the scope keeps teardown self-contained, so
    // the projection cannot revive a window this composable no longer owns.
    function disposeAnnotationNoteWindows() {
        // Raise the fence first so anything the teardown itself unwinds, and
        // anything already queued behind it, sees a retired composable.
        disposed = true;
        clearAllTimers();
        runtime.clear();
        states.value = [];
        pendingRestoredDrafts.clear();
        stopAnnotationCommentsWatch();
    }

    tryOnScopeDispose(disposeAnnotationNoteWindows);

    return {
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        isAnyAnnotationNoteSaving,
        findAnnotationNoteWindow,
        upsertAnnotationNoteWindow,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        updateAnnotationNoteText,
        captureAnnotationNoteDrafts,
        restoreAnnotationNoteDraft,
        updateAnnotationNotePosition,
        persistAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote: upsertAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment: commentsHaveSameIdentity,
        findMatchingAnnotationComment,
        selectPreferredAnnotationComment: (left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) => (
            commentsHaveSameIdentity(left, right) ? right : left
        ),
    };
};
