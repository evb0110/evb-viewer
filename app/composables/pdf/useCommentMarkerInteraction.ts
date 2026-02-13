import type { Ref } from 'vue';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {
    escapeCssAttr,
    commentPreviewText,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import { FOCUS_PULSE_MS } from '@app/constants/timeouts';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;

interface ICommentMarkerInteractionDeps {
    viewerContainer: Ref<HTMLElement | null>;
    activeCommentStableKey: Ref<string | null>;
    setActiveCommentStableKey: (stableKey: string | null) => void;
    identity: TIdentity;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    buildAnnotationContextMenuPayload: (comment: IAnnotationCommentSummary | null, clientX: number, clientY: number) => IAnnotationContextMenuPayload;
    parseStableKeysAttr: (value: string | null | undefined) => string[];
    serializeStableKeysAttr: (keys: string[]) => string;
    pickBestCommentFromStableKeys: (stableKeys: string[]) => IAnnotationCommentSummary | null;
    getInlineTargetStableKeys: (target: HTMLElement) => string[];
    markerIncludesStableKey: (marker: HTMLElement, stableKey: string) => boolean;
    isCommentActive: (stableKey: string) => boolean;
}

export const useCommentMarkerInteraction = (deps: ICommentMarkerInteractionDeps) => {
    const { t } = useI18n();

    let inlineCommentFocusPulseTimeout: ReturnType<typeof setTimeout> | null = null;

    function resolveCommentFromIndicatorElement(indicator: HTMLElement) {
        const stableKeys = deps.parseStableKeysAttr(indicator.getAttribute('data-comment-stable-keys'));
        const fromStableKeys = deps.pickBestCommentFromStableKeys(stableKeys);
        if (fromStableKeys) {
            return fromStableKeys;
        }

        const directStableKey = indicator.dataset.commentStableKey ?? indicator.getAttribute('data-comment-stable-key');
        if (directStableKey) {
            const byStableKey = deps.identity.findCommentByStableKey(directStableKey);
            if (byStableKey) {
                return byStableKey;
            }
        }

        const pageNumberRaw = indicator.dataset.pageNumber ?? null;
        const pageNumber = pageNumberRaw && Number.isFinite(Number(pageNumberRaw))
            ? Number(pageNumberRaw)
            : null;

        return deps.identity.findCommentByAnnotationId(
            indicator.dataset.annotationId ?? indicator.getAttribute('data-annotation-id'),
            pageNumber,
        );
    }

    function resolveCommentFromIndicatorClickTarget(target: HTMLElement) {
        const customIndicator = target.closest<HTMLElement>('.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker');
        if (customIndicator) {
            const inlineTarget = customIndicator.closest<HTMLElement>('.pdf-annotation-has-note-target, .pdf-annotation-has-comment');
            return (
                resolveCommentFromIndicatorElement(customIndicator)
                ?? (inlineTarget ? findCommentFromInlineTarget(inlineTarget) : null)
            );
        }

        const popupTrigger = target.closest<HTMLElement>('.annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea');
        if (popupTrigger) {
            return null;
        }

        return null;
    }

    function findCommentFromInlineTarget(target: HTMLElement) {
        const stableKeys = deps.getInlineTargetStableKeys(target);
        if (stableKeys.length > 0) {
            return deps.pickBestCommentFromStableKeys(stableKeys);
        }
        const stableKey = target.getAttribute('data-comment-stable-key');
        if (!stableKey) {
            return null;
        }
        return deps.identity.findCommentByStableKey(stableKey);
    }

    function pulseCommentIndicator(stableKey: string) {
        const container = deps.viewerContainer.value;
        if (!container) {
            return;
        }
        if (inlineCommentFocusPulseTimeout) {
            clearTimeout(inlineCommentFocusPulseTimeout);
            inlineCommentFocusPulseTimeout = null;
        }

        container.querySelectorAll<HTMLElement>('.pdf-comment-focus-pulse').forEach((element) => {
            element.classList.remove('pdf-comment-focus-pulse');
        });

        const escapedStableKey = escapeCssAttr(stableKey);
        const inlineTargets = Array.from(container.querySelectorAll<HTMLElement>(`[data-comment-stable-key="${escapedStableKey}"]`));
        const multiTargets = Array
            .from(container.querySelectorAll<HTMLElement>('[data-comment-stable-keys]'))
            .filter(target => deps.getInlineTargetStableKeys(target).includes(stableKey));
        const markers = Array
            .from(container.querySelectorAll<HTMLElement>('.pdf-inline-comment-marker, .pdf-inline-comment-anchor-marker'))
            .filter(marker => deps.markerIncludesStableKey(marker, stableKey));

        const pulseTargets = Array.from(new Set([
            ...inlineTargets,
            ...multiTargets,
            ...markers,
        ]));
        if (pulseTargets.length === 0) {
            return;
        }

        pulseTargets.forEach((target) => {
            target.classList.add('pdf-comment-focus-pulse');
        });
        inlineCommentFocusPulseTimeout = setTimeout(() => {
            container.querySelectorAll<HTMLElement>('.pdf-comment-focus-pulse').forEach((element) => {
                element.classList.remove('pdf-comment-focus-pulse');
            });
            inlineCommentFocusPulseTimeout = null;
        }, FOCUS_PULSE_MS);
    }

    function upsertInlineCommentAnchorMarker(target: HTMLElement, stableKeys: string[], fallbackText: string) {
        if (stableKeys.length === 0) {
            target.querySelectorAll('.pdf-inline-comment-anchor-marker').forEach((marker) => {
                marker.remove();
            });
            return;
        }

        const best = deps.pickBestCommentFromStableKeys(stableKeys);
        const base = best
            ? commentPreviewText(best, t('annotations.emptyNote'))
            : fallbackText;
        const preview = stableKeys.length > 1
            ? `${base} (${t('annotations.moreNotes', { count: stableKeys.length - 1 })})`
            : base;
        const summary = deps.pickBestCommentFromStableKeys(stableKeys);
        const marker = (
            target.querySelector('.pdf-inline-comment-anchor-marker') as HTMLButtonElement | null
        ) ?? document.createElement('button');

        if (!marker.parentElement) {
            marker.type = 'button';
            marker.className = 'pdf-inline-comment-anchor-marker';
            marker.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const selected = resolveCommentFromIndicatorElement(marker);
                if (!selected) {
                    return;
                }
                deps.setActiveCommentStableKey(selected.stableKey);
                pulseCommentIndicator(selected.stableKey);
                deps.emitAnnotationOpenNote(selected);
            });
            marker.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const selected = resolveCommentFromIndicatorElement(marker);
                if (!selected) {
                    return;
                }
                deps.setActiveCommentStableKey(selected.stableKey);
                pulseCommentIndicator(selected.stableKey);
                deps.emitAnnotationContextMenu(deps.buildAnnotationContextMenuPayload(selected, event.clientX, event.clientY));
            });
            target.append(marker);
        }

        marker.dataset.commentStableKey = summary?.stableKey ?? stableKeys[0] ?? '';
        marker.dataset.commentStableKeys = deps.serializeStableKeysAttr(stableKeys);
        marker.dataset.annotationId = summary?.annotationId ?? '';
        marker.dataset.pageNumber = summary ? String(summary.pageNumber) : '';
        marker.dataset.commentCount = String(stableKeys.length);
        marker.classList.toggle('is-active', stableKeys.some(stableKey => deps.isCommentActive(stableKey)));
        marker.classList.toggle('is-cluster', stableKeys.length > 1);
        marker.setAttribute(
            'aria-label',
            stableKeys.length > 1
                ? t('annotations.openPopUpNoteCount', { count: stableKeys.length })
                : t('annotations.openPopUpNote'),
        );
        marker.setAttribute('title', preview);
        target.setAttribute('title', preview);
    }

    function createDetachedCommentClusterMarkerElement(
        comments: IAnnotationCommentSummary[],
        placement: {
            leftPercent: number;
            topPercent: number 
        },
        pickPrimaryFn: (comments: IAnnotationCommentSummary[]) => IAnnotationCommentSummary | undefined,
    ) {
        const primaryComment = pickPrimaryFn(comments);
        if (!primaryComment) {
            return null;
        }
        const noteCount = comments.length;
        const trimmedPreview = commentPreviewText(primaryComment, t('annotations.emptyNote'));
        const preview = noteCount > 1
            ? `${trimmedPreview} (${t('annotations.moreNotes', { count: noteCount - 1 })})`
            : trimmedPreview;

        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'pdf-inline-comment-marker';
        if (comments.some(candidate => deps.isCommentActive(candidate.stableKey))) {
            marker.classList.add('is-active');
        }
        if (noteCount > 1) {
            marker.classList.add('is-cluster');
            marker.dataset.commentCount = String(noteCount);
        }
        marker.dataset.commentStableKey = primaryComment.stableKey;
        marker.dataset.commentStableKeys = deps.serializeStableKeysAttr(comments.map(comment => comment.stableKey));
        marker.dataset.annotationId = primaryComment.annotationId ?? '';
        marker.dataset.pageNumber = String(primaryComment.pageNumber);
        marker.style.left = `${placement.leftPercent}%`;
        marker.style.top = `${placement.topPercent}%`;
        marker.title = preview;
        marker.setAttribute(
            'aria-label',
            noteCount > 1
                ? t('annotations.openPopUpNoteCount', { count: noteCount })
                : t('annotations.openPopUpNote'),
        );
        marker.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const resolved = resolveCommentFromIndicatorElement(marker);
            if (resolved) {
                deps.setActiveCommentStableKey(resolved.stableKey);
                pulseCommentIndicator(resolved.stableKey);
                deps.emitAnnotationOpenNote(resolved);
            }
        });
        marker.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const resolved = resolveCommentFromIndicatorElement(marker);
            if (resolved) {
                deps.setActiveCommentStableKey(resolved.stableKey);
                pulseCommentIndicator(resolved.stableKey);
                deps.emitAnnotationContextMenu(deps.buildAnnotationContextMenuPayload(resolved, event.clientX, event.clientY));
            }
        });
        return marker;
    }

    function clearPulseTimeout() {
        if (inlineCommentFocusPulseTimeout) {
            clearTimeout(inlineCommentFocusPulseTimeout);
            inlineCommentFocusPulseTimeout = null;
        }
    }

    return {
        resolveCommentFromIndicatorElement,
        resolveCommentFromIndicatorClickTarget,
        findCommentFromInlineTarget,
        pulseCommentIndicator,
        upsertInlineCommentAnchorMarker,
        createDetachedCommentClusterMarkerElement,
        clearPulseTimeout,
    };
};
