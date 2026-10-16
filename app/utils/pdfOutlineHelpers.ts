import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { clamp } from 'es-toolkit/math';
import { parsePageIndex } from '@contracts/pageNumbers';
import type {
    IBookmarkItem,
    IBookmarkLocation,
    IBookmarkStyleSummary,
    TBookmarkStyleFlagState,
    TCreateBookmarkId,
} from '@app/types/pdfOutline';
import type {IPdfBookmarkEntry} from '@app/types/pdfContracts';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

interface IRefProxy {
    num: number;
    gen: number;
}

const OUTLINE_LOG_SECTION = 'pdfOutline';
const MAX_OUTLINE_DEPTH = 256;

export interface IBookmarkDestinationTarget {
    page: number;
    pageYRatio?: number | null | undefined;
}

function isRefProxy(value: unknown): value is IRefProxy {
    return isRecord(value)
        && typeof value.num === 'number'
        && typeof value.gen === 'number';
}

function normalizeDestinationPageIndex(rawPageRef: number, numPages: number) {
    const maybeIndex = Math.trunc(rawPageRef);
    if (maybeIndex >= 0 && maybeIndex < numPages) {
        return maybeIndex;
    }
    if (maybeIndex > 0 && maybeIndex <= numPages) {
        return maybeIndex - 1;
    }
    return null;
}

function normalizeDestinationKind(value: string) {
    return value.startsWith('/') ? value.slice(1) : value;
}

function getDestinationKind(destinationArray: unknown[]) {
    const rawKind = destinationArray[1];
    if (typeof rawKind === 'string') {
        return normalizeDestinationKind(rawKind);
    }
    if (isRecord(rawKind)) {
        const name = getOptionalString(rawKind, 'name');
        return name ? normalizeDestinationKind(name) : null;
    }
    return null;
}

function getFiniteDestinationNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function getDestinationTopValue(destinationArray: unknown[], destinationKind: string | null) {
    switch (destinationKind) {
        case 'XYZ':
            return getFiniteDestinationNumber(destinationArray[3]);
        case 'FitH':
        case 'FitBH':
            return getFiniteDestinationNumber(destinationArray[2]);
        case 'FitR':
            return getFiniteDestinationNumber(destinationArray[5]);
        case null:
        default:
            return null;
    }
}

function shouldAlignDestinationToPageTop(destinationKind: string | null) {
    return destinationKind === 'XYZ'
        || destinationKind === 'Fit'
        || destinationKind === 'FitB'
        || destinationKind === 'FitH'
        || destinationKind === 'FitBH'
        || destinationKind === 'FitR';
}

async function resolveDestinationPageYRatio(
    pdfDocument: IPdfDocument,
    page: number,
    destinationArray: unknown[],
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const destinationKind = getDestinationKind(destinationArray);
    if (!shouldAlignDestinationToPageTop(destinationKind)) {
        return null;
    }

    const destinationTop = getDestinationTopValue(destinationArray, destinationKind);
    if (destinationKind === 'Fit' || destinationKind === 'FitB') {
        return 0;
    }
    const left = destinationKind === 'XYZ' || destinationKind === 'FitR'
        ? getFiniteDestinationNumber(destinationArray[2])
        : null;
    if (left === null && destinationTop === null) {
        return null;
    }
    try {
        const pdfPage = await pdfDocument.getPage(page);
        throwIfAborted(signal);
        const viewport = pdfPage.getViewport({scale: 1});
        if (!Number.isFinite(viewport.height) || viewport.height <= 0) {
            return null;
        }
        // A null PDF coordinate retains the reader's current coordinate.
        // Only the axis contributing to displayed Y needs to be specified.
        if ((viewport.transform[1] !== 0 && left === null)
            || (viewport.transform[3] !== 0 && destinationTop === null)) {
            return null;
        }
        const point = viewport.convertToViewportPoint(left ?? 0, destinationTop ?? 0);
        let top = point[1];
        if (destinationKind === 'FitR') {
            const right = getFiniteDestinationNumber(destinationArray[4]);
            const bottom = getFiniteDestinationNumber(destinationArray[3]);
            if (right === null || bottom === null) return null;
            top = Math.min(top ?? 0, viewport.convertToViewportPoint(right, bottom)[1] ?? 0);
        }
        return typeof top === 'number' && Number.isFinite(top)
            ? clamp(top / viewport.height, 0, 1)
            : null;
    } catch (error) {
        if (signal?.aborted) {
            throwIfAborted(signal);
        }
        BrowserLogger.debug(OUTLINE_LOG_SECTION, `Failed to resolve bookmark destination y for page ${page}`, error);
        return null;
    }
}

