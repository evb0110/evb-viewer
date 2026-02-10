import type {
    IPdfPageLabelRange,
    IPdfPageRange,
    TPageLabelStyle,
} from '@app/types/pdf';

const PAGE_LABEL_STYLE_SET = new Set<TPageLabelStyle>([
    null,
    'D',
    'R',
    'r',
    'A',
    'a',
]);

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function toPositiveInt(value: unknown, fallback: number) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return parsed;
}

function normalizeStyle(style: unknown): TPageLabelStyle {
    if (style === null) {
        return null;
    }
    if (typeof style === 'string' && PAGE_LABEL_STYLE_SET.has(style as TPageLabelStyle)) {
        return style as TPageLabelStyle;
    }
    return 'D';
}

function toRoman(number: number, lowerCase = false) {
    if (number < 1) {
        return '';
    }
    const numerals: Array<[number, string]> = [
        [
            1000,
            'M',
        ],
        [
            900,
            'CM',
        ],
        [
            500,
            'D',
        ],
        [
            400,
            'CD',
        ],
        [
            100,
            'C',
        ],
        [
            90,
            'XC',
        ],
        [
            50,
            'L',
        ],
        [
            40,
            'XL',
        ],
        [
            10,
            'X',
        ],
        [
            9,
            'IX',
        ],
        [
            5,
            'V',
        ],
        [
            4,
            'IV',
        ],
        [
            1,
            'I',
        ],
    ];

    let value = number;
    let result = '';
    for (const [
        decimal,
        roman,
    ] of numerals) {
        while (value >= decimal) {
            result += roman;
            value -= decimal;
        }
    }
    return lowerCase ? result.toLowerCase() : result;
}

function parseRoman(value: string) {
    if (!/^[ivxlcdm]+$/i.test(value)) {
        return null;
    }

    const numerals: Record<string, number> = {
        I: 1,
        V: 5,
        X: 10,
        L: 50,
        C: 100,
        D: 500,
        M: 1000,
    };

    const upper = value.toUpperCase();
    let total = 0;
    for (let index = 0; index < upper.length; index += 1) {
        const current = numerals[upper[index] ?? ''] ?? 0;
        const next = numerals[upper[index + 1] ?? ''] ?? 0;
        total += current < next ? -current : current;
    }

    if (total < 1) {
        return null;
    }

    const canonical = toRoman(total, value === value.toLowerCase());
    return canonical === value ? total : null;
}

function toAlphabetic(number: number, lowerCase = false) {
    if (number < 1) {
        return '';
    }
    const baseCode = lowerCase ? 0x61 : 0x41;
    const letterIndex = (number - 1) % 26;
    const repeatCount = Math.floor((number - 1) / 26) + 1;
    const character = String.fromCharCode(baseCode + letterIndex);
    return character.repeat(repeatCount);
}

function parseAlphabetic(value: string) {
    if (!/^[A-Za-z]+$/.test(value)) {
        return null;
    }
    const normalized = value.toLowerCase();
    if (!/^([a-z])\1*$/.test(normalized)) {
        return null;
    }
    const charCode = normalized.charCodeAt(0);
    const offset = charCode - 0x61;
    if (offset < 0 || offset > 25) {
        return null;
    }
    const repeatCount = normalized.length;
    return ((repeatCount - 1) * 26) + offset + 1;
}

function formatLabelValue(style: TPageLabelStyle, number: number) {
    switch (style) {
        case 'D':
            return String(number);
        case 'R':
            return toRoman(number, false);
        case 'r':
            return toRoman(number, true);
        case 'A':
            return toAlphabetic(number, false);
        case 'a':
            return toAlphabetic(number, true);
        default:
            return '';
    }
}

function getLabelForOffset(range: IPdfPageLabelRange, offset: number) {
    if (range.style === null) {
        return range.prefix;
    }
    const number = Math.max(1, range.startNumber + offset);
    return range.prefix + formatLabelValue(range.style, number);
}

