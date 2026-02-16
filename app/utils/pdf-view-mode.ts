import type { TPdfViewMode } from '@app/types/shared';

export type TSpreadStepDirection = -1 | 1;

function getLastSpreadStartPage(viewMode: TPdfViewMode, totalPages: number): number {
    if (totalPages <= 1 || viewMode === 'single') {
        return Math.max(1, totalPages);
    }

    if (viewMode === 'facing') {
        return totalPages % 2 === 0 ? Math.max(1, totalPages - 1) : totalPages;
    }

    if (totalPages <= 2) {
        return totalPages;
    }
    return totalPages % 2 === 0 ? totalPages : totalPages - 1;
}

export function getViewColumnCount(
    viewMode: TPdfViewMode,
    totalPages: number,
): 1 | 2 {
    if (viewMode === 'single' || totalPages <= 1) {
        return 1;
    }
    return 2;
}

export function isStandaloneSpreadPage(
    page: number,
    viewMode: TPdfViewMode,
    totalPages: number,
): boolean {
    if (page < 1 || page > totalPages) {
        return false;
    }

    if (viewMode === 'facing' && totalPages === 1) {
        return page === 1;
    }

    if (viewMode !== 'facing-first-single') {
        return false;
    }

    if (page === 1) {
        return true;
    }

    return totalPages > 1 && totalPages % 2 === 0 && page === totalPages;
}

export function getSpreadStartForPage(
    page: number,
    viewMode: TPdfViewMode,
    totalPages: number,
): number {
    const clampedPage = Math.max(1, Math.min(page, Math.max(1, totalPages)));
    if (viewMode === 'single' || totalPages <= 1) {
        return clampedPage;
    }

    if (viewMode === 'facing') {
        return clampedPage % 2 === 0 ? clampedPage - 1 : clampedPage;
    }

    if (clampedPage === 1) {
        return 1;
    }
    if (totalPages % 2 === 0 && clampedPage === totalPages) {
        return totalPages;
    }
    return clampedPage % 2 === 0 ? clampedPage : clampedPage - 1;
}

export function stepBySpread(
    page: number,
    viewMode: TPdfViewMode,
    totalPages: number,
    direction: TSpreadStepDirection,
    steps = 1,
): number {
    const stepCount = Math.max(1, steps);
    let spreadStart = getSpreadStartForPage(page, viewMode, totalPages);
    const minStart = 1;
    const maxStart = getLastSpreadStartPage(viewMode, totalPages);

    for (let i = 0; i < stepCount; i += 1) {
        const previous = spreadStart;

        if (viewMode === 'single') {
            spreadStart = Math.max(minStart, Math.min(maxStart, spreadStart + direction));
        } else if (viewMode === 'facing') {
            spreadStart = Math.max(minStart, Math.min(maxStart, spreadStart + direction * 2));
        } else if (direction > 0) {
            spreadStart = spreadStart === 1 ? 2 : spreadStart + 2;
            spreadStart = Math.max(minStart, Math.min(maxStart, spreadStart));
        } else {
            if (spreadStart === 2) {
                spreadStart = 1;
            } else {
                spreadStart = spreadStart - 2;
            }
            spreadStart = Math.max(minStart, Math.min(maxStart, spreadStart));
        }

        if (spreadStart === previous) {
            break;
        }
    }

    return spreadStart;
}
