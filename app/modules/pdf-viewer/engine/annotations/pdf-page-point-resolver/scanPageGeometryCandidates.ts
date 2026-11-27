import {parsePageNumber} from '@contracts/pageNumbers';
import type {
    IGeometryResolution,
    IPageCandidateLogEntry,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/pdfPagePointResolverTypes';

const MAX_PAGE_CANDIDATE_LOG_ENTRIES = 14;

interface IPageGeometryCandidate {
    element: HTMLElement;
    rect: DOMRect;
    inside: boolean;
    distanceSquared: number;
}

function roundForLog(value: number, digits = 3) {
    if (!Number.isFinite(value)) {
        return value;
    }
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function toRectLog(
    rect:
        | DOMRect
        | {
              left: number;
              top: number;
              right: number;
              bottom: number;
              width: number;
              height: number;
          },
) {
    return {
        left: roundForLog(rect.left),
        top: roundForLog(rect.top),
        right: roundForLog(rect.right),
        bottom: roundForLog(rect.bottom),
        width: roundForLog(rect.width),
        height: roundForLog(rect.height),
    };
}

function isPointInsideRect(clientX: number, clientY: number, rect: DOMRect) {
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function squaredDistanceToRect(clientX: number, clientY: number, rect: DOMRect) {
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    return dx * dx + dy * dy;
}

function measurePageGeometryCandidate(element: HTMLElement, clientX: number, clientY: number): IPageGeometryCandidate | null {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        element,
        rect,
        inside: isPointInsideRect(clientX, clientY, rect),
        distanceSquared: squaredDistanceToRect(clientX, clientY, rect),
    };
}

function parsePageNumberFromContainer(pageContainer: HTMLElement | null) {
    if (!pageContainer?.dataset.page) {
        return null;
    }
    return parsePageNumber(Number(pageContainer.dataset.page));
}

function toPageCandidateLogEntry(candidate: IPageGeometryCandidate): IPageCandidateLogEntry {
    return {
        pageNumber: parsePageNumberFromContainer(candidate.element),
        inside: candidate.inside,
        distanceSquared: roundForLog(candidate.distanceSquared),
        rect: toRectLog(candidate.rect),
    };
}

function createEmptyGeometryResolution(collectCandidates: boolean): IGeometryResolution {
    return {
        pageContainer: null,
        source: 'none',
        candidates: collectCandidates ? [] : null,
    };
}

function createGeometryResolution(
    candidate: IPageGeometryCandidate,
    source: IGeometryResolution['source'],
    candidates: IPageCandidateLogEntry[],
    collectCandidates: boolean,
): IGeometryResolution {
    return {
        pageContainer: candidate.element,
        source,
        candidates: collectCandidates ? candidates : null,
    };
}

function addGeometryCandidateLogEntry(candidate: IPageGeometryCandidate, candidates: IPageCandidateLogEntry[], collectCandidates: boolean) {
    if (collectCandidates && candidates.length < MAX_PAGE_CANDIDATE_LOG_ENTRIES) {
        candidates.push(toPageCandidateLogEntry(candidate));
    }
}

function chooseFinalGeometryResolution(
    insideMatch: IPageGeometryCandidate | null,
    nearest: IPageGeometryCandidate | null,
    candidates: IPageCandidateLogEntry[],
    collectCandidates: boolean,
) {
    if (insideMatch) {
        return createGeometryResolution(insideMatch, 'inside', candidates, collectCandidates);
    }
    if (nearest) {
        return createGeometryResolution(nearest, 'nearest', candidates, collectCandidates);
    }
    return createEmptyGeometryResolution(collectCandidates);
}

export function scanPageGeometryCandidates(
    pages: HTMLElement[],
    clientX: number,
    clientY: number,
    collectCandidates: boolean,
): IGeometryResolution | null {
    let nearest: IPageGeometryCandidate | null = null;
    let insideMatch: IPageGeometryCandidate | null = null;
    const candidates: IPageCandidateLogEntry[] = [];

    for (const element of pages) {
        const candidate = measurePageGeometryCandidate(element, clientX, clientY);
        if (!candidate) {
            continue;
        }
        addGeometryCandidateLogEntry(candidate, candidates, collectCandidates);
        if (candidate.inside && !collectCandidates) {
            return createGeometryResolution(candidate, 'inside', candidates, collectCandidates);
        }
        if (candidate.inside && !insideMatch) {
            insideMatch = candidate;
        }
        if (!nearest || candidate.distanceSquared < nearest.distanceSquared) {
            nearest = candidate;
        }
    }

    return chooseFinalGeometryResolution(insideMatch, nearest, candidates, collectCandidates);
}