async function resolveDestinationArray(
    pdfDocument: IPdfDocument,
    dest: IBookmarkItem['dest'],
    destinationCache?: Map<string, unknown[] | null>,
    signal?: AbortSignal,
): Promise<unknown[] | null> {
    throwIfAborted(signal);
    if (!dest) {
        return null;
    }
    if (Array.isArray(dest)) {
        return dest;
    }
    if (typeof dest !== 'string') {
        return null;
    }

    if (destinationCache?.has(dest)) {
        return destinationCache.get(dest) ?? null;
    }

    try {
        const resolved = await pdfDocument.getDestination(dest);
        throwIfAborted(signal);
        destinationCache?.set(dest, resolved);
        return resolved;
    } catch (error) {
        if (signal?.aborted) {
            throwIfAborted(signal);
        }
        BrowserLogger.debug(OUTLINE_LOG_SECTION, `Failed to resolve named destination: ${dest}`, error);
        destinationCache?.set(dest, null);
        return null;
    }
}

async function resolvePageIndexFromDestinationArray(
    pdfDocument: IPdfDocument,
    destinationArray: unknown[],
    refIndexCache?: Map<string, number | null>,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    if (destinationArray.length === 0) {
        return null;
    }

    const pageRef = destinationArray[0];

    if (typeof pageRef === 'number' && Number.isFinite(pageRef)) {
        return normalizeDestinationPageIndex(pageRef, pdfDocument.numPages);
    }

    if (!isRefProxy(pageRef)) {
        return null;
    }

    const refKey = `${pageRef.num}:${pageRef.gen}`;
    if (refIndexCache?.has(refKey)) {
        return refIndexCache.get(refKey) ?? null;
    }

    try {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        throwIfAborted(signal);
        refIndexCache?.set(refKey, pageIndex);
        return pageIndex;
    } catch (error) {
        if (signal?.aborted) {
            throwIfAborted(signal);
        }
        BrowserLogger.debug(OUTLINE_LOG_SECTION, `Failed to resolve page index by reference: ${refKey}`, error);
        refIndexCache?.set(refKey, null);
        return null;
    }
}

export interface IResolvedBookmarkPageTarget {
    pageIndex: number;
    pageYRatio: number | null;
}

/**
 * Resolves the page and vertical anchor of each lazily loaded bookmark. An
 * item that already has its page keeps it and its recorded ratio.
 */
export async function resolveBookmarkPageTargets(
    pdfDocument: IPdfDocument | null,
    items: IBookmarkItem[],
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
    signal?: AbortSignal,
) {
    const targets = new Map<IBookmarkItem, IResolvedBookmarkPageTarget | null>();
    for (const item of items) {
        const target = item.pageIndex !== null && item.pageIndex !== undefined
            ? {
                pageIndex: item.pageIndex,
                pageYRatio: item.pageYRatio ?? null,
            }
            : pdfDocument && item.dest
                ? await resolveDestinationTarget(pdfDocument, item.dest, destinationCache, refIndexCache, signal)
                : null;
        if (signal?.aborted) return null;
        targets.set(item, target);
    }
    return targets;
}

async function resolveDestinationTarget(
    pdfDocument: IPdfDocument,
    dest: IBookmarkItem['dest'],
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
    signal?: AbortSignal,
) {
    if (!dest) {
        return null;
    }

    const destinationArray = await resolveDestinationArray(pdfDocument, dest, destinationCache, signal);
    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const pageIndex = await resolvePageIndexFromDestinationArray(pdfDocument, destinationArray, refIndexCache, signal);
    if (pageIndex === null) {
        return null;
    }

    const pageYRatio = await resolveDestinationPageYRatio(pdfDocument, pageIndex + 1, destinationArray, signal);
    return {
        pageIndex,
        pageYRatio,
    };
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new DOMException('PDF outline destination resolution was cancelled', 'AbortError');
    }
}

