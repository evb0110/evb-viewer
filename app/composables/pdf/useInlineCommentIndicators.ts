import type {
    Ref,
    ShallowRef,
} from 'vue';
import { useDebounceFn } from '@vueuse/core';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type {
    IPdfjsEditor,
    IAnnotationContextMenuPayload,
} from '@app/composables/pdf/pdfAnnotationUtils';
import {
    normalizeMarkerRect,
    markerRectIoU,
    mergeMarkerRects,
    detectEditorSubtype,
    getCommentText,
    isTextMarkupSubtype,
    escapeCssAttr,
    commentPreviewText,
    commentPreviewFromRawText,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import type { useAnnotationCommentSync } from '@app/composables/pdf/useAnnotationCommentSync';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;
type TCommentSync = ReturnType<typeof useAnnotationCommentSync>;

interface IDetachedMarkerPlacement {
    leftPercent: number;
    topPercent: number;
}

interface IDetachedCommentCluster {
    anchorRect: IAnnotationMarkerRect;
    comments: IAnnotationCommentSummary[];
}

interface IDetachedMarkerOccupied {
    x: number;
    y: number;
}

interface IDetachedMarkerOffset {
    x: number;
    y: number;
}

interface IDetachedMarkerFallback {
    x: number;
    y: number;
    minDistanceSquared: number;
}

const DETACHED_MARKER_OFFSETS: IDetachedMarkerOffset[] = [
    {
        x: 0,
        y: 0, 
    },
    {
        x: 18,
        y: -10, 
    },
    {
        x: 18,
        y: 10, 
    },
    {
        x: -18,
        y: -10, 
    },
    {
        x: -18,
        y: 10, 
    },
    {
        x: 30,
        y: 0, 
    },
    {
        x: 0,
        y: -20, 
    },
    {
        x: 0,
        y: 20, 
    },
    {
        x: 30,
        y: -18, 
    },
    {
        x: 30,
        y: 18, 
    },
    {
        x: -30,
        y: 0, 
    },
    {
        x: 42,
        y: 0, 
    },
    {
        x: -42,
        y: 0, 
    },
    {
        x: 52,
        y: -14, 
    },
    {
        x: 52,
        y: 14, 
    },
    {
        x: -52,
        y: -14, 
    },
    {
        x: -52,
        y: 14, 
    },
];

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

    let inlineCommentMarkerObserver: MutationObserver | null = null;
    let inlineCommentFocusPulseTimeout: ReturnType<typeof setTimeout> | null = null;

    function isCommentActive(stableKey: string) {
        return activeCommentStableKey.value === stableKey;
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
        const deduped = Array.from(new Set(stableKeys.filter(Boolean)));
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

        const activeKey = activeCommentStableKey.value;
        if (activeKey && stableKeys.includes(activeKey)) {
            const activeComment = identity.findCommentByStableKey(activeKey);
            if (activeComment) {
                return activeComment;
            }
        }

        return stableKeys
            .map(stableKey => identity.findCommentByStableKey(stableKey))
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
            ? commentPreviewText(best)
            : commentPreviewFromRawText(fallbackText);
        if (stableKeys.length <= 1) {
            return base;
        }
        return `${base} (+${stableKeys.length - 1} more note${stableKeys.length > 2 ? 's' : ''})`;
    }

    function resolveCommentFromIndicatorElement(indicator: HTMLElement) {
        const stableKeys = parseStableKeysAttr(indicator.getAttribute('data-comment-stable-keys'));
        const fromStableKeys = pickBestCommentFromStableKeys(stableKeys);
        if (fromStableKeys) {
            return fromStableKeys;
        }

        const directStableKey = indicator.dataset.commentStableKey ?? indicator.getAttribute('data-comment-stable-key');
        if (directStableKey) {
            const byStableKey = identity.findCommentByStableKey(directStableKey);
            if (byStableKey) {
                return byStableKey;
            }
        }

        const pageNumberRaw = indicator.dataset.pageNumber ?? null;
        const pageNumber = pageNumberRaw && Number.isFinite(Number(pageNumberRaw))
            ? Number(pageNumberRaw)
            : null;

        return identity.findCommentByAnnotationId(
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
        const stableKeys = getInlineTargetStableKeys(target);
        if (stableKeys.length > 0) {
            return pickBestCommentFromStableKeys(stableKeys);
        }
        const stableKey = target.getAttribute('data-comment-stable-key');
        if (!stableKey) {
            return null;
        }
        return identity.findCommentByStableKey(stableKey);
    }

    function markerIncludesStableKey(marker: HTMLElement, stableKey: string) {
        const markerStableKey = marker.dataset.commentStableKey ?? '';
        if (markerStableKey === stableKey) {
            return true;
        }
        const markerStableKeys = parseStableKeysAttr(marker.getAttribute('data-comment-stable-keys'));
        return markerStableKeys.includes(stableKey);
    }

    function pulseCommentIndicator(stableKey: string) {
        const container = viewerContainer.value;
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
            .filter(target => getInlineTargetStableKeys(target).includes(stableKey));
        const markers = Array
            .from(container.querySelectorAll<HTMLElement>('.pdf-inline-comment-marker, .pdf-inline-comment-anchor-marker'))
            .filter(marker => markerIncludesStableKey(marker, stableKey));

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
        }, 900);
    }

    function clearInlineCommentIndicators() {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }
        if (inlineCommentFocusPulseTimeout) {
            clearTimeout(inlineCommentFocusPulseTimeout);
            inlineCommentFocusPulseTimeout = null;
        }
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

    function markInlineCommentTarget(target: HTMLElement, text: string) {
        const normalizedText = text.trim();
        target.classList.add('pdf-annotation-has-note-target');
        const preview = normalizedText
            ? (
                normalizedText.length > 280
                    ? `${normalizedText.slice(0, 277)}...`
                    : normalizedText
            )
            : 'Empty note';
        target.setAttribute('data-comment-preview', preview);
        target.setAttribute('title', preview);
    }

    function upsertInlineCommentAnchorMarker(target: HTMLElement, stableKeys: string[], fallbackText: string) {
        if (stableKeys.length === 0) {
            target.querySelectorAll('.pdf-inline-comment-anchor-marker').forEach((marker) => {
                marker.remove();
            });
            return;
        }

        const preview = makeInlineMarkerPreview(stableKeys, fallbackText);
        const summary = pickBestCommentFromStableKeys(stableKeys);
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
                setActiveCommentStableKey(selected.stableKey);
                pulseCommentIndicator(selected.stableKey);
                emitAnnotationOpenNote(selected);
            });
            marker.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const selected = resolveCommentFromIndicatorElement(marker);
                if (!selected) {
                    return;
                }
                setActiveCommentStableKey(selected.stableKey);
                pulseCommentIndicator(selected.stableKey);
                emitAnnotationContextMenu(buildAnnotationContextMenuPayload(selected, event.clientX, event.clientY));
            });
            target.append(marker);
        }

        marker.dataset.commentStableKey = summary?.stableKey ?? stableKeys[0] ?? '';
        marker.dataset.commentStableKeys = serializeStableKeysAttr(stableKeys);
        marker.dataset.annotationId = summary?.annotationId ?? '';
        marker.dataset.pageNumber = summary ? String(summary.pageNumber) : '';
        marker.dataset.commentCount = String(stableKeys.length);
        marker.classList.toggle('is-active', stableKeys.some(stableKey => isCommentActive(stableKey)));
        marker.classList.toggle('is-cluster', stableKeys.length > 1);
        marker.setAttribute('aria-label', stableKeys.length > 1 ? `Open pop-up note (${stableKeys.length} notes)` : 'Open pop-up note');
        marker.setAttribute('title', preview);
        target.setAttribute('title', preview);
    }

    function markInlineCommentTargetWithKey(
        target: HTMLElement,
        text: string,
        stableKey: string,
        markerOptions: { anchor?: boolean } = {},
    ) {
        markInlineCommentTarget(target, text);
        const nextStableKeys = Array.from(new Set([
            ...getInlineTargetStableKeys(target),
            stableKey,
        ]));
        setInlineTargetStableKeys(target, nextStableKeys);

        const activeKey = activeCommentStableKey.value;
        const activeInTarget = Boolean(activeKey && nextStableKeys.includes(activeKey));
        const preferredStableKey = activeInTarget
            ? (activeKey as string)
            : (target.getAttribute('data-comment-stable-key') || stableKey);
        target.setAttribute('data-comment-stable-key', preferredStableKey);

        if (markerOptions.anchor === true) {
            target.classList.add('pdf-annotation-has-note-anchor');
            upsertInlineCommentAnchorMarker(target, nextStableKeys, text);
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

    function pickInlineCommentAnchorTarget(targets: HTMLElement[]) {
        if (targets.length === 0) {
            return null;
        }
        return targets
            .slice()
            .sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                if (leftRect.top !== rightRect.top) {
                    return leftRect.top - rightRect.top;
                }
                if (leftRect.right !== rightRect.right) {
                    return rightRect.right - leftRect.right;
                }
                return leftRect.left - rightRect.left;
            })[0] ?? null;
    }

    function markerRectToPagePixels(pageContainer: HTMLElement, markerRect: IAnnotationMarkerRect) {
        const width = pageContainer.clientWidth;
        const height = pageContainer.clientHeight;
        if (width <= 0 || height <= 0) {
            return null;
        }
        return {
            left: markerRect.left * width,
            top: markerRect.top * height,
            right: (markerRect.left + markerRect.width) * width,
            bottom: (markerRect.top + markerRect.height) * height,
        };
    }

    function rectsIntersectLocal(
        leftRect: {
            left: number;
            top: number;
            right: number;
            bottom: number 
        },
        rightRect: {
            left: number;
            top: number;
            right: number;
            bottom: number 
        },
    ) {
        return !(
            leftRect.right < rightRect.left
            || leftRect.left > rightRect.right
            || leftRect.bottom < rightRect.top
            || leftRect.top > rightRect.bottom
        );
    }

    function markInlineCommentTargetsFromTextLayer(
        pageContainer: HTMLElement,
        comment: IAnnotationCommentSummary,
    ) {
        const markerRect = normalizeMarkerRect(comment.markerRect);
        if (!markerRect) {
            return false;
        }
        const markerPx = markerRectToPagePixels(pageContainer, markerRect);
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
                return rectsIntersectLocal(spanBounds, markerBounds);
            });

        if (textSpans.length === 0) {
            return false;
        }

        const anchor = pickInlineCommentAnchorTarget(textSpans);
        textSpans.forEach((target) => {
            markInlineCommentTargetWithKey(
                target,
                comment.text,
                comment.stableKey,
                { anchor: target === anchor },
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
        const priorityDelta = identity.commentMergePriority(candidate) - identity.commentMergePriority(existing);
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

    function createDetachedCommentClusterMarkerElement(
        comments: IAnnotationCommentSummary[],
        placement: IDetachedMarkerPlacement,
    ) {
        const primaryComment = pickPrimaryDetachedComment(comments);
        if (!primaryComment) {
            return null;
        }
        const noteCount = comments.length;
        const trimmedPreview = commentPreviewText(primaryComment);
        const preview = noteCount > 1
            ? `${trimmedPreview} (+${noteCount - 1} more note${noteCount > 2 ? 's' : ''})`
            : trimmedPreview;

        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'pdf-inline-comment-marker';
        if (comments.some(candidate => isCommentActive(candidate.stableKey))) {
            marker.classList.add('is-active');
        }
        if (noteCount > 1) {
            marker.classList.add('is-cluster');
            marker.dataset.commentCount = String(noteCount);
        }
        marker.dataset.commentStableKey = primaryComment.stableKey;
        marker.dataset.commentStableKeys = serializeStableKeysAttr(comments.map(comment => comment.stableKey));
        marker.dataset.annotationId = primaryComment.annotationId ?? '';
        marker.dataset.pageNumber = String(primaryComment.pageNumber);
        marker.style.left = `${placement.leftPercent}%`;
        marker.style.top = `${placement.topPercent}%`;
        marker.title = preview;
        marker.setAttribute(
            'aria-label',
            noteCount > 1
                ? `Open pop-up note (${noteCount} notes)`
                : 'Open pop-up note',
        );
        marker.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const summary = resolveCommentFromIndicatorElement(marker);
            if (summary) {
                setActiveCommentStableKey(summary.stableKey);
                pulseCommentIndicator(summary.stableKey);
                emitAnnotationOpenNote(summary);
            }
        });
        marker.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const summary = resolveCommentFromIndicatorElement(marker);
            if (summary) {
                setActiveCommentStableKey(summary.stableKey);
                pulseCommentIndicator(summary.stableKey);
                emitAnnotationContextMenu(buildAnnotationContextMenuPayload(summary, event.clientX, event.clientY));
            }
        });
        return marker;
    }

    function clusterDetachedComments(comments: IAnnotationCommentSummary[]) {
        const clusters: IDetachedCommentCluster[] = [];
        comments
            .slice()
            .sort((left, right) => {
                const leftRect = normalizeMarkerRect(left.markerRect);
                const rightRect = normalizeMarkerRect(right.markerRect);
                if (!leftRect || !rightRect) {
                    return left.stableKey.localeCompare(right.stableKey);
                }
                if (leftRect.top !== rightRect.top) {
                    return leftRect.top - rightRect.top;
                }
                if (leftRect.left !== rightRect.left) {
                    return leftRect.left - rightRect.left;
                }
                return left.stableKey.localeCompare(right.stableKey);
            })
            .forEach((comment) => {
                const rect = normalizeMarkerRect(comment.markerRect);
                if (!rect) {
                    return;
                }
                const candidate = clusters.find((cluster) => {
                    const iou = markerRectIoU(cluster.anchorRect, rect);
                    if (iou >= 0.22) {
                        return true;
                    }
                    const clusterCenterX = cluster.anchorRect.left + cluster.anchorRect.width / 2;
                    const clusterCenterY = cluster.anchorRect.top + cluster.anchorRect.height / 2;
                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;
                    const dx = Math.abs(clusterCenterX - centerX);
                    const dy = Math.abs(clusterCenterY - centerY);
                    return dx <= 0.028 && dy <= 0.028;
                });
                if (candidate) {
                    candidate.comments.push(comment);
                    candidate.anchorRect = mergeMarkerRects(candidate.anchorRect, rect);
                    return;
                }
                clusters.push({
                    anchorRect: rect,
                    comments: [comment],
                });
            });
        return clusters;
    }

    function resolveDetachedMarkerPlacement(
        pageContainer: HTMLElement,
        markerRect: IAnnotationMarkerRect,
        occupied: IDetachedMarkerOccupied[],
    ) {
        const width = pageContainer.clientWidth;
        const height = pageContainer.clientHeight;
        if (width <= 0 || height <= 0) {
            return {
                leftPercent: Math.max(1, Math.min(99, (markerRect.left + markerRect.width) * 100)),
                topPercent: Math.max(1, Math.min(99, markerRect.top * 100)),
            };
        }

        const baseX = (markerRect.left + markerRect.width) * width;
        const baseY = markerRect.top * height;
        const markerRadius = 10;
        const minDistanceSquared = 24 * 24;
        let bestFallback: IDetachedMarkerFallback | null = null;

        for (const offset of DETACHED_MARKER_OFFSETS) {
            const x = Math.min(width - markerRadius, Math.max(markerRadius, baseX + offset.x));
            const y = Math.min(height - markerRadius, Math.max(markerRadius, baseY + offset.y));
            const minDistance = occupied.reduce((min, point) => {
                const dx = point.x - x;
                const dy = point.y - y;
                const distanceSquared = dx * dx + dy * dy;
                return Math.min(min, distanceSquared);
            }, Number.POSITIVE_INFINITY);

            if (minDistance >= minDistanceSquared || occupied.length === 0) {
                occupied.push({
                    x,
                    y, 
                });
                return {
                    leftPercent: (x / width) * 100,
                    topPercent: (y / height) * 100,
                };
            }

            if (!bestFallback || minDistance > bestFallback.minDistanceSquared) {
                bestFallback = {
                    x,
                    y,
                    minDistanceSquared: minDistance, 
                };
            }
        }

        const fallbackX = bestFallback?.x ?? Math.min(width - markerRadius, Math.max(markerRadius, baseX));
        const fallbackY = bestFallback?.y ?? Math.min(height - markerRadius, Math.max(markerRadius, baseY));
        occupied.push({
            x: fallbackX,
            y: fallbackY, 
        });
        return {
            leftPercent: (fallbackX / width) * 100,
            topPercent: (fallbackY / height) * 100,
        };
    }

    function renderDetachedCommentMarkers(pageContainer: HTMLElement, comments: IAnnotationCommentSummary[]) {
        const layer = ensureCommentMarkerLayer(pageContainer);
        const occupied: IDetachedMarkerOccupied[] = [];
        const clusters = clusterDetachedComments(comments);
        clusters.forEach((cluster) => {
            const placement = resolveDetachedMarkerPlacement(pageContainer, cluster.anchorRect, occupied);
            const marker = createDetachedCommentClusterMarkerElement(cluster.comments, placement);
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
            const logicalKey = commentLogicalIndicatorKey(comment);
            const existing = dedupedCommentsByLogicalKey.get(logicalKey);
            if (!existing) {
                dedupedCommentsByLogicalKey.set(logicalKey, comment);
                return;
            }
            dedupedCommentsByLogicalKey.set(
                logicalKey,
                pickPreferredIndicatorComment(existing, comment),
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
                        markInlineCommentTargetWithKey(normalizedEditor.div, summary.text, summary.stableKey, { anchor: true });
                        handledLogicalCommentKeys.add(commentLogicalIndicatorKey(summary));
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
            const anchor = pickInlineCommentAnchorTarget(targets);
            let marked = false;
            targets.forEach((target) => {
                marked = true;
                markInlineCommentTargetWithKey(target, comment.text, comment.stableKey, { anchor: target === anchor });
            });
            if (marked) {
                handledLogicalCommentKeys.add(commentLogicalIndicatorKey(comment));
            }
        });

        const detachedCommentsByPage = new Map<number, IAnnotationCommentSummary[]>();
        const detachedGroupSeen = new Set<string>();
        dedupedComments.forEach((comment) => {
            const logicalKey = commentLogicalIndicatorKey(comment);
            if (handledLogicalCommentKeys.has(logicalKey)) {
                return;
            }

            const pageContainer = container.querySelector<HTMLElement>(`.page_container[data-page="${comment.pageNumber}"]`);
            if (pageContainer && markInlineCommentTargetsFromTextLayer(pageContainer, comment)) {
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
        pulseCommentIndicator,
        resolveCommentFromIndicatorElement,
        resolveCommentFromIndicatorClickTarget,
        findCommentFromInlineTarget,
        pickBestCommentFromStableKeys,
        cleanup,
    };
}
