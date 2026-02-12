import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import {
    normalizeMarkerRect,
    markerRectIoU,
    mergeMarkerRects,
} from '@app/composables/pdf/pdfAnnotationUtils';

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

export const useCommentMarkerPositioning = () => {
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
    ): IDetachedMarkerPlacement {
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

    return {
        markerRectToPagePixels,
        rectsIntersectLocal,
        pickInlineCommentAnchorTarget,
        clusterDetachedComments,
        resolveDetachedMarkerPlacement,
    };
};

export type {
    IDetachedMarkerPlacement, IDetachedCommentCluster, IDetachedMarkerOccupied, 
};