export function buildOutlineFromBookmarkEntries(
    entries: readonly IPdfBookmarkEntry[],
    createId: TCreateBookmarkId,
) {
    const root: IBookmarkItem[] = [];
    const stack: Array<{
        entry: IPdfBookmarkEntry;
        target: IBookmarkItem[];
        parentId: string | null;
        depth: number;
    }> = [];
    let skippedOverDepth = false;
    // Pushed last first, so that the stack pops entries in reading order.
    const pushEntries = (items: readonly IPdfBookmarkEntry[], target: IBookmarkItem[], parentId: string | null, depth: number) => {
        for (const entry of [...items].reverse()) {
            stack.push({
                entry,
                target,
                parentId,
                depth,
            });
        }
    };
    pushEntries(entries, root, null, 1);

    while (stack.length > 0) {
        const frame = stack.pop();
        if (!frame) {
            break;
        }
        const children: IBookmarkItem[] = [];
        const pageIndex = typeof frame.entry.pageIndex === 'number' && Number.isFinite(frame.entry.pageIndex)
            ? parsePageIndex(Math.max(0, Math.trunc(frame.entry.pageIndex)))
            : null;
        const dest = frame.entry.originalDestination
            ? [
                frame.entry.originalDestination.sourceTarget,
                {name: frame.entry.originalDestination.kind},
                ...frame.entry.originalDestination.coordinates,
            ]
            : frame.entry.namedDest;
        const id = createId({
            parentId: frame.parentId,
            title: frame.entry.title,
            pageIndex,
            dest,
        });
        frame.target.push({
            title: frame.entry.title,
            dest,
            id,
            pageIndex,
            ...(typeof frame.entry.pageYRatio === 'number' && Number.isFinite(frame.entry.pageYRatio)
                ? {pageYRatio: clamp(frame.entry.pageYRatio, 0, 1)}
                : {}),
            ...(frame.entry.originalAction ? {originalAction: frame.entry.originalAction} : {}),
            ...(frame.entry.originalNamedDest === undefined ? {} : {originalNamedDest: frame.entry.originalNamedDest}),
            bold: frame.entry.bold === true,
            italic: frame.entry.italic === true,
            color: normalizeBookmarkColor(frame.entry.color),
            items: children,
        });

        if (!frame.entry.items.length) {
            continue;
        }
        if (frame.depth >= MAX_OUTLINE_DEPTH) {
            skippedOverDepth = true;
            continue;
        }
        pushEntries(frame.entry.items, children, id, frame.depth + 1);
    }

    if (skippedOverDepth) {
        BrowserLogger.warn(OUTLINE_LOG_SECTION, 'Skipped pending PDF bookmark items beyond the supported nesting depth', {maxDepth: MAX_OUTLINE_DEPTH});
    }

    return root;
}

export async function resolveBookmarkDestinationTarget(
    pdfDocument: IPdfDocument,
    dest: string | unknown[] | null,
    signal?: AbortSignal,
): Promise<IBookmarkDestinationTarget | null> {
    throwIfAborted(signal);
    if (!dest) {
        return null;
    }

    const destinationArray = await resolveDestinationArray(pdfDocument, dest, undefined, signal);

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const zeroBasedIndex = await resolvePageIndexFromDestinationArray(pdfDocument, destinationArray, undefined, signal);
    if (zeroBasedIndex === null) {
        return null;
    }

    const page = zeroBasedIndex + 1;
    const pageYRatio = await resolveDestinationPageYRatio(pdfDocument, page, destinationArray, signal);
    return {
        page,
        ...(pageYRatio === null ? {} : { pageYRatio }),
    };
}

export function findBookmarkLocation(
    items: IBookmarkItem[],
    id: string,
    parent: IBookmarkItem | null = null,
): IBookmarkLocation | null {
    for (const [
        index,
        item,
    ] of items.entries()) {
        if (item.id === id) {
            return {
                parent,
                list: items,
                index,
                item,
            };
        }

        const child = findBookmarkLocation(item.items, id, item);
        if (child) {
            return child;
        }
    }

    return null;
}

export function findBookmarkById(items: IBookmarkItem[], id: string): IBookmarkItem | null {
    for (const item of items) {
        if (item.id === id) {
            return item;
        }
        const child = findBookmarkById(item.items, id);
        if (child) {
            return child;
        }
    }

    return null;
}

export function collectBookmarkIds(item: IBookmarkItem, ids: Set<string>) {
    ids.add(item.id);
    for (const child of item.items) {
        collectBookmarkIds(child, ids);
    }
}

export function flattenBookmarks(items: IBookmarkItem[]) {
    const flattened: IBookmarkItem[] = [];

    const pending = [...items].reverse();
    while (pending.length > 0) {
        const item = pending.pop();
        if (!item) {
            continue;
        }
        flattened.push(item);
        pending.push(...item.items.toReversed());
    }

    return flattened;
}

/**
 * Returns the zero-based deepest item level without recursing through the
 * outline. Native bookmark mutations accept at most 64 item levels, so the
 * UI can refuse an over-depth tree before a save request is built.
 */