function inferCandidates(label: string): IPdfPageLabelRange[] {
    const candidates: IPdfPageLabelRange[] = [{
        startPage: 1,
        style: null,
        prefix: label,
        startNumber: 1,
    }];

    const decimalMatch = /^(.*?)(\d+)$/.exec(label);
    if (decimalMatch) {
        candidates.push({
            startPage: 1,
            style: 'D',
            prefix: decimalMatch[1] ?? '',
            startNumber: toPositiveInt(decimalMatch[2], 1),
        });
    }

    const romanMatch = /^(.*?)([ivxlcdm]+)$/i.exec(label);
    if (romanMatch) {
        const romanValue = parseRoman(romanMatch[2] ?? '');
        if (romanValue !== null) {
            const suffix = romanMatch[2] ?? '';
            candidates.push({
                startPage: 1,
                style: suffix === suffix.toLowerCase() ? 'r' : 'R',
                prefix: romanMatch[1] ?? '',
                startNumber: romanValue,
            });
        }
    }

    const alphabeticMatch = /^(.*?)([A-Za-z]+)$/.exec(label);
    if (alphabeticMatch) {
        const alphaValue = parseAlphabetic(alphabeticMatch[2] ?? '');
        if (alphaValue !== null) {
            const suffix = alphabeticMatch[2] ?? '';
            candidates.push({
                startPage: 1,
                style: suffix === suffix.toLowerCase() ? 'a' : 'A',
                prefix: alphabeticMatch[1] ?? '',
                startNumber: alphaValue,
            });
        }
    }

    return candidates;
}

export function normalizePageLabelRanges(ranges: IPdfPageLabelRange[], totalPages: number): IPdfPageLabelRange[] {
    if (totalPages <= 0) {
        return [] as IPdfPageLabelRange[];
    }

    const deduped = new Map<number, IPdfPageLabelRange>();

    for (const range of ranges) {
        const startPage = clamp(
            toPositiveInt(range.startPage, 1),
            1,
            totalPages,
        );
        const style = normalizeStyle(range.style);
        const prefix = typeof range.prefix === 'string' ? range.prefix : '';
        const startNumber = toPositiveInt(range.startNumber, 1);

        deduped.set(startPage, {
            startPage,
            style,
            prefix,
            startNumber,
        });
    }

    if (!deduped.has(1)) {
        deduped.set(1, {
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        });
    }

    return Array.from(deduped.values()).sort((left, right) => left.startPage - right.startPage);
}

export function buildPageLabelsFromRanges(totalPages: number, ranges: IPdfPageLabelRange[]): string[] {
    if (totalPages <= 0) {
        return [] as string[];
    }

    const normalizedRanges = normalizePageLabelRanges(ranges, totalPages);
    const labels = new Array<string>(totalPages);
    let rangeIndex = 0;
    let activeRange = normalizedRanges[0] ?? {
        startPage: 1,
        style: 'D' as const,
        prefix: '',
        startNumber: 1,
    };

    for (let page = 1; page <= totalPages; page += 1) {
        while (
            rangeIndex + 1 < normalizedRanges.length
            && (normalizedRanges[rangeIndex + 1]?.startPage ?? totalPages + 1) <= page
        ) {
            rangeIndex += 1;
            activeRange = normalizedRanges[rangeIndex] ?? activeRange;
        }

        const offset = page - activeRange.startPage;
        labels[page - 1] = getLabelForOffset(activeRange, offset);
    }

    return labels;
}

