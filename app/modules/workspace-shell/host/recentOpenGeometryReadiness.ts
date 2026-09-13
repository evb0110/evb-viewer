import { readPrevalidatedTrustedPdfOpenGeometry } from '@app/modules/pdf-viewer/public/openGeometry';
import { readPrevalidatedTrustedDjvuOpenGeometry } from '@app/modules/djvu-viewer/public/openGeometry';
import { requirePageNumber } from '@contracts/pageNumbers';

export type TRecentOpenGeometryState = 'pending' | 'ready' | 'cold-fallback';

const states = shallowRef<ReadonlyMap<string, TRecentOpenGeometryState>>(new Map());
const exactGeometryFingerprints = new Map<string, string>();

function writeState(path: string, state: TRecentOpenGeometryState) {
    const next = new Map(states.value);
    next.set(path, state);
    states.value = next;
}

/**
 * Marks the bounded paths being prepared. Geometry readiness is diagnostic:
 * opening a Recent file remains a valid command even on the cold path.
 */
export function beginRecentOpenGeometryPrewarm(paths: Iterable<string>) {
    for (const path of paths) {
        exactGeometryFingerprints.delete(path);
        writeState(path, 'pending');
    }
}

function readCachedExactGeometry(path: string, sourceRevision?: {
    modifiedAt: number | undefined;
    size: number | undefined;
}) {
    if (/\.pdf$/iu.test(path)) {
        return readPrevalidatedTrustedPdfOpenGeometry(path, requirePageNumber(1));
    }
    if (/\.djvu?$/iu.test(path)) {
        return sourceRevision?.size !== undefined && sourceRevision.modifiedAt !== undefined
            ? readPrevalidatedTrustedDjvuOpenGeometry(path, 1, {
                size: sourceRevision.size,
                modifiedAt: sourceRevision.modifiedAt,
            })
            : null;
    }
    return null;
}

type TRecentOpenGeometry = NonNullable<ReturnType<typeof readCachedExactGeometry>>;

function getGeometryFingerprint(geometry: NonNullable<ReturnType<typeof readCachedExactGeometry>>) {
    return [
        geometry.documentId,
        geometry.pageNumber,
        geometry.pageCount,
        geometry.width,
        geometry.height,
        geometry.rotation,
        geometry.size,
        geometry.modifiedAt,
    ].join(':');
}

export function settleRecentOpenGeometryPrewarm(
    path: string,
    state: Exclude<TRecentOpenGeometryState, 'pending'>,
    preparedGeometry?: TRecentOpenGeometry | null,
) {
    const geometry = state === 'ready' ? preparedGeometry ?? readCachedExactGeometry(path) : null;
    if (!geometry) {
        exactGeometryFingerprints.delete(path);
        writeState(path, 'cold-fallback');
        return;
    }
    exactGeometryFingerprints.set(path, getGeometryFingerprint(geometry));
    writeState(path, 'ready');
}

export function readRecentOpenExactGeometry(path: string, sourceRevision?: {
    modifiedAt: number | undefined;
    size: number | undefined;
}) {
    if (readRecentOpenGeometryState(path) !== 'ready') {
        return null;
    }
    const geometry = readCachedExactGeometry(path, sourceRevision);
    const preparedFingerprint = exactGeometryFingerprints.get(path);
    if (!geometry || preparedFingerprint !== getGeometryFingerprint(geometry)) {
        return null;
    }
    return sourceRevision && (
        sourceRevision.size !== geometry.size
        || sourceRevision.modifiedAt !== geometry.modifiedAt
    ) ? null : geometry;
}

export function readRecentOpenGeometryState(path: string): TRecentOpenGeometryState {
    return states.value.get(path) ?? 'cold-fallback';
}

export function isRecentOpenGeometryActionable(path: string) {
    return readRecentOpenGeometryState(path) !== 'pending';
}

export function isRecentOpenGeometryExactFrameReady(path: string) {
    return readRecentOpenExactGeometry(path) !== null;
}
