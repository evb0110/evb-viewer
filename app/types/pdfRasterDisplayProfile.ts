import type {TDocumentRef} from '@contracts/documentRef';

export interface IPdfRasterSourcePagePixels {
    width: number;
    height: number;
}

export interface ITrustedRasterDjvuPdfDisplayProfile {
    kind: 'trusted-raster-djvu';
    sourcePagePixels: ReadonlyArray<IPdfRasterSourcePagePixels | null>;
}

export type TPdfRasterDisplayProfile = ITrustedRasterDjvuPdfDisplayProfile;

export interface IPdfRasterDisplayProfileOpenOptions {
    rasterDisplayProfile?: TPdfRasterDisplayProfile | null | undefined;
}

const registeredRasterDisplayProfiles = new Map<TDocumentRef, TPdfRasterDisplayProfile>();
const MAX_REGISTERED_RASTER_DISPLAY_PROFILES = 64;

function normalizePositivePixelDimension(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : null;
}

export function normalizePdfRasterSourcePagePixels(value: {width?: unknown; height?: unknown}): IPdfRasterSourcePagePixels | null {
    const width = normalizePositivePixelDimension(value.width);
    const height = normalizePositivePixelDimension(value.height);
    if (width === null || height === null) {
        return null;
    }
    return {
        width,
        height,
    };
}

export function resolvePdfRasterSourceMaxPixels(profile: TPdfRasterDisplayProfile | null | undefined, pageNumber: number) {
    if (!profile) {
        return null;
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        return null;
    }

    const pagePixels = normalizePdfRasterSourcePagePixels(profile.sourcePagePixels[pageNumber - 1] ?? {});
    return pagePixels ? pagePixels.width * pagePixels.height : null;
}

export function registerPdfRasterDisplayProfile(
    documentRef: TDocumentRef | null | undefined,
    profile: TPdfRasterDisplayProfile | null | undefined,
) {
    if (!documentRef || !profile) {
        return;
    }
    registeredRasterDisplayProfiles.delete(documentRef);
    registeredRasterDisplayProfiles.set(documentRef, profile);
    while (registeredRasterDisplayProfiles.size > MAX_REGISTERED_RASTER_DISPLAY_PROFILES) {
        const oldestRef = registeredRasterDisplayProfiles.keys().next().value;
        if (typeof oldestRef !== 'string') {
            break;
        }
        registeredRasterDisplayProfiles.delete(oldestRef);
    }
}

export function consumeRegisteredPdfRasterDisplayProfile(
    ...documentRefs: Array<TDocumentRef | null | undefined>
): TPdfRasterDisplayProfile | null {
    let resolvedProfile: TPdfRasterDisplayProfile | null = null;
    for (const documentRef of documentRefs) {
        if (!documentRef) {
            continue;
        }
        const profile = registeredRasterDisplayProfiles.get(documentRef);
        registeredRasterDisplayProfiles.delete(documentRef);
        if (!resolvedProfile && profile) {
            resolvedProfile = profile;
        }
    }
    return resolvedProfile;
}

export function unregisterPdfRasterDisplayProfiles(...documentRefs: Array<TDocumentRef | null | undefined>) {
    for (const documentRef of documentRefs) {
        if (documentRef) {
            registeredRasterDisplayProfiles.delete(documentRef);
        }
    }
}

export function getRegisteredPdfRasterDisplayProfileCountForTests() {
    return registeredRasterDisplayProfiles.size;
}

export function clearRegisteredPdfRasterDisplayProfilesForTests() {
    registeredRasterDisplayProfiles.clear();
}
