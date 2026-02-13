import type {
    Ref,
    ShallowRef,
} from 'vue';
import { useDebounceFn } from '@vueuse/core';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { IPdfjsEditor } from '@app/composables/pdf/pdfAnnotationUtils';
import {
    getCommentText,
    hasEditorCommentPayload,
    parsePdfDateTimestamp,
    toCssColor,
    toMarkerRectFromPdfRect,
    toMarkerRectFromEditor,
    getAnnotationCommentText,
    getAnnotationAuthor,
    annotationKindLabelFromSubtype,
    isPopupSubtype,
    detectEditorSubtype,
    isTextMarkupSubtype,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationMarkupSubtype } from '@app/composables/pdf/useAnnotationMarkupSubtype';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TMarkupSubtypeComposable = ReturnType<typeof useAnnotationMarkupSubtype>;

interface IUseAnnotationCommentSyncOptions {
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    authorName: Ref<string | null | undefined>;
    identity: TIdentity;
    markupSubtype: TMarkupSubtypeComposable;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    syncInlineCommentIndicators: () => void;
}

export function useAnnotationCommentSync(options: IUseAnnotationCommentSyncOptions) {
    const { t } = useI18n();

    const {
        pdfDocument,
        numPages,
        annotationUiManager,
        authorName,
        identity,
        markupSubtype,
        annotationCommentsCache,
        activeCommentStableKey,
        emitAnnotationComments,
        syncInlineCommentIndicators,
    } = options;

    let annotationCommentsSyncToken = 0;
    const pendingCommentEditorKeys = new Set<string>();
    const trackedCreatedEditors = new WeakSet<object>();

    function toEditorSummary(
        editor: IPdfjsEditor,
        pageIndex: number,
        textOverride?: string,
        sortIndex: number | null = null,
    ): IAnnotationCommentSummary {
        let data: ReturnType<NonNullable<IPdfjsEditor['getData']>> = {};
        try {
            data = editor.getData?.() ?? {};
        } catch {
            data = {};
        }
        const text = typeof textOverride === 'string'
            ? textOverride
            : getCommentText(editor).trim();
        const resolvedSubtype = markupSubtype.resolveEditorMarkupSubtypeOverride(editor, pageIndex) ?? detectEditorSubtype(editor);
        const uid = editor.uid ?? null;
        const annotationId = editor.annotationElementId ?? null;
        if (annotationId && resolvedSubtype && resolvedSubtype !== 'Highlight' && resolvedSubtype !== 'Ink' && resolvedSubtype !== 'Typewriter') {
            const normalized = resolvedSubtype.toLowerCase();
            if (normalized === 'underline' || normalized === 'strikeout' || normalized === 'squiggly') {
                markupSubtype.markupSubtypeOverrides.set(annotationId, resolvedSubtype as TMarkupSubtype);
            }
        }
        const id = identity.getEditorIdentity(editor, pageIndex);
        const pendingKey = identity.getEditorPendingKey(editor, pageIndex);
        const hasNote = hasEditorCommentPayload(editor) || pendingCommentEditorKeys.has(pendingKey);

        return {
            id,
            stableKey: identity.computeSummaryStableKey({
                id,
                pageIndex,
                source: 'editor',
                uid,
                annotationId,
            }),
            sortIndex,
            pageIndex,
            pageNumber: pageIndex + 1,
            text,
            kindLabel: annotationKindLabelFromSubtype(resolvedSubtype, t),
            subtype: resolvedSubtype,
            author: authorName.value?.trim() || null,
            modifiedAt: parsePdfDateTimestamp(data.modificationDate) ?? parsePdfDateTimestamp(data.creationDate),
            color: toCssColor(data.color ?? editor.color, data.opacity ?? editor.opacity ?? 1),
            uid,
            annotationId,
            source: 'editor',
            hasNote,
            markerRect: toMarkerRectFromEditor(editor),
        };
    }

    async function syncAnnotationComments() {
        const doc = pdfDocument.value;
        if (!doc || numPages.value <= 0) {
            identity.clearMemory();
            markupSubtype.clearOverrides();
            annotationCommentsCache.value = [];
            emitAnnotationComments([]);
            syncInlineCommentIndicators();
            return;
        }

        const localToken = ++annotationCommentsSyncToken;
        const commentsByKey = new Map<string, IAnnotationCommentSummary>();
        let sourceOrder = 0;

        const uiManager = annotationUiManager.value;
        const managerWithDeletedLookup = uiManager as (AnnotationEditorUIManager & { isDeletedAnnotationElement?: (annotationElementId: string) => boolean }) | null;
        if (uiManager) {
            for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
                for (const editor of uiManager.getEditors(pageIndex)) {
                    const normalizedEditor = editor as IPdfjsEditor;
                    const text = getCommentText(normalizedEditor).trim();

                    const summary = toEditorSummary(normalizedEditor, pageIndex, text, sourceOrder);
                    sourceOrder += 1;
                    const hydrated = identity.hydrateSummaryFromMemory(summary);
                    commentsByKey.set(identity.toSummaryKey(hydrated), hydrated);
                }
            }
        }

        for (let pageNumber = 1; pageNumber <= numPages.value; pageNumber += 1) {
            if (localToken !== annotationCommentsSyncToken) {
                return;
            }

            let pageAnnotations: Array<{
                id?: string;
                pageIndex?: number;
                rect?: number[];
                contents?: string;
                contentsObj?: { str?: string | null };
                richText?: { str?: string | null };
                title?: string;
                titleObj?: { str?: string | null };
                color?: number[] | string | null;
                opacity?: number;
                modificationDate?: string | null;
                creationDate?: string | null;
                subtype?: string;
                popupRef?: string | null;
            }> = [];
            let pageView: number[] | null = null;

            try {
                const page = await doc.getPage(pageNumber);
                pageAnnotations = await page.getAnnotations();
                pageView = ((page as { view?: number[] }).view ?? null);
            } catch {
                continue;
            }

            const popupById = new Map<string, (typeof pageAnnotations)[number]>();
            pageAnnotations.forEach((annotation) => {
                if (annotation.id && managerWithDeletedLookup?.isDeletedAnnotationElement?.(annotation.id)) {
                    return;
                }
                if (!isPopupSubtype(annotation.subtype)) {
                    return;
                }
                if (!annotation.id) {
                    return;
                }
                popupById.set(annotation.id, annotation);
            });

            pageAnnotations.forEach((annotation, annotationIndex) => {
                if (annotation.id && managerWithDeletedLookup?.isDeletedAnnotationElement?.(annotation.id)) {
                    return;
                }
                if (isPopupSubtype(annotation.subtype)) {
                    return;
                }

                const popupAnnotation = annotation.popupRef
                    ? popupById.get(annotation.popupRef) ?? null
                    : null;
                const annotationText = getAnnotationCommentText(annotation);
                const popupText = popupAnnotation ? getAnnotationCommentText(popupAnnotation) : '';
                const text = annotationText || popupText;
                const subtype = annotation.subtype ?? null;
                const id = annotation.id ?? `pdf-${pageNumber}-${annotationIndex}`;
                const annotationId = annotation.id ?? null;
                const hasLinkedPopup = Boolean(annotation.popupRef) || Boolean(popupAnnotation);
                const summaryKey = identity.computeSummaryStableKey({
                    id,
                    pageIndex: pageNumber - 1,
                    source: 'pdf',
                    uid: null,
                    annotationId,
                });

                const summary: IAnnotationCommentSummary = {
                    id,
                    stableKey: summaryKey,
                    sortIndex: sourceOrder,
                    pageIndex: pageNumber - 1,
                    pageNumber,
                    text,
                    kindLabel: annotationKindLabelFromSubtype(subtype, t),
                    subtype,
                    author: getAnnotationAuthor(annotation) ?? (popupAnnotation ? getAnnotationAuthor(popupAnnotation) : null),
                    modifiedAt: (() => {
                        const own = parsePdfDateTimestamp(annotation.modificationDate)
                            ?? parsePdfDateTimestamp(annotation.creationDate);
                        const popup = popupAnnotation
                            ? (
                                parsePdfDateTimestamp(popupAnnotation.modificationDate)
                                ?? parsePdfDateTimestamp(popupAnnotation.creationDate)
                            )
                            : null;
                        if (own && popup) {
                            return Math.max(own, popup);
                        }
                        return own ?? popup;
                    })(),
                    color: toCssColor(
                        annotation.color ?? popupAnnotation?.color ?? null,
                        annotation.opacity ?? popupAnnotation?.opacity ?? 1,
                    ),
                    uid: null,
                    annotationId,
                    source: 'pdf',
                    hasNote: Boolean(
                        isTextMarkupSubtype(subtype)
                        && hasLinkedPopup,
                    ),
                    markerRect: toMarkerRectFromPdfRect(
                        annotation.rect ?? popupAnnotation?.rect,
                        pageView,
                    ),
                };
                const normalizedSubtype = (subtype ?? '').trim().toLowerCase();
                if (
                    annotationId
                    && (normalizedSubtype === 'underline' || normalizedSubtype === 'strikeout' || normalizedSubtype === 'squiggly')
                ) {
                    markupSubtype.markupSubtypeOverrides.set(annotationId, subtype as TMarkupSubtype);
                }
                sourceOrder += 1;
                const hydratedSummary = identity.hydrateSummaryFromMemory(summary);

                const key = summaryKey;
                const existing = commentsByKey.get(key);
                if (!existing) {
                    commentsByKey.set(key, hydratedSummary);
                    return;
                }
                commentsByKey.set(key, identity.mergeCommentSummaries(existing, hydratedSummary));
            });
        }

        if (localToken !== annotationCommentsSyncToken) {
            return;
        }

        const comments = identity.dedupeAnnotationCommentSummaries(Array.from(commentsByKey.values()));
        comments.forEach((comment) => {
            identity.rememberSummaryText(comment);
        });
        annotationCommentsCache.value = comments;
        emitAnnotationComments(comments);
        markupSubtype.syncMarkupSubtypePresentationForEditors();
        syncInlineCommentIndicators();
    }

    const debouncedSyncAnnotationComments = useDebounceFn(() => {
        void syncAnnotationComments();
    }, 140);

    function scheduleAnnotationCommentsSync(immediate = false) {
        if (immediate) {
            void syncAnnotationComments();
            return;
        }
        debouncedSyncAnnotationComments();
    }

    function setActiveCommentStableKey(stableKey: string | null) {
        activeCommentStableKey.value = stableKey;
    }

    function incrementSyncToken() {
        annotationCommentsSyncToken += 1;
    }

    function clearSyncState() {
        annotationCommentsSyncToken += 1;
        pendingCommentEditorKeys.clear();
        identity.clearMemory();
        markupSubtype.clearOverrides();
    }

    return {
        annotationCommentsCache,
        activeCommentStableKey,
        pendingCommentEditorKeys,
        trackedCreatedEditors,
        toEditorSummary,
        syncAnnotationComments,
        scheduleAnnotationCommentsSync,
        setActiveCommentStableKey,
        incrementSyncToken,
        clearSyncState,
    };
}
