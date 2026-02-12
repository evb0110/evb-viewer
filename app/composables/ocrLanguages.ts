export type TOcrPageRange = 'all' | 'current' | 'custom';

export interface IOcrSettings {
    pageRange: TOcrPageRange;
    customRange: string;
    selectedLanguages: string[];
}

export interface IOcrProgress {
    isRunning: boolean;
    phase: 'preparing' | 'processing';
    currentPage: number;
    totalPages: number;
    processedCount: number;
}

export interface IOcrQualityMetrics {
    totalWords: number;
    avgConfidence: number;
    lowConfidenceWords: number;
    successRate: number;
    pagesProcessed: number;
    dpiUsed: number;
    estimatedQuality: 'excellent' | 'good' | 'fair' | 'poor';
    recommendedDpi?: number;
    embedSuccess: boolean;
    embedError?: string;
}

export interface IOcrResults {
    pages: Map<number, string>;
    languages: string[];
    completedAt: number | null;
    searchablePdfData: Uint8Array | null;
    metrics?: IOcrQualityMetrics;
}

export function parsePageRange(
    rangeType: TOcrPageRange,
    customRange: string,
    currentPage: number,
    totalPages: number,
): number[] {
    if (rangeType === 'current') {
        return [currentPage];
    }

    if (rangeType === 'all') {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const pages = new Set<number>();
    const parts = customRange.split(',').map(p => p.trim());

    for (const part of parts) {
        if (part.includes('-')) {
            const segments = part.split('-');
            const startStr = segments[0];
            const endStr = segments[1];
            if (startStr && endStr) {
                const start = parseInt(startStr.trim(), 10);
                const end = parseInt(endStr.trim(), 10);
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
                        pages.add(i);
                    }
                }
            }
        } else {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= totalPages) {
                pages.add(num);
            }
        }
    }

    return Array.from(pages).sort((a, b) => a - b);
}
