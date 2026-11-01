import {
    compact,
    uniq,
} from 'es-toolkit/array';
import type { TPageSelection } from '@contracts/pageNumbers';
import {
    createExplicitPageSelection,
    createRangePageSelection,
} from '@contracts/pageNumbers';
export type { TPrintOrientation } from '@contracts/shared';

const PRINT_PAGE_RANGE_MATERIALIZATION_LIMIT = 100_000;

export const BROWSER_PRINT_ROOT_SELECTOR = '[data-browser-print-root]';

export interface IBrowserPrintRoot {
    append: (...nodes: unknown[]) => unknown;
    replaceChildren: (...nodes: unknown[]) => unknown;
}

export interface IBrowserPrintPageContainer {
    append: (...nodes: unknown[]) => unknown;
    className: string;
}

export interface IBrowserPrintStyleElement {textContent: string;}

export interface IBrowserPrintElementStyle {
    height: string;
    width: string;
}

export interface IBrowserPrintCanvas {
    getContext: (
        contextId: '2d',
        options?: CanvasRenderingContext2DSettings,
    ) => CanvasRenderingContext2D | null;
    height: number;
    style: IBrowserPrintElementStyle;
    toBlob: (callback: (blob: Blob | null) => void, type?: string) => void;
    width: number;
}

export interface IBrowserPrintImage {
    onerror: unknown;
    onload: unknown;
    src: string;
    style: IBrowserPrintElementStyle;
}

export interface IBrowserPrintDocument {
    defaultView?: {URL: Pick<typeof URL, 'createObjectURL'>} | null;
    querySelector(selector: string): IBrowserPrintRoot | null;
    createElement(tag: 'section' | 'canvas' | 'img' | 'style'):
        | IBrowserPrintPageContainer
        | IBrowserPrintCanvas
        | IBrowserPrintImage
        | IBrowserPrintStyleElement;
}

export function buildBrowserPrintFrameMarkup(title = 'Printable PDF') {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtmlText(title)}</title>
    <style>
        @page {
            margin: 0;
        }

        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: #ffffff;
        }

        ${BROWSER_PRINT_ROOT_SELECTOR} {
            display: block;
            width: 100%;
        }

        .browser-print-page {
            break-inside: avoid;
            page-break-inside: avoid;
            break-before: page;
            page-break-before: always;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            background: #ffffff;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }

        .browser-print-page:first-child {
            break-before: auto;
            page-break-before: auto;
        }

        .browser-print-page img {
            display: block;
            margin: 0 auto;
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            break-inside: avoid;
            page-break-inside: avoid;
        }

        @media print {
            html, body {
                height: 100%;
            }

            ${BROWSER_PRINT_ROOT_SELECTOR} {
                display: block;
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <main data-browser-print-root></main>
</body>
</html>`;
}

function normalizeTotalPages(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.max(0, Math.floor(value));
}

export function parsePrintPageRangeInput(input: string, totalPages: number): number[] | null {
    const normalizedTotalPages = normalizeTotalPages(totalPages);
    if (normalizedTotalPages <= 0) {
        return null;
    }

    const normalizedInput = input
        .trim()
        .replace(/[–—]/g, '-')
        .replace(/\.\./g, '-');

    if (!normalizedInput) {
        return null;
    }

    const pages = new Set<number>();
    const parts = compact(normalizedInput
        .split(',')
        .map(part => part.trim()));

    if (parts.length === 0) {
        return null;
    }

    for (const part of parts) {
        const compactPart = part.replace(/\s+/g, '');
        const match = /^(\d+)(?:-(\d+))?$/.exec(compactPart);
        if (!match) {
            return null;
        }

        const first = Number.parseInt(match[1] ?? '', 10);
        if (!Number.isFinite(first) || first < 1 || first > normalizedTotalPages) {
            return null;
        }

        const secondToken = match[2];
        if (!secondToken) {
            pages.add(first);
            continue;
        }

        const second = Number.parseInt(secondToken, 10);
        if (!Number.isFinite(second) || second < 1 || second > normalizedTotalPages) {
            return null;
        }

        const start = Math.min(first, second);
        const end = Math.max(first, second);
        if (pages.size + end - start + 1 > PRINT_PAGE_RANGE_MATERIALIZATION_LIMIT) {
            return null;
        }
        for (let page = start; page <= end; page += 1) {
            pages.add(page);
        }
    }

    return uniq([...pages]).sort((left, right) => left - right);
}

export function parsePrintPageRangeSelectionInput(
    input: string,
    totalPages: number,
): TPageSelection | null {
    const normalizedTotalPages = normalizeTotalPages(totalPages);
    const normalizedInput = input
        .trim()
        .replace(/[–—]/g, '-')
        .replace(/\.\./g, '-')
        .replace(/\s+/g, '');
    const contiguousRange = /^(\d+)(?:-(\d+))?$/.exec(normalizedInput);
    if (normalizedTotalPages > 0 && contiguousRange) {
        const first = Number.parseInt(contiguousRange[1] ?? '', 10);
        const second = Number.parseInt(contiguousRange[2] ?? contiguousRange[1] ?? '', 10);
        if (
            Number.isSafeInteger(first)
            && Number.isSafeInteger(second)
            && first >= 1
            && second >= 1
            && first <= normalizedTotalPages
            && second <= normalizedTotalPages
        ) {
            return createRangePageSelection(
                normalizedTotalPages,
                Math.min(first, second),
                Math.max(first, second),
            );
        }
    }

    const pages = parsePrintPageRangeInput(input, normalizedTotalPages);
    return pages ? createExplicitPageSelection(normalizedTotalPages, pages) : null;
}


const HTML_TEXT_ENTITIES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
};

function escapeHtmlText(value: string) {
    return value.replace(/[&<>]/g, character => HTML_TEXT_ENTITIES[character] ?? character);
}

export { normalizePrintPageNumbers } from '@pdf-core';
