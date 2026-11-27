import type {IScanCleanupNormalizedZonePoint} from '@contracts/scan-cleanup/domain';

const COORDINATE_EPSILON = 1e-9;
const AREA_TWICE_EPSILON = 1e-12;

function cross(start: IScanCleanupNormalizedZonePoint, end: IScanCleanupNormalizedZonePoint, point: IScanCleanupNormalizedZonePoint) {
    return (
        (end.xNormalized - start.xNormalized) * (point.yNormalized - start.yNormalized) -
        (end.yNormalized - start.yNormalized) * (point.xNormalized - start.xNormalized)
    );
}

function onSegment(start: IScanCleanupNormalizedZonePoint, end: IScanCleanupNormalizedZonePoint, point: IScanCleanupNormalizedZonePoint) {
    return (
        Math.abs(cross(start, end, point)) <= COORDINATE_EPSILON &&
        point.xNormalized >= Math.min(start.xNormalized, end.xNormalized) - COORDINATE_EPSILON &&
        point.xNormalized <= Math.max(start.xNormalized, end.xNormalized) + COORDINATE_EPSILON &&
        point.yNormalized >= Math.min(start.yNormalized, end.yNormalized) - COORDINATE_EPSILON &&
        point.yNormalized <= Math.max(start.yNormalized, end.yNormalized) + COORDINATE_EPSILON
    );
}

function segmentsIntersect(
    a: IScanCleanupNormalizedZonePoint,
    b: IScanCleanupNormalizedZonePoint,
    c: IScanCleanupNormalizedZonePoint,
    d: IScanCleanupNormalizedZonePoint,
) {
    const abC = cross(a, b, c);
    const abD = cross(a, b, d);
    const cdA = cross(c, d, a);
    const cdB = cross(c, d, b);
    if (
        ((abC > COORDINATE_EPSILON && abD < -COORDINATE_EPSILON) || (abC < -COORDINATE_EPSILON && abD > COORDINATE_EPSILON)) &&
        ((cdA > COORDINATE_EPSILON && cdB < -COORDINATE_EPSILON) || (cdA < -COORDINATE_EPSILON && cdB > COORDINATE_EPSILON))
    ) {
        return true;
    }
    return (
        (Math.abs(abC) <= COORDINATE_EPSILON && onSegment(a, b, c)) ||
        (Math.abs(abD) <= COORDINATE_EPSILON && onSegment(a, b, d)) ||
        (Math.abs(cdA) <= COORDINATE_EPSILON && onSegment(c, d, a)) ||
        (Math.abs(cdB) <= COORDINATE_EPSILON && onSegment(c, d, b))
    );
}

interface IScanCleanupPolygonEdge {
    start: IScanCleanupNormalizedZonePoint;
    end: IScanCleanupNormalizedZonePoint;
}

function polygonEdges(points: readonly IScanCleanupNormalizedZonePoint[]) {
    const [first, ...rest] = points;
    if (first === undefined) {
        return [];
    }
    const edges: IScanCleanupPolygonEdge[] = [];
    let start = first;
    for (const end of rest) {
        edges.push({
            start,
            end,
        });
        start = end;
    }
    edges.push({
        start,
        end: first,
    });
    return edges;
}

function findScanCleanupSimplePolygonError(points: readonly IScanCleanupNormalizedZonePoint[]) {
    for (const [left, leftPoint] of points.entries()) {
        for (const rightPoint of points.slice(left + 1)) {
            const dx = leftPoint.xNormalized - rightPoint.xNormalized;
            const dy = leftPoint.yNormalized - rightPoint.yNormalized;
            if (dx * dx + dy * dy <= COORDINATE_EPSILON * COORDINATE_EPSILON) {
                return 'contains duplicate vertices';
            }
        }
    }

    const edges = polygonEdges(points);
    let twiceArea = 0;
    for (const {start, end} of edges) {
        twiceArea += start.xNormalized * end.yNormalized - end.xNormalized * start.yNormalized;
    }
    if (Math.abs(twiceArea) <= AREA_TWICE_EPSILON) {
        return 'has near-zero area';
    }

    for (const [left, leftEdge] of edges.entries()) {
        for (const [offset, rightEdge] of edges.slice(left + 2).entries()) {
            const right = left + 2 + offset;
            if (left === 0 && right === edges.length - 1) {
                continue;
            }
            if (segmentsIntersect(leftEdge.start, leftEdge.end, rightEdge.start, rightEdge.end)) {
                return 'has intersecting or overlapping edges';
            }
        }
    }
    return null;
}

export function assertSimpleScanCleanupPolygon(points: readonly IScanCleanupNormalizedZonePoint[], label: string) {
    const error = findScanCleanupSimplePolygonError(points);
    if (error !== null) {
        throw new Error(`invalid scan-cleanup ${label}: ${error}`);
    }
}
