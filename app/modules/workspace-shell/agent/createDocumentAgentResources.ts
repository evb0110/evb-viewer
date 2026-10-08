import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type { IAnnotationNoteWindowViewModel } from '@app/types/annotationNoteWindow';
import {
    normalizeMarkerRect,
    annotationIdForSummary,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import { parseAgentResourceUri } from '@contracts/agentResourceUri';

interface ICreateDocumentAgentResourcesOptions {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationCommentsStatus: Ref<TAnnotationCommentsStatus>;
    annotationInventory: Ref<IAnnotationInventoryCompleteness | null>;
    annotationDirty: Ref<boolean>;
    canSave: Ref<boolean>;
    createAgentBookmarkSnapshot: () => {
        bookmarks: unknown;
        count: number;
        dirty: boolean;
        flat: unknown;
        issues: unknown;
        summary: unknown;
    };
    createAgentPageLabelSnapshot: () => object;
    currentPage: Ref<number>;
    hasPdf: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    normalizeAgentAnnotationComment: (comment: IAnnotationCommentSummary) => Record<string, unknown>;
    originalPath: Ref<TDocumentRef | null>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowViewModel[]>;
    tabId: string;
    totalPages: Ref<number>;
    workingCopyPath: Ref<TDocumentRef | null>;
}

/**
 * An automation client reading the annotation list has no other way to learn
 * that the background inventory stopped short, so a truncated or partly failed
 * scan has to say so in the payload rather than look like a full listing.
 */
function toAgentInventoryFields(completeness: IAnnotationInventoryCompleteness | null) {
    if (!completeness) {
        return { inventoryComplete: null };
    }

    return {
        inventoryComplete: completeness.complete,
        inventoryOmissions: [...completeness.omissions],
        inventoryScannedPageCount: completeness.scannedPageCount,
        inventoryTotalPageCount: completeness.totalPageCount,
        inventoryFailedPageCount: completeness.failedPageCount,
    };
}

export function createDocumentAgentResources(options: ICreateDocumentAgentResourcesOptions) {
    const {
        annotationComments,
        annotationCommentsStatus,
        annotationInventory,
        annotationDirty,
        canSave,
        createAgentBookmarkSnapshot,
        createAgentPageLabelSnapshot,
        currentPage,
        hasPdf,
        isAnySaving,
        normalizeAgentAnnotationComment,
        originalPath,
        sortedAnnotationNoteWindows,
        tabId,
        totalPages,
        workingCopyPath,
    } = options;

    function createAgentResource(uri: string): Record<string, unknown> {
        const parsed = parseAgentResourceUri(uri);
        if (parsed.host !== 'document') {
            throw new Error(`Unsupported workspace resource host: ${parsed.host}`);
        }
        const [
            resourceTabId,
            resourceKind,
        ] = parsed.parts;
        if (resourceTabId && resourceTabId !== tabId) {
            throw new Error(`Resource tab ${resourceTabId} does not match workspace tab ${tabId}.`);
        }

        if (!resourceKind || resourceKind === 'status' || resourceKind === 'state') {
            return {
                uri,
                tabId,
                status: 'ready',
                currentPage: currentPage.value,
                totalPages: totalPages.value,
                canSave: canSave.value,
                isSaving: isAnySaving.value,
                hasPdf: hasPdf.value,
                workingCopyPath: workingCopyPath.value,
                originalPath: originalPath.value,
                annotationDirty: annotationDirty.value,
                annotationNoteWindowsCount: sortedAnnotationNoteWindows.value.length,
                annotationCommentsStatus: annotationCommentsStatus.value,
                annotationCommentsCount: annotationComments.value.length,
                ...toAgentInventoryFields(annotationInventory.value),
            };
        }

        if (resourceKind === 'annotations') {
            return {
                uri,
                tabId,
                status: annotationCommentsStatus.value,
                count: annotationComments.value.length,
                ...toAgentInventoryFields(annotationInventory.value),
                annotations: annotationComments.value.map(normalizeAgentAnnotationComment),
            };
        }

        if (resourceKind === 'notes') {
            const openNoteByAnnotationId = new Map(
                sortedAnnotationNoteWindows.value.map(note => [
                    note.annotationId,
                    note,
                ] as const),
            );
            const notes = annotationComments.value
                .filter(comment => (
                    comment.hasNote === true
                    || comment.text.trim().length > 0
                    || openNoteByAnnotationId.has(annotationIdForSummary(comment))
                ))
                .map((comment) => {
                    const openNote = openNoteByAnnotationId.get(annotationIdForSummary(comment)) ?? null;
                    const openNoteMarkerRect = normalizeMarkerRect(openNote?.markerRect);
                    const normalizedComment = normalizeAgentAnnotationComment(comment);
                    return {
                        ...normalizedComment,
                        markerRect: openNoteMarkerRect ?? normalizedComment.markerRect,
                        text: openNote?.draftText ?? comment.text,
                        isOpen: openNote !== null,
                        isMinimized: openNote?.isMinimized ?? false,
                        saving: openNote?.saving ?? false,
                        error: openNote?.error ?? null,
                        saveMode: openNote?.pendingEmbeddedSave ? 'embedded' : 'auto',
                    };
                });
            return {
                uri,
                tabId,
                status: annotationCommentsStatus.value,
                count: notes.length,
                ...toAgentInventoryFields(annotationInventory.value),
                notes,
            };
        }

        if (resourceKind === 'toc' || resourceKind === 'bookmarks') {
            const {
                bookmarks, ...snapshot
            } = createAgentBookmarkSnapshot();
            return {
                uri,
                tabId,
                status: 'ready',
                schemaVersion: 2,
                treeField: resourceKind,
                ...snapshot,
                [resourceKind]: bookmarks,
            };
        }

        if (resourceKind === 'page-labels' || resourceKind === 'page-numbering') {
            return {
                uri,
                tabId,
                status: 'ready',
                ...createAgentPageLabelSnapshot(),
            };
        }

        throw new Error(`Unsupported workspace document resource: ${resourceKind}`);
    }

    function readAgentResource(uri: string): Promise<Record<string, unknown>> {
        return Promise.resolve(createAgentResource(uri));
    }

    return { readAgentResource };
}
