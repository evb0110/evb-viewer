import type {TPdfViewRotation} from '@contracts/shared';

export const PDF_VIEW_ROTATIONS: readonly TPdfViewRotation[] = [0, 90, 180, 270];

export function normalizePdfViewRotation(value: number): TPdfViewRotation {
    const normalized = ((Math.trunc(value) % 360) + 360) % 360;
    return PDF_VIEW_ROTATIONS.includes(normalized as TPdfViewRotation) ? (normalized as TPdfViewRotation) : 0;
}

export function stepPdfViewRotation(rotation: TPdfViewRotation, direction: 'clockwise' | 'counterclockwise'): TPdfViewRotation {
    return normalizePdfViewRotation(rotation + (direction === 'clockwise' ? 90 : 270));
}

export function resolvePdfPageViewportRotation(pageRotation: number | null | undefined, viewRotation: TPdfViewRotation): TPdfViewRotation {
    return normalizePdfViewRotation((pageRotation ?? 0) + viewRotation);
}
