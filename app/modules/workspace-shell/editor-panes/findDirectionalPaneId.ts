import type {IEditorPaneRect, TEditorLayoutNode, TPaneDirection} from '@contracts/editorPanes';
import {orderBy} from 'es-toolkit/array';
import {clamp} from 'es-toolkit/math';

const DIRECTIONAL_PANE_MIN_SPLIT_RATIO = 0.1;

interface IFindDirectionalPaneIdParams {
    layout: TEditorLayoutNode | null;
    sourcePaneId: string;
    direction: TPaneDirection;
    paneMru: string[];
    wrap?: boolean;
}

function collectPaneRects(node: TEditorLayoutNode, x: number, y: number, width: number, height: number, target: IEditorPaneRect[]) {
    if (node.type === 'leaf') {
        target.push({
            paneId: node.paneId,
            x,
            y,
            widthPx: width,
            heightPx: height,
        });
        return;
    }

    const ratio = clamp(node.ratio, DIRECTIONAL_PANE_MIN_SPLIT_RATIO, 1 - DIRECTIONAL_PANE_MIN_SPLIT_RATIO);
    if (node.orientation === 'horizontal') {
        const firstWidth = width * ratio;
        const secondWidth = width - firstWidth;
        collectPaneRects(node.first, x, y, firstWidth, height, target);
        collectPaneRects(node.second, x + firstWidth, y, secondWidth, height, target);
        return;
    }

    const firstHeight = height * ratio;
    const secondHeight = height - firstHeight;
    collectPaneRects(node.first, x, y, width, firstHeight, target);
    collectPaneRects(node.second, x, y + firstHeight, width, secondHeight, target);
}

function getPaneRects(layout: TEditorLayoutNode | null) {
    if (!layout) {
        return [];
    }

    const rects: IEditorPaneRect[] = [];
    collectPaneRects(layout, 0, 0, 1, 1, rects);
    return rects;
}

function overlapAmount(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function getMruRank(paneMru: string[], paneId: string) {
    const index = paneMru.indexOf(paneId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function findDirectionalPaneId({layout, sourcePaneId, direction, paneMru, wrap = true}: IFindDirectionalPaneIdParams) {
    const rects = getPaneRects(layout);
    const sourceRect = rects.find((rect) => rect.paneId === sourcePaneId);
    if (!sourceRect) {
        return null;
    }

    interface IScore {
        paneId: string;
        distance: number;
        overlap: number;
        mruRank: number;
    }

    const candidates: IScore[] = [];
    for (const rect of rects) {
        if (rect.paneId === sourcePaneId) {
            continue;
        }

        let distance = Number.MAX_VALUE;
        let overlap = 0;

        if (direction === 'right') {
            if (rect.x >= sourceRect.x + sourceRect.widthPx - 1e-6) {
                distance = rect.x - (sourceRect.x + sourceRect.widthPx);
                overlap = overlapAmount(sourceRect.y, sourceRect.y + sourceRect.heightPx, rect.y, rect.y + rect.heightPx);
            }
        } else if (direction === 'left') {
            if (rect.x + rect.widthPx <= sourceRect.x + 1e-6) {
                distance = sourceRect.x - (rect.x + rect.widthPx);
                overlap = overlapAmount(sourceRect.y, sourceRect.y + sourceRect.heightPx, rect.y, rect.y + rect.heightPx);
            }
        } else if (direction === 'down') {
            if (rect.y >= sourceRect.y + sourceRect.heightPx - 1e-6) {
                distance = rect.y - (sourceRect.y + sourceRect.heightPx);
                overlap = overlapAmount(sourceRect.x, sourceRect.x + sourceRect.widthPx, rect.x, rect.x + rect.widthPx);
            }
        } else if (rect.y + rect.heightPx <= sourceRect.y + 1e-6) {
            distance = sourceRect.y - (rect.y + rect.heightPx);
            overlap = overlapAmount(sourceRect.x, sourceRect.x + sourceRect.widthPx, rect.x, rect.x + rect.widthPx);
        }

        if (distance !== Number.MAX_VALUE) {
            candidates.push({
                paneId: rect.paneId,
                distance,
                overlap,
                mruRank: getMruRank(paneMru, rect.paneId),
            });
        }
    }

    if (candidates.length > 0) {
        const sortedCandidates = orderBy(
            candidates,
            [(candidate) => candidate.distance, (candidate) => candidate.overlap, (candidate) => candidate.mruRank],
            ['asc', 'desc', 'asc'],
        );
        return sortedCandidates[0]?.paneId ?? null;
    }

    if (!wrap) {
        return null;
    }

    const wrapCandidates = rects
        .filter((rect) => rect.paneId !== sourcePaneId)
        .map((rect) => {
            let anchor = 0;
            let overlap = 0;

            if (direction === 'right') {
                anchor = rect.x;
                overlap = overlapAmount(sourceRect.y, sourceRect.y + sourceRect.heightPx, rect.y, rect.y + rect.heightPx);
            } else if (direction === 'left') {
                anchor = rect.x + rect.widthPx;
                overlap = overlapAmount(sourceRect.y, sourceRect.y + sourceRect.heightPx, rect.y, rect.y + rect.heightPx);
            } else if (direction === 'down') {
                anchor = rect.y;
                overlap = overlapAmount(sourceRect.x, sourceRect.x + sourceRect.widthPx, rect.x, rect.x + rect.widthPx);
            } else {
                anchor = rect.y + rect.heightPx;
                overlap = overlapAmount(sourceRect.x, sourceRect.x + sourceRect.widthPx, rect.x, rect.x + rect.widthPx);
            }

            return {
                paneId: rect.paneId,
                anchor,
                overlap,
                mruRank: getMruRank(paneMru, rect.paneId),
            };
        });

    const anchorOrder: 'asc' | 'desc' = direction === 'right' || direction === 'down' ? 'asc' : 'desc';
    const sortedWrapCandidates = orderBy(
        wrapCandidates,
        [(candidate) => candidate.anchor, (candidate) => candidate.overlap, (candidate) => candidate.mruRank],
        [anchorOrder, 'desc', 'asc'],
    );

    return sortedWrapCandidates[0]?.paneId ?? null;
}