export function resolveMaxBookmarkDepth(items: IBookmarkItem[]) {
    let maxDepth = -1;
    const pending: Array<{
        depth: number;
        items: IBookmarkItem[];
    }> = [{
        depth: 0,
        items,
    }];
    while (pending.length > 0) {
        const frame = pending.pop();
        if (!frame) {
            continue;
        }
        for (const item of frame.items) {
            maxDepth = Math.max(maxDepth, frame.depth);
            if (item.items.length > 0) {
                pending.push({
                    depth: frame.depth + 1,
                    items: item.items,
                });
            }
        }
    }
    return maxDepth;
}

/**
 * Depth of every entry of a pre-order flattened outline, keyed by identity.
 * A parent always precedes its children in that order, so one pass is enough.
 */
function resolveFlattenedBookmarkDepths(flatBookmarks: IBookmarkItem[]) {
    const depths = new Map<IBookmarkItem, number>();

    for (const item of flatBookmarks) {
        const depth = depths.get(item) ?? 0;
        depths.set(item, depth);
        for (const child of item.items) {
            depths.set(child, depth + 1);
        }
    }

    return depths;
}

export function resolveActiveBookmarkForPage(
    flatBookmarks: IBookmarkItem[],
    currentPage: number,
    currentActiveItemId: string | null,
    getPageIndex: (item: IBookmarkItem) => number | null = item => item.pageIndex,
) {
    const pageIndex = Math.max(0, (Number.isFinite(currentPage) ? currentPage : 1) - 1);
    const currentActive = currentActiveItemId
        ? flatBookmarks.find(item => item.id === currentActiveItemId) ?? null
        : null;

    if (currentActive && getPageIndex(currentActive) === pageIndex) {
        return currentActive;
    }

    const depths = resolveFlattenedBookmarkDepths(flatBookmarks);
    let active: IBookmarkItem | null = null;
    let activePageIndex = Number.NEGATIVE_INFINITY;

    for (const item of flatBookmarks) {
        const itemPageIndex = getPageIndex(item);
        if (
            typeof itemPageIndex !== 'number'
            || !Number.isFinite(itemPageIndex)
            || itemPageIndex > pageIndex
        ) {
            continue;
        }
        // Nearest preceding page wins; later equal-page candidates win unless
        // a child inherits the page of the parent that names the section.
        if (
            active === null
            || itemPageIndex > activePageIndex
            || (itemPageIndex === activePageIndex
                && (depths.get(item) ?? 0) <= (depths.get(active) ?? 0))
        ) {
            active = item;
            activePageIndex = itemPageIndex;
        }
    }

    return active;
}

/**
 * Black is the PDF outline default (ISO 32000-1 table 153 gives `/C` a default
 * of `[0 0 0]`, and pdf.js reports absent colors as black), so it normalizes
 * to `null`: the bookmark then follows the theme text color instead of pinning
 * black onto a dark theme.
 */
const DEFAULT_BOOKMARK_COLOR = '#000000';

export function normalizeBookmarkColor(color: string | null | undefined) {
    const normalized = normalizeExplicitBookmarkColor(color);
    return normalized === DEFAULT_BOOKMARK_COLOR ? null : normalized;
}

function normalizeExplicitBookmarkColor(color: string | null | undefined) {
    if (typeof color !== 'string') {
        return null;
    }

    const value = color.trim().toLowerCase();
    const shortHexMatch = /^#([0-9a-f]{3})$/.exec(value);
    if (shortHexMatch) {
        const triple = shortHexMatch[1];
        if (!triple) {
            return null;
        }
        const r = triple.charAt(0);
        const g = triple.charAt(1);
        const b = triple.charAt(2);
        return `#${r}${r}${g}${g}${b}${b}`;
    }

    return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

function summarizeBookmarkFlag(items: readonly IBookmarkItem[], flag: 'bold' | 'italic'): TBookmarkStyleFlagState {
    const onCount = items.filter(item => item[flag]).length;
    if (onCount === 0) {
        return 'off';
    }
    return onCount === items.length ? 'on' : 'mixed';
}

/**
 * The style state a context menu shows for its targets. Every flag reports
 * `mixed` when the targets disagree, so a multi-selection never pretends to
 * have one style it does not share.
 */
export function summarizeBookmarkStyles(items: readonly IBookmarkItem[]): IBookmarkStyleSummary {
    const firstColor = normalizeBookmarkColor(items[0]?.color);
    const colorMixed = items.some(item => normalizeBookmarkColor(item.color) !== firstColor);
    return {
        targetCount: items.length,
        bold: summarizeBookmarkFlag(items, 'bold'),
        italic: summarizeBookmarkFlag(items, 'italic'),
        color: colorMixed ? null : firstColor,
        colorMixed,
    };
}