export function derivePageLabelRangesFromLabels(pageLabels: string[] | null, totalPages: number): IPdfPageLabelRange[] {
    if (totalPages <= 0) {
        return [] as IPdfPageLabelRange[];
    }

    if (!pageLabels || pageLabels.length !== totalPages) {
        return [{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }];
    }

    const ranges: IPdfPageLabelRange[] = [];
    let pageIndex = 0;

    while (pageIndex < totalPages) {
        const label = pageLabels[pageIndex] ?? '';
        const candidates = inferCandidates(label);

        let bestRange: IPdfPageLabelRange = candidates[0]!;
        let bestLength = 1;
        let bestPriority = bestRange.style === null ? 0 : 1;

        for (const candidate of candidates) {
            let length = 1;
            while (pageIndex + length < totalPages) {
                const actual = pageLabels[pageIndex + length] ?? '';
                const expected = getLabelForOffset(candidate, length);
                if (actual !== expected) {
                    break;
                }
                length += 1;
            }

            const priority = candidate.style === null ? 0 : 1;
            if (length > bestLength || (length === bestLength && priority > bestPriority)) {
                bestRange = candidate;
                bestLength = length;
                bestPriority = priority;
            }
        }

        ranges.push({
            ...bestRange,
            startPage: pageIndex + 1,
        });
        pageIndex += bestLength;
    }

    return normalizePageLabelRanges(ranges, totalPages);
}

export function findPageByPageLabelInput(input: string, totalPages: number, pageLabels: string[] | null): number | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return null;
    }

    if (/^\d+$/.test(trimmed)) {
        const page = Number.parseInt(trimmed, 10);
        if (Number.isFinite(page) && page >= 1 && page <= totalPages) {
            return page;
        }
    }

    if (!pageLabels || pageLabels.length !== totalPages) {
        return null;
    }

    const exactIndex = pageLabels.findIndex(label => label === trimmed);
    if (exactIndex >= 0) {
        return exactIndex + 1;
    }

    const lowered = trimmed.toLowerCase();
    const caseInsensitiveIndex = pageLabels.findIndex(label => label.toLowerCase() === lowered);
    if (caseInsensitiveIndex >= 0) {
        return caseInsensitiveIndex + 1;
    }

    return null;
}

export function getVisiblePageLabel(page: number, pageLabels: string[] | null): string | null {
    const rawLabel = pageLabels?.[page - 1] ?? '';
    const label = rawLabel.trim();
    if (!label) {
        return null;
    }
    return label;
}

export function formatPageIndicator(page: number, pageLabels: string[] | null): string {
    const logical = getVisiblePageLabel(page, pageLabels);
    if (!logical || logical === String(page)) {
        return String(page);
    }
    return `${logical} (${page})`;
}

export function isImplicitDefaultPageLabels(ranges: IPdfPageLabelRange[], totalPages: number): boolean {
    const normalizedRanges = normalizePageLabelRanges(ranges, totalPages);
    if (normalizedRanges.length !== 1) {
        return false;
    }
    const range = normalizedRanges[0];
    if (!range) {
        return false;
    }
    return (
        range.startPage === 1
        && range.style === 'D'
        && range.prefix.length === 0
        && range.startNumber === 1
    );
}

export function parsePageRangeInput(input: string, totalPages: number): IPdfPageRange | null {
    if (totalPages <= 0) {
        return null;
    }

    const normalized = input
        .trim()
        .replace(/[–—]/g, '-')
        .replace(/\.\./g, '-')
        .replace(/\s+/g, '');

    if (!normalized) {
        return null;
    }

    const match = /^(\d+)(?:-(\d+))?$/.exec(normalized);
    if (!match) {
        return null;
    }

    const first = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(first) || first < 1 || first > totalPages) {
        return null;
    }

    const secondToken = match[2];
    if (!secondToken) {
        return {
            startPage: first,
            endPage: first,
        };
    }

    const second = Number.parseInt(secondToken, 10);
    if (!Number.isFinite(second) || second < 1 || second > totalPages) {
        return null;
    }

    const startPage = Math.min(first, second);
    const endPage = Math.max(first, second);

    return {
        startPage,
        endPage,
    };
}

export function formatPageRange(range: IPdfPageRange): string {
    if (range.startPage === range.endPage) {
        return String(range.startPage);
    }
    return `${range.startPage}-${range.endPage}`;
}
