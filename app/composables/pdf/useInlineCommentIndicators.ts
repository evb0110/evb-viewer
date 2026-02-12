import type {
    Ref,
    ShallowRef,
} from 'vue';
import { useDebounceFn } from '@vueuse/core';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {
    IPdfjsEditor,
    IAnnotationContextMenuPayload,
} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    normalizeMarkerRect,
    detectEditorSubtype,
    getCommentText,
    isTextMarkupSubtype,
    escapeCssAttr,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';
import { useCommentMarkerPositioning } from '@app/composables/pdf/useCommentMarkerPositioning';
import { useCommentMarkerRendering } from '@app/composables/pdf/useCommentMarkerRendering';
import { useCommentMarkerInteraction } from '@app/composables/pdf/useCommentMarkerInteraction';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TCommentSync = ReturnType<typeof useAnnotationCommentSync>;

interface IUseInlineCommentIndicatorsOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    setActiveCommentStableKey: (stableKey: string | null) => void;
    identity: TIdentity;
    commentSync: TCommentSync;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    buildAnnotationContextMenuPayload: (comment: IAnnotationCommentSummary | null, clientX: number, clientY: number) => IAnnotationContextMenuPayload;
}

export function useInlineCommentIndicators(options: IUseInlineCommentIndicatorsOptions) {
    const {
        viewerContainer,
        numPages,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        setActiveCommentStableKey,
        identity,
        commentSync,
        emitAnnotationOpenNote,
        emitAnnotationContextMenu,
        buildAnnotationContextMenuPayload,
    } = options;

    const positioning = useCommentMarkerPositioning();
    const rendering = useCommentMarkerRendering({
        activeCommentStableKey,
        identity,
    });
    const interaction = useCommentMarkerInteraction({
        viewerContainer,
        activeCommentStableKey,
        setActiveCommentStableKey,
        identity,
        emitAnnotationOpenNote,
        emitAnnotationContextMenu,
        buildAnnotationContextMenuPayload,
        parseStableKeysAttr: rendering.parseStableKeysAttr,
        serializeStableKeysAttr: rendering.serializeStableKeysAttr,
        pickBestCommentFromStableKeys: rendering.pickBestCommentFromStableKeys,
        getInlineTargetStableKeys: rendering.getInlineTargetStableKeys,
        markerIncludesStableKey: rendering.markerIncludesStableKey,
        isCommentActive: rendering.isCommentActive,
    });

    let inlineCommentMarkerObserver: MutationObserver | null = null;

    function clearInlineCommentIndicators() {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }
        interaction.clearPulseTimeout();
        rendering.clearInlineCommentIndicators(container);
    }

    function renderDetachedCommentMarkers(pageContainer: HTMLElement, comments: IAnnotationCommentSummary[]) {
        const layer = rendering.ensureCommentMarkerLayer(pageContainer);
        const occupied: Array<{
            x: number;
            y: number 
        }> = [];
        const clusters = positioning.clusterDetachedComments(comments);
        clusters.forEach((cluster) => {
            const placement = positioning.resolveDetachedMarkerPlacement(pageContainer, cluster.anchorRect, occupied);
            const marker = interaction.createDetachedCommentClusterMarkerElement(
                cluster.comments,
                placement,
                rendering.pickPrimaryDetachedComment,
            );
            if (marker) {
                layer.append(marker);
            }
        });
    }

    function syncInlineCommentIndicators() {
        clearInlineCommentIndicators();

        const container = viewerContainer.value;
        if (!container || annotationCommentsCache.value.length === 0) {
            return;
        }

        const commentsWithNotes = annotationCommentsCache.value.filter(comment => (
            isTextMarkupSubtype(comment.subtype)
            && comment.hasNote === true
        ));
        if (commentsWithNotes.length === 0) {
            return;
        }

        const handledLogicalCommentKeys = new Set<string>();
        const dedupedCommentsByLogicalKey = new Map<string, IAnnotationCommentSummary>();
        commentsWithNotes.forEach((comment) => {
            const logicalKey = rendering.commentLogicalIndicatorKey(comment);
            const existing = dedupedCommentsByLogicalKey.get(logicalKey);
            if (!existing) {
                dedupedCommentsByLogicalKey.set(logicalKey, comment);
                return;
            }
            dedupedCommentsByLogicalKey.set(
                logicalKey,
                rendering.pickPreferredIndicatorComment(existing, comment),
            );
        });

        const dedupedComments = Array
            .from(dedupedCommentsByLogicalKey.values())
            .sort((left, right) => {
                const priorityDelta = identity.commentMergePriority(right) - identity.commentMergePriority(left);
                if (priorityDelta !== 0) {
                    return priorityDelta;
                }
                const leftTs = left.modifiedAt ?? 0;
                const rightTs = right.modifiedAt ?? 0;
                if (leftTs !== rightTs) {
                    return rightTs - leftTs;
                }
                return left.stableKey.localeCompare(right.stableKey);
            });

        const commentsByAnnotationId = new Map<string, IAnnotationCommentSummary>();
        dedupedComments.forEach((comment) => {
            if (comment.annotationId) {
                commentsByAnnotationId.set(comment.annotationId, comment);
            }
        });

        const uiManager = annotationUiManager.value;
        if (uiManager) {
            for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
                for (const editor of uiManager.getEditors(pageIndex)) {
                    const normalizedEditor = editor as IPdfjsEditor;
                    const subtype = detectEditorSubtype(normalizedEditor);
                    if ((subtype ?? '').trim().toLowerCase() !== 'highlight') {
                        continue;
                    }
                    const summary = identity.hydrateSummaryFromMemory(
                        commentSync.toEditorSummary(normalizedEditor, pageIndex, getCommentText(normalizedEditor).trim()),
                    );
                    if (!summary.hasNote) {
                        continue;
                    }
                    if (normalizedEditor.div) {
                        rendering.markInlineCommentTargetWithKey(
                            normalizedEditor.div,
                            summary.text,
                            summary.stableKey,
                            { anchor: true },
                            interaction.upsertInlineCommentAnchorMarker,
                        );
                        handledLogicalCommentKeys.add(rendering.commentLogicalIndicatorKey(summary));
                    }
                    if (summary.annotationId) {
                        commentsByAnnotationId.delete(summary.annotationId);
                    }
                }
            }
        }

        commentsByAnnotationId.forEach((comment, annotationId) => {
            const selector = `.annotationLayer [data-annotation-id="${escapeCssAttr(annotationId)}"], .annotation-layer [data-annotation-id="${escapeCssAttr(annotationId)}"]`;
            const targets = Array.from(container.querySelectorAll<HTMLElement>(selector));
            const anchor = positioning.pickInlineCommentAnchorTarget(targets);
            let marked = false;
            targets.forEach((target) => {
                marked = true;
                rendering.markInlineCommentTargetWithKey(
                    target,
                    comment.text,
                    comment.stableKey,
                    { anchor: target === anchor },
                    interaction.upsertInlineCommentAnchorMarker,
                );
            });
            if (marked) {
                handledLogicalCommentKeys.add(rendering.commentLogicalIndicatorKey(comment));
            }
        });

        const detachedCommentsByPage = new Map<number, IAnnotationCommentSummary[]>();
        const detachedGroupSeen = new Set<string>();
        dedupedComments.forEach((comment) => {
            const logicalKey = rendering.commentLogicalIndicatorKey(comment);
            if (handledLogicalCommentKeys.has(logicalKey)) {
                return;
            }

            const pageContainer = container.querySelector<HTMLElement>(`.page_container[data-page="${comment.pageNumber}"]`);
            if (pageContainer && rendering.markInlineCommentTargetsFromTextLayer(
                pageContainer,
                comment,
                positioning.markerRectToPagePixels,
                positioning.rectsIntersectLocal,
                positioning.pickInlineCommentAnchorTarget,
                interaction.upsertInlineCommentAnchorMarker,
            )) {
                handledLogicalCommentKeys.add(logicalKey);
                return;
            }

            const markerRect = normalizeMarkerRect(comment.markerRect);
            if (!markerRect) {
                return;
            }
            const groupKey = logicalKey;
            if (detachedGroupSeen.has(groupKey)) {
                return;
            }
            detachedGroupSeen.add(groupKey);

            const pageComments = detachedCommentsByPage.get(comment.pageNumber) ?? [];
            pageComments.push(comment);
            detachedCommentsByPage.set(comment.pageNumber, pageComments);
            handledLogicalCommentKeys.add(logicalKey);
        });

        detachedCommentsByPage.forEach((comments, pageNumber) => {
            const pageContainer = container.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
            if (!pageContainer) {
                return;
            }
            renderDetachedCommentMarkers(pageContainer, comments);
        });
    }

    const debouncedSyncInlineCommentIndicators = useDebounceFn(() => {
        syncInlineCommentIndicators();
    }, 70);

    function attachInlineCommentMarkerObserver() {
        if (inlineCommentMarkerObserver) {
            inlineCommentMarkerObserver.disconnect();
            inlineCommentMarkerObserver = null;
        }
        const container = viewerContainer.value;
        if (!container || typeof MutationObserver === 'undefined') {
            return;
        }

        inlineCommentMarkerObserver = new MutationObserver((records) => {
            const hasRelevantMutation = records.some(record => (
                Array.from(record.addedNodes).some(node => (
                    node instanceof HTMLElement
                    && (
                        node.matches('.highlightEditor, [data-annotation-id], .annotationLayer, .annotation-layer, .text-layer, .textLayer')
                        || !!node.querySelector('.highlightEditor, [data-annotation-id], .text-layer span, .textLayer span')
                    )
                ))
            ));
            if (hasRelevantMutation) {
                debouncedSyncInlineCommentIndicators();
            }
        });
        inlineCommentMarkerObserver.observe(container, {
            childList: true,
            subtree: true,
        });
    }

    function cleanup() {
        inlineCommentMarkerObserver?.disconnect();
        inlineCommentMarkerObserver = null;
        clearInlineCommentIndicators();
    }

    return {
        clearInlineCommentIndicators,
        syncInlineCommentIndicators,
        debouncedSyncInlineCommentIndicators,
        attachInlineCommentMarkerObserver,
        pulseCommentIndicator: interaction.pulseCommentIndicator,
        resolveCommentFromIndicatorElement: interaction.resolveCommentFromIndicatorElement,
        resolveCommentFromIndicatorClickTarget: interaction.resolveCommentFromIndicatorClickTarget,
        findCommentFromInlineTarget: interaction.findCommentFromInlineTarget,
        pickBestCommentFromStableKeys: rendering.pickBestCommentFromStableKeys,
        cleanup,
    };
}
