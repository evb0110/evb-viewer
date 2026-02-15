import type { Ref } from 'vue';
import { uniq } from 'es-toolkit/array';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    normalizeMarkerRect,
    commentPreviewText,
    commentPreviewFromRawText,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;

export const useCommentMarkerRendering = (deps: {
    activeCommentStableKey: Ref<string | null>;
    identity: TIdentity;
}) => {
    const { t } = useTypedI18n();

    function isCommentActive(stableKey: string) {
        return deps.activeCommentStableKey.value === stableKey;
    }

    function parseStableKeysAttr(value: string | null | undefined) {
        if (!value) {
            return [];
        }
        return value
            .split('|')
            .map(entry => entry.trim())
            .filter(Boolean);
    }

    function serializeStableKeysAttr(keys: string[]) {
        if (keys.length === 0) {
            return '';
        }
        return `|${keys.join('|')}|`;
    }

    function getInlineTargetStableKeys(target: HTMLElement) {
        const fromList = parseStableKeysAttr(target.getAttribute('data-comment-stable-keys'));
        if (fromList.length > 0) {
            return fromList;
        }
        const single = target.getAttribute('data-comment-stable-key');
        if (single) {
            return [single];
        }
        return [];
    }

    function setInlineTargetStableKeys(target: HTMLElement, stableKeys: string[]) {
        const deduped = uniq(stableKeys.filter(Boolean));
        if (deduped.length === 0) {
            target.removeAttribute('data-comment-stable-keys');
            target.removeAttribute('data-comment-count');
            target.classList.remove('pdf-annotation-has-note-multi');
            return;
        }
        target.setAttribute('data-comment-stable-keys', serializeStableKeysAttr(deduped));
        target.setAttribute('data-comment-count', String(deduped.length));
        target.classList.toggle('pdf-annotation-has-note-multi', deduped.length > 1);
    }

    function pickBestCommentFromStableKeys(stableKeys: string[]) {
        if (stableKeys.length === 0) {
            return null;
        }

        const activeKey = deps.activeCommentStableKey.value;
        if (activeKey && stableKeys.includes(activeKey)) {
            const activeComment = deps.identity.findCommentByStableKey(activeKey);
            if (activeComment) {
                return activeComment;
            }
        }

        return stableKeys
            .map(stableKey => deps.identity.findCommentByStableKey(stableKey))
            .filter((comment): comment is IAnnotationCommentSummary => Boolean(comment))
            .sort((left, right) => {
                const leftTs = left.modifiedAt ?? 0;
                const rightTs = right.modifiedAt ?? 0;
                if (leftTs !== rightTs) {
                    return rightTs - leftTs;
                }
                return left.stableKey.localeCompare(right.stableKey);
            })[0] ?? null;
    }

    function makeInlineMarkerPreview(stableKeys: string[], fallbackText: string) {
        const best = pickBestCommentFromStableKeys(stableKeys);
        const base = best
            ? commentPreviewText(best, t('annotations.emptyNote'))
            : commentPreviewFromRawText(fallbackText, t('annotations.emptyNote'));
        if (stableKeys.length <= 1) {
            return base;
        }
        return `${base} (${t('annotations.moreNotes', { count: stableKeys.length - 1 })})`;
    }

    function markInlineCommentTarget(target: HTMLElement, text: string) {
        const normalizedText = text.trim();
        target.classList.add('pdf-annotation-has-note-target');
        const preview = normalizedText
            ? (
                normalizedText.length > 280
                    ? `${normalizedText.slice(0, 277)}...`
                    : normalizedText
            )
            : t('annotations.emptyNote');
        target.setAttribute('data-comment-preview', preview);
        target.setAttribute('title', preview);
    }

    function markInlineCommentTargetWithKey(
        target: HTMLElement,
        text: string,
        stableKey: string,
        markerOptions: { anchor?: boolean } = {},
        upsertAnchorMarkerFn: (target: HTMLElement, stableKeys: string[], fallbackText: string) => void,
    ) {
        markInlineCommentTarget(target, text);
        const nextStableKeys = uniq([
            ...getInlineTargetStableKeys(target),
            stableKey,
        ]);
        setInlineTargetStableKeys(target, nextStableKeys);

        const activeKey = deps.activeCommentStableKey.value;
        const activeInTarget = Boolean(activeKey && nextStableKeys.includes(activeKey));
        const preferredStableKey = activeInTarget
            ? (activeKey as string)
            : (target.getAttribute('data-comment-stable-key') || stableKey);
        target.setAttribute('data-comment-stable-key', preferredStableKey);

        if (markerOptions.anchor === true) {
            target.classList.add('pdf-annotation-has-note-anchor');
            upsertAnchorMarkerFn(target, nextStableKeys, text);
        } else {
            target.querySelectorAll('.pdf-inline-comment-anchor-marker').forEach((marker) => {
                marker.remove();
            });
        }
        if (activeInTarget || isCommentActive(stableKey)) {
            target.classList.add('pdf-annotation-has-note-active');
        } else {
            target.classList.remove('pdf-annotation-has-note-active');
        }
    }

    function markerIncludesStableKey(marker: HTMLElement, stableKey: string) {
        const markerStableKey = marker.dataset.commentStableKey ?? '';
        if (markerStableKey === stableKey) {
            return true;
        }
        const markerStableKeys = parseStableKeysAttr(marker.getAttribute('data-comment-stable-keys'));
        return markerStableKeys.includes(stableKey);
    }

    function ensureCommentMarkerLayer(pageContainer: HTMLElement) {
        let layer = pageContainer.querySelector<HTMLElement>('.pdf-comment-marker-layer');
        if (layer) {
            return layer;
        }

        layer = document.createElement('div');
        layer.className = 'pdf-comment-marker-layer';
        layer.setAttribute('aria-hidden', 'false');
        pageContainer.append(layer);
        return layer;
    }

    function pickPrimaryDetachedComment(comments: IAnnotationCommentSummary[]) {
        const active = comments.find(candidate => isCommentActive(candidate.stableKey));
        if (active) {
            return active;
        }
        return comments
            .slice()
            .sort((left, right) => {
                const leftTs = left.modifiedAt ?? 0;
                const rightTs = right.modifiedAt ?? 0;
                if (leftTs !== rightTs) {
                    return rightTs - leftTs;
                }
                return left.stableKey.localeCompare(right.stableKey);
            })[0] ?? comments[0];
    }

    function clearInlineCommentIndicators(container: HTMLElement) {
        container.querySelectorAll<HTMLElement>('.pdf-annotation-has-note-target, .pdf-annotation-has-comment').forEach((element) => {
            element.classList.remove(
                'pdf-annotation-has-note-target',
                'pdf-annotation-has-note-anchor',
                'pdf-annotation-has-note-active',
                'pdf-annotation-has-note-multi',
                'pdf-annotation-has-comment',
                'has-comment',
                'pdf-annotation-has-comment--active',
            );
            element.removeAttribute('data-comment-preview');
            element.removeAttribute('data-comment-stable-key');
            element.removeAttribute('data-comment-stable-keys');
            element.removeAttribute('data-comment-count');
            element.removeAttribute('title');
            element.querySelectorAll('.pdf-inline-comment-anchor-marker').forEach((marker) => {
                marker.remove();
            });
        });
        container.querySelectorAll<HTMLElement>('.pdf-comment-marker-layer').forEach((layer) => {
            layer.remove();
        });
    }

    function markInlineCommentTargetsFromTextLayer(
        pageContainer: HTMLElement,
        comment: IAnnotationCommentSummary,
        markerRectToPagePixelsFn: (pageContainer: HTMLElement, markerRect: {
            left: number;
            top: number;
            width: number;
            height: number 
        }) => {
            left: number;
            top: number;
            right: number;
            bottom: number 
        } | null,
        rectsIntersectFn: (a: {
            left: number;
            top: number;
            right: number;
            bottom: number 
        }, b: {
                left: number;
                top: number;
                right: number;
                bottom: number 
            }) => boolean,
        pickAnchorFn: (targets: HTMLElement[]) => HTMLElement | null,
        upsertAnchorMarkerFn: (target: HTMLElement, stableKeys: string[], fallbackText: string) => void,
    ) {
        const markerRect = normalizeMarkerRect(comment.markerRect);
        if (!markerRect) {
            return false;
        }
        const markerPx = markerRectToPagePixelsFn(pageContainer, markerRect);
        if (!markerPx) {
            return false;
        }

        const pageRect = pageContainer.getBoundingClientRect();
        const tolerance = 2;
        const markerBounds = {
            left: markerPx.left - tolerance,
            top: markerPx.top - tolerance,
            right: markerPx.right + tolerance,
            bottom: markerPx.bottom + tolerance,
        };

        const textSpans = Array
            .from(pageContainer.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span'))
            .filter((span) => {
                const rect = span.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) {
                    return false;
                }
                const spanBounds = {
                    left: rect.left - pageRect.left,
                    top: rect.top - pageRect.top,
                    right: rect.right - pageRect.left,
                    bottom: rect.bottom - pageRect.top,
                };
                return rectsIntersectFn(spanBounds, markerBounds);
            });

        if (textSpans.length === 0) {
            return false;
        }

        const anchor = pickAnchorFn(textSpans);
        textSpans.forEach((target) => {
            markInlineCommentTargetWithKey(
                target,
                comment.text,
                comment.stableKey,
                { anchor: target === anchor },
                upsertAnchorMarkerFn,
            );
        });
        return true;
    }

    function commentLogicalIndicatorKey(comment: IAnnotationCommentSummary) {
        if (comment.annotationId) {
            return `ann:${comment.pageNumber}:${comment.annotationId}`;
        }
        if (comment.uid) {
            return `uid:${comment.pageNumber}:${comment.uid}`;
        }
        return `stable:${comment.pageNumber}:${comment.stableKey}`;
    }

    function pickPreferredIndicatorComment(
        existing: IAnnotationCommentSummary,
        candidate: IAnnotationCommentSummary,
    ) {
        const priorityDelta = deps.identity.commentMergePriority(candidate) - deps.identity.commentMergePriority(existing);
        if (priorityDelta > 0) {
            return candidate;
        }
        if (priorityDelta < 0) {
            return existing;
        }
        const existingTs = existing.modifiedAt ?? 0;
        const candidateTs = candidate.modifiedAt ?? 0;
        if (candidateTs > existingTs) {
            return candidate;
        }
        if (candidateTs < existingTs) {
            return existing;
        }
        return existing.stableKey.localeCompare(candidate.stableKey) <= 0
            ? existing
            : candidate;
    }

    return {
        isCommentActive,
        parseStableKeysAttr,
        serializeStableKeysAttr,
        getInlineTargetStableKeys,
        setInlineTargetStableKeys,
        pickBestCommentFromStableKeys,
        makeInlineMarkerPreview,
        markInlineCommentTarget,
        markInlineCommentTargetWithKey,
        markerIncludesStableKey,
        ensureCommentMarkerLayer,
        pickPrimaryDetachedComment,
        clearInlineCommentIndicators,
        markInlineCommentTargetsFromTextLayer,
        commentLogicalIndicatorKey,
        pickPreferredIndicatorComment,
    };
};
