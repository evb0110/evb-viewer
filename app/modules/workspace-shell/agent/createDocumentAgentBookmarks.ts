import type { Ref } from 'vue';
import { isRecord } from '@contracts/runtimeGuards';
import { isEqual } from 'es-toolkit/predicate';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import type { IPdfBookmarkChangePayload } from '@app/types/pdfUi';
import { normalizeBookmarkColor } from '@app/utils/pdfOutlineHelpers';
import {
    getAgentBooleanInput,
    getAgentNullableStringInput,
    getAgentNumberArrayInput,
    getAgentNumberInput,
    getAgentRawStringInput,
    hasAgentInputKey,
    isAgentRecord,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    normalizeAgentPageNumber,
    requireAgentPdfPageCount,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';
import {
    pageNumberToPageIndex,
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';
import type { TWorkspaceAgentTranslate } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';

type TAgentMetadataIssueSeverity = 'error' | 'warning' | 'info';
type TAgentBookmarkInputMode = 'nested' | 'flat';

interface IAgentMetadataIssue {
    severity: TAgentMetadataIssueSeverity;
    code: string;
    message: string;
    page?: number | null;
    path?: number[];
}

interface IAgentBookmarkFlatEntry {
    path: number[];
    depth: number;
    title: string;
    pageIndex: number | null;
    pageNumber: number | null;
    pageYRatio: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    childCount: number;
}

interface IAgentBookmarkSnapshot {
    count: number;
    dirty: boolean;
    summary: {
        rootCount: number;
        totalCount: number;
        maxDepth: number;
        destinationlessCount: number;
        namedDestinationCount: number;
        anchoredPageDestinationCount: number;
        firstPageNumber: number | null;
        lastPageNumber: number | null;
    };
    issues: IAgentMetadataIssue[];
    flat: IAgentBookmarkFlatEntry[];
    bookmarks: Array<Record<string, unknown>>;
}

interface IAgentBookmarkPlan {
    inputMode: TAgentBookmarkInputMode;
    bookmarks: TAgentMutableBookmarkEntry[];
    proposed: IAgentBookmarkSnapshot;
    diff: {
        wouldChange: boolean;
        currentCount: number;
        proposedCount: number;
        addedCount: number;
        removedCount: number;
        updatedCount: number;
        added: IAgentBookmarkFlatEntry[];
        removed: IAgentBookmarkFlatEntry[];
        updated: Array<{
            path: number[];
            before: IAgentBookmarkFlatEntry;
            after: IAgentBookmarkFlatEntry;
        }>;
    };
    issues: IAgentMetadataIssue[];
}

type TAgentMutableBookmarkEntry = {
    -readonly [TKey in keyof IPdfBookmarkEntry]: TKey extends 'items'
        ? TAgentMutableBookmarkEntry[]
        : IPdfBookmarkEntry[TKey];
};

const MAX_ISSUE_COUNT = 50;
const MAX_DIFF_SAMPLE_COUNT = 50;
const MAX_AGENT_BOOKMARK_STYLE_TARGET_PATHS = 200;
const MIN_CHILDREN_SHARING_PARENT_DESTINATION_FOR_ANCHOR_WARNING = 2;

function pushIssue(issues: IAgentMetadataIssue[], issue: IAgentMetadataIssue) {
    if (issues.length < MAX_ISSUE_COUNT) {
        issues.push(issue);
    }
}

function normalizeBookmarkPageIndex(
    input: Record<string, unknown>,
    totalPages: number,
    actionId: string,
) {
    const pageNumber = getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber');
    if (pageNumber !== null) {
        return pageNumberToPageIndex(requirePageNumber(normalizeAgentPageNumber(pageNumber, totalPages, actionId), totalPages));
    }

    const pageIndex = getAgentNumberInput(input, 'pageIndex');
    if (pageIndex === null) {
        return null;
    }
    const normalizedPageIndex = Math.trunc(pageIndex);
    if (normalizedPageIndex < 0 || normalizedPageIndex >= requireAgentPdfPageCount(totalPages, actionId)) {
        throw new Error(`${actionId} pageIndex ${normalizedPageIndex} is outside the document.`);
    }
    return requirePageIndex(normalizedPageIndex, totalPages);
}

function getRawBookmarkPageYRatioInput(input: Record<string, unknown>) {
    if (hasAgentInputKey(input, 'pageYRatio')) {
        return input.pageYRatio;
    }
    if (hasAgentInputKey(input, 'yRatio')) {
        return input.yRatio;
    }
    if (hasAgentInputKey(input, 'pageAnchorRatio')) {
        return input.pageAnchorRatio;
    }
    return undefined;
}

function clampBookmarkPageYRatio(value: number) {
    return Math.min(1, Math.max(0, value));
}

function normalizeBookmarkPageYRatioInput(
    input: Record<string, unknown>,
    pageIndex: number | null,
    actionId: string,
) {
    if (pageIndex === null) {
        return null;
    }

    const value = getRawBookmarkPageYRatioInput(input);
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${actionId} pageYRatio must be a finite number from 0 to 1 or null.`);
    }
    return clampBookmarkPageYRatio(value);
}

function normalizeBookmarkPageYRatioValue(
    pageIndex: number | null,
    value: number | null | undefined,
) {
    return pageIndex !== null && typeof value === 'number' && Number.isFinite(value)
        ? clampBookmarkPageYRatio(value)
        : null;
}

function normalizeBookmarkPageYRatioForComparison(
    pageIndex: number,
    value: number | null | undefined,
) {
    const normalized = typeof value === 'number' && Number.isFinite(value)
        ? clampBookmarkPageYRatio(value)
        : 0;
    return Number(normalized.toFixed(6));
}

function getBookmarkDestinationKey(bookmark: Pick<IPdfBookmarkEntry, 'pageIndex' | 'pageYRatio' | 'namedDest'>) {
    if (bookmark.namedDest) {
        return `named:${bookmark.namedDest}`;
    }
    const pageIndex = bookmark.pageIndex;
    if (pageIndex === null) {
        return null;
    }
    return `page:${pageIndex}:${normalizeBookmarkPageYRatioForComparison(
        pageIndex,
        bookmark.pageYRatio,
    )}`;
}

function normalizeBookmarkEntry(
    input: Record<string, unknown>,
    totalPages: number,
    untitledTitle: string,
    actionId: string,
): TAgentMutableBookmarkEntry {
    const rawTitle = getAgentRawStringInput(input, 'title')?.trim();
    const title = rawTitle && rawTitle.length > 0 ? rawTitle : untitledTitle;
    const pageIndex = normalizeBookmarkPageIndex(input, totalPages, actionId);
    const namedDest = getAgentRawStringInput(input, 'namedDest')
        ?? getAgentRawStringInput(input, 'dest')
        ?? null;
    const color = getAgentNullableStringInput(input, 'color');
    const rawItems = Array.isArray(input.items) ? input.items : input.children;
    return {
        title,
        pageIndex,
        pageYRatio: normalizeBookmarkPageYRatioInput(input, pageIndex, actionId),
        namedDest: namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null,
        bold: getAgentBooleanInput(input, 'bold') ?? false,
        italic: getAgentBooleanInput(input, 'italic') ?? false,
        color: color === null ? null : normalizeBookmarkColor(color),
        items: Array.isArray(rawItems)
            ? rawItems
                .filter(isRecord)
                .map(item => normalizeBookmarkEntry(item, totalPages, untitledTitle, actionId))
            : [],
    };
}

function normalizeFlatBookmarkDepth(input: Record<string, unknown>) {
    const depth = getAgentNumberInput(input, 'depth');
    if (depth !== null) {
        return Math.max(0, Math.trunc(depth));
    }

    const level = getAgentNumberInput(input, 'level');
    if (level !== null) {
        return Math.max(0, Math.trunc(level) - 1);
    }

    return 0;
}

function buildBookmarkTreeFromFlatEntries(
    entries: Array<Record<string, unknown>>,
    totalPages: number,
    untitledTitle: string,
    actionId: string,
) {
    const roots: TAgentMutableBookmarkEntry[] = [];
    const stack: TAgentMutableBookmarkEntry[] = [];
    const issues: IAgentMetadataIssue[] = [];

    entries.forEach((entry, index) => {
        const depth = normalizeFlatBookmarkDepth(entry);
        const bookmark = normalizeBookmarkEntry(entry, totalPages, untitledTitle, actionId);
        if (depth === 0) {
            roots.push(bookmark);
            stack.length = 0;
            stack[0] = bookmark;
            return;
        }

        const parent = stack[depth - 1] ?? null;
        if (!parent) {
            pushIssue(issues, {
                severity: 'warning',
                code: 'flat_bookmark_missing_parent',
                message: `Flat bookmark "${bookmark.title}" at entry ${index + 1} has depth ${depth} without a parent; it was promoted to the root level.`,
                page: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
            });
            roots.push(bookmark);
            stack.length = 0;
            stack[0] = bookmark;
            return;
        }

        parent.items.push(bookmark);
        stack.length = depth + 1;
        stack[depth] = bookmark;
    });

    return {
        bookmarks: roots,
        issues,
    };
}

function normalizeBookmarkTreeInput(options: {
    input: Record<string, unknown>;
    totalPages: number;
    untitledTitle: string;
    actionId: string;
}) {
    const rawTree = options.input.bookmarks ?? options.input.items ?? options.input.tree;
    if (Array.isArray(rawTree)) {
        return {
            inputMode: 'nested' as const,
            bookmarks: rawTree
                .filter(isRecord)
                .map(item => normalizeBookmarkEntry(item, options.totalPages, options.untitledTitle, options.actionId)),
            issues: [] as IAgentMetadataIssue[],
        };
    }

    const rawFlat = options.input.entries ?? options.input.flat ?? options.input.outline;
    if (Array.isArray(rawFlat)) {
        const flatResult = buildBookmarkTreeFromFlatEntries(
            rawFlat.filter(isRecord),
            options.totalPages,
            options.untitledTitle,
            options.actionId,
        );
        return {
            inputMode: 'flat' as const,
            ...flatResult,
        };
    }

    throw new Error(`${options.actionId} requires input.bookmarks, input.items, input.tree, input.entries, input.flat, or input.outline.`);
}

function normalizeBookmarkForAgent(
    bookmark: IPdfBookmarkEntry,
    path: number[] = [],
): Record<string, unknown> {
    return {
        path,
        depth: path.length,
        title: bookmark.title,
        pageIndex: bookmark.pageIndex,
        pageNumber: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
        pageYRatio: normalizeBookmarkPageYRatioValue(bookmark.pageIndex, bookmark.pageYRatio),
        namedDest: bookmark.namedDest,
        bold: bookmark.bold,
        italic: bookmark.italic,
        color: bookmark.color,
        items: bookmark.items.map((child, index) => normalizeBookmarkForAgent(child, [
            ...path,
            index,
        ])),
    };
}

function flattenBookmarks(bookmarks: readonly IPdfBookmarkEntry[], basePath: number[] = []) {
    const flat: IAgentBookmarkFlatEntry[] = [];
    const visit = (items: readonly IPdfBookmarkEntry[], path: number[]) => {
        items.forEach((bookmark, index) => {
            const nextPath = [
                ...path,
                index,
            ];
            flat.push({
                path: nextPath,
                depth: nextPath.length - 1,
                title: bookmark.title,
                pageIndex: bookmark.pageIndex,
                pageNumber: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
                pageYRatio: normalizeBookmarkPageYRatioValue(bookmark.pageIndex, bookmark.pageYRatio),
                namedDest: bookmark.namedDest,
                bold: bookmark.bold,
                italic: bookmark.italic,
                color: bookmark.color,
                childCount: bookmark.items.length,
            });
            visit(bookmark.items, nextPath);
        });
    };
    visit(bookmarks, basePath);
    return flat;
}

function getBookmarkComparable(entry: IAgentBookmarkFlatEntry) {
    return {
        title: entry.title,
        pageIndex: entry.pageIndex,
        pageYRatio: entry.pageYRatio,
        namedDest: entry.namedDest,
        bold: entry.bold,
        italic: entry.italic,
        color: entry.color,
        childCount: entry.childCount,
    };
}

function createBookmarkIssues(bookmarks: readonly IPdfBookmarkEntry[], flat: readonly IAgentBookmarkFlatEntry[]) {
    const issues: IAgentMetadataIssue[] = [];
    for (const entry of flat) {
        if (entry.pageIndex === null && !entry.namedDest) {
            pushIssue(issues, {
                severity: 'warning',
                code: 'bookmark_without_destination',
                message: `Bookmark "${entry.title}" has no page or named destination.`,
                path: entry.path,
            });
        }
    }

    let previousPage: number | null = null;
    for (const entry of flat) {
        if (entry.pageNumber === null) {
            continue;
        }
        if (previousPage !== null && entry.pageNumber < previousPage) {
            pushIssue(issues, {
                severity: 'info',
                code: 'bookmark_page_order_decreases',
                message: `Bookmark "${entry.title}" points to page ${entry.pageNumber}, before the previous bookmark page ${previousPage}.`,
                page: entry.pageNumber,
                path: entry.path,
            });
        }
        previousPage = entry.pageNumber;
    }

    const visitSiblings = (items: readonly IPdfBookmarkEntry[], path: number[]) => {
        const counts = new Map<string, number>();
        items.forEach((item) => {
            const key = item.title.trim().toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
        });
        items.forEach((item, index) => {
            const key = item.title.trim().toLowerCase();
            if ((counts.get(key) ?? 0) > 1) {
                pushIssue(issues, {
                    severity: 'info',
                    code: 'duplicate_sibling_bookmark_title',
                    message: `Sibling bookmark title "${item.title}" appears more than once.`,
                    path: [
                        ...path,
                        index,
                    ],
                });
            }
            visitSiblings(item.items, [
                ...path,
                index,
            ]);
        });
    };
    visitSiblings(bookmarks, []);

    const visitChildrenSharingParentDestination = (items: readonly IPdfBookmarkEntry[], path: number[]) => {
        items.forEach((parent, index) => {
            const parentPath = [
                ...path,
                index,
            ];
            const parentDestinationKey = getBookmarkDestinationKey(parent);
            if (parentDestinationKey !== null) {
                const childrenAtParentDestination = parent.items.filter(child => (
                    getBookmarkDestinationKey(child) === parentDestinationKey
                ));
                if (childrenAtParentDestination.length >= MIN_CHILDREN_SHARING_PARENT_DESTINATION_FOR_ANCHOR_WARNING) {
                    pushIssue(issues, {
                        severity: 'error',
                        code: 'bookmark_children_share_parent_destination',
                        message: `${childrenAtParentDestination.length} child bookmarks under "${parent.title}" point to the same destination as their parent. Locate each child heading with document.search/read_pages/capture_page_image and provide a distinct page or pageYRatio anchor, or omit those child bookmarks.`,
                        page: parent.pageIndex === null ? null : parent.pageIndex + 1,
                        path: parentPath,
                    });
                }
            }
            visitChildrenSharingParentDestination(parent.items, parentPath);
        });
    };
    visitChildrenSharingParentDestination(bookmarks, []);

    return issues;
}

function createBookmarkSummary(bookmarks: readonly IPdfBookmarkEntry[], flat: IAgentBookmarkFlatEntry[]) {
    const pageNumbers: number[] = [];
    for (const entry of flat) {
        if (typeof entry.pageNumber === 'number') {
            pageNumbers.push(entry.pageNumber);
        }
    }
    return {
        rootCount: bookmarks.length,
        totalCount: flat.length,
        maxDepth: flat.reduce((maxDepth, entry) => Math.max(maxDepth, entry.depth), 0),
        destinationlessCount: flat.filter(entry => entry.pageIndex === null && !entry.namedDest).length,
        namedDestinationCount: flat.filter(entry => Boolean(entry.namedDest)).length,
        anchoredPageDestinationCount: flat.filter(entry => (
            entry.pageIndex !== null
            && typeof entry.pageYRatio === 'number'
            && entry.pageYRatio > 0
        )).length,
        firstPageNumber: pageNumbers.length > 0 ? Math.min(...pageNumbers) : null,
        lastPageNumber: pageNumbers.length > 0 ? Math.max(...pageNumbers) : null,
    };
}

export function createAgentBookmarkSnapshot(
    bookmarks: readonly IPdfBookmarkEntry[],
    options: {dirty: boolean;},
): IAgentBookmarkSnapshot {
    const flat = flattenBookmarks(bookmarks);
    return {
        count: bookmarks.length,
        dirty: options.dirty,
        summary: createBookmarkSummary(bookmarks, flat),
        issues: createBookmarkIssues(bookmarks, flat),
        flat,
        bookmarks: bookmarks.map((bookmark, index) => normalizeBookmarkForAgent(bookmark, [index])),
    };
}

function createBookmarkDiff(current: IAgentBookmarkSnapshot, proposed: IAgentBookmarkSnapshot) {
    const currentByPath = new Map(current.flat.map(entry => [
        entry.path.join('.'),
        entry,
    ]));
    const proposedByPath = new Map(proposed.flat.map(entry => [
        entry.path.join('.'),
        entry,
    ]));
    const added: IAgentBookmarkFlatEntry[] = [];
    const removed: IAgentBookmarkFlatEntry[] = [];
    const updated: IAgentBookmarkPlan['diff']['updated'] = [];

    for (const proposedEntry of proposed.flat) {
        const key = proposedEntry.path.join('.');
        const currentEntry = currentByPath.get(key);
        if (!currentEntry) {
            if (added.length < MAX_DIFF_SAMPLE_COUNT) {
                added.push(proposedEntry);
            }
            continue;
        }
        if (!isEqual(getBookmarkComparable(currentEntry), getBookmarkComparable(proposedEntry))) {
            if (updated.length < MAX_DIFF_SAMPLE_COUNT) {
                updated.push({
                    path: proposedEntry.path,
                    before: currentEntry,
                    after: proposedEntry,
                });
            }
        }
    }

    for (const currentEntry of current.flat) {
        const key = currentEntry.path.join('.');
        if (!proposedByPath.has(key) && removed.length < MAX_DIFF_SAMPLE_COUNT) {
            removed.push(currentEntry);
        }
    }

    const addedCount = proposed.flat.filter(entry => !currentByPath.has(entry.path.join('.'))).length;
    const removedCount = current.flat.filter(entry => !proposedByPath.has(entry.path.join('.'))).length;
    const updatedCount = proposed.flat.filter((entry) => {
        const currentEntry = currentByPath.get(entry.path.join('.'));
        return currentEntry
            ? !isEqual(getBookmarkComparable(currentEntry), getBookmarkComparable(entry))
            : false;
    }).length;

    return {
        wouldChange: addedCount > 0 || removedCount > 0 || updatedCount > 0,
        currentCount: current.flat.length,
        proposedCount: proposed.flat.length,
        addedCount,
        removedCount,
        updatedCount,
        added,
        removed,
        updated,
    };
}

export function createAgentBookmarkPlan(options: {
    input: Record<string, unknown>;
    currentBookmarks: readonly IPdfBookmarkEntry[];
    totalPages: number;
    dirty: boolean;
    untitledTitle: string;
    actionId: string;
}): IAgentBookmarkPlan {
    requireAgentPdfPageCount(options.totalPages, options.actionId);
    const normalized = normalizeBookmarkTreeInput(options);
    const current = createAgentBookmarkSnapshot(options.currentBookmarks, {dirty: options.dirty});
    const proposed = createAgentBookmarkSnapshot(normalized.bookmarks, {dirty: options.dirty});
    const issues = [
        ...normalized.issues,
        ...proposed.issues,
    ];
    return {
        inputMode: normalized.inputMode,
        bookmarks: normalized.bookmarks,
        proposed,
        diff: createBookmarkDiff(current, proposed),
        issues,
    };
}

const createAgentBookmarkPlanSnapshot = createAgentBookmarkSnapshot;

type TAgentBookmarkSnapshot = ReturnType<typeof createAgentBookmarkPlanSnapshot>;
type TAgentBookmarkIssue = TAgentBookmarkSnapshot['issues'][number];

interface ICreateDocumentAgentBookmarksOptions {
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksDirty: Ref<boolean>;
    handleBookmarksChange: (payload: IPdfBookmarkChangePayload) => void;
    t: TWorkspaceAgentTranslate;
    totalPages: Ref<number>;
}

export function createDocumentAgentBookmarks(options: ICreateDocumentAgentBookmarksOptions) {
    const {
        bookmarkItems,
        bookmarksDirty,
        handleBookmarksChange,
        t,
        totalPages,
    } = options;

    function normalizeAgentBookmarkPageIndex(input: Record<string, unknown>, actionId: string) {
        return normalizeBookmarkPageIndex(input, totalPages.value, actionId);
    }

    function getRawAgentBookmarkPageYRatioInput(input: Record<string, unknown>) {
        if (hasAgentInputKey(input, 'pageYRatio')) {
            return input.pageYRatio;
        }
        if (hasAgentInputKey(input, 'yRatio')) {
            return input.yRatio;
        }
        if (hasAgentInputKey(input, 'pageAnchorRatio')) {
            return input.pageAnchorRatio;
        }
        return undefined;
    }

    function hasAgentBookmarkPageYRatioInput(input: Record<string, unknown>) {
        return getRawAgentBookmarkPageYRatioInput(input) !== undefined;
    }

    function normalizeAgentBookmarkPageYRatioInput(
        input: Record<string, unknown>,
        pageIndex: number | null,
        actionId: string,
    ) {
        if (pageIndex === null) {
            return null;
        }

        const value = getRawAgentBookmarkPageYRatioInput(input);
        if (value === undefined || value === null) {
            return null;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`${actionId} pageYRatio must be a finite number from 0 to 1 or null.`);
        }
        return Math.min(1, Math.max(0, value));
    }

    function cloneAgentBookmarkEntry(bookmark: IPdfBookmarkEntry): TAgentMutableBookmarkEntry {
        return {
            ...bookmark,
            items: bookmark.items.map(cloneAgentBookmarkEntry),
        };
    }

    function cloneAgentBookmarks() {
        return bookmarkItems.value.map(cloneAgentBookmarkEntry);
    }

    function getAgentBookmarkPathInput(input: Record<string, unknown>, key = 'path') {
        const path = getAgentNumberArrayInput(input, key);
        return path?.map(index => Math.max(0, Math.trunc(index))) ?? null;
    }

    function normalizeAgentBookmarkPath(value: unknown) {
        if (!Array.isArray(value)) {
            return null;
        }

        const path: number[] = [];
        for (const item of value) {
            if (typeof item !== 'number' || !Number.isFinite(item)) {
                return null;
            }
            path.push(Math.max(0, Math.trunc(item)));
        }
        return path;
    }

    function getAgentBookmarkPathListInput(input: Record<string, unknown>, actionId: string, allowMissingSelection = false) {
        const rawPaths = input.paths;
        if (Array.isArray(rawPaths)) {
            const paths: number[][] = [];
            rawPaths.forEach((rawPath) => {
                const path = normalizeAgentBookmarkPath(rawPath);
                if (!path || path.length === 0) {
                    throw new Error(`${actionId} requires each input.paths item to be a non-empty path array.`);
                }
                paths.push(path);
            });
            if (paths.length === 0) {
                throw new Error(`${actionId} requires at least one bookmark path.`);
            }
            return paths;
        }

        const rawItems = input.bookmarks ?? input.items;
        if (Array.isArray(rawItems)) {
            const paths = rawItems.map((item) => {
                if (!isAgentRecord(item)) {
                    throw new Error(`${actionId} requires each input.items item to include a non-empty path.`);
                }
                const path = getAgentBookmarkPathInput(item);
                if (!path || path.length === 0) {
                    throw new Error(`${actionId} requires each input.items item to include a non-empty path.`);
                }
                return path;
            });
            if (paths.length === 0) {
                throw new Error(`${actionId} requires at least one bookmark path.`);
            }
            return paths;
        }

        const singlePath = getAgentBookmarkPathInput(input);
        if (singlePath && singlePath.length > 0) {
            return [singlePath];
        }

        if (allowMissingSelection) {
            return [];
        }

        throw new Error(`${actionId} requires input.paths, input.items with path, or input.path.`);
    }

    function getBookmarkListAtPath(
        bookmarks: TAgentMutableBookmarkEntry[],
        path: number[],
        actionId: string,
    ) {
        let list = bookmarks;
        for (const index of path) {
            const bookmark = list[index];
            if (!bookmark) {
                throw new Error(`${actionId} bookmark path was not found.`);
            }
            list = bookmark.items;
        }
        return list;
    }

    function getBookmarkLocationAtPath(
        bookmarks: TAgentMutableBookmarkEntry[],
        path: number[] | null,
        actionId: string,
    ) {
        if (!path || path.length === 0) {
            throw new Error(`${actionId} requires input.path.`);
        }
        const parentPath = path.slice(0, -1);
        const index = path[path.length - 1];
        if (index === undefined) {
            throw new Error(`${actionId} requires input.path.`);
        }
        const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
        const bookmark = list[index];
        if (!bookmark) {
            throw new Error(`${actionId} bookmark path was not found.`);
        }
        return {
            list,
            index,
            bookmark,
        };
    }

    function compareAgentBookmarkPaths(left: number[], right: number[]) {
        const length = Math.min(left.length, right.length);
        for (let index = 0; index < length; index += 1) {
            const difference = (left[index] ?? 0) - (right[index] ?? 0);
            if (difference !== 0) {
                return difference;
            }
        }
        return left.length - right.length;
    }

    function pathsAreEqual(left: number[], right: number[]) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function pathStartsWith(path: number[], prefix: number[]) {
        return prefix.length <= path.length && prefix.every((value, index) => value === path[index]);
    }

    function resolveRootBookmarkPaths(paths: number[][]) {
        const roots: number[][] = [];
        const sorted = [...paths].sort(compareAgentBookmarkPaths);
        for (const path of sorted) {
            if (path.length === 0) {
                continue;
            }
            if (roots.some(rootPath => pathStartsWith(path, rootPath))) {
                continue;
            }
            roots.push(path);
        }
        return roots;
    }

    function removeBookmarkPaths(
        items: TAgentMutableBookmarkEntry[],
        paths: number[][],
        parentPath: number[] = [],
    ): TAgentMutableBookmarkEntry[] {
        return items.flatMap((item, index) => {
            const path = [
                ...parentPath,
                index,
            ];
            if (paths.some(targetPath => pathsAreEqual(path, targetPath))) {
                return [];
            }
            return [{
                ...item,
                items: removeBookmarkPaths(item.items, paths, path),
            }];
        });
    }

    function normalizeAgentBookmarkEntry(input: Record<string, unknown>, actionId: string): TAgentMutableBookmarkEntry {
        const rawTitle = getAgentRawStringInput(input, 'title')?.trim();
        const title = rawTitle && rawTitle.length > 0 ? rawTitle : t('bookmarks.untitled');
        const pageIndex = normalizeAgentBookmarkPageIndex(input, actionId);
        const namedDest = getAgentRawStringInput(input, 'namedDest')
            ?? getAgentRawStringInput(input, 'dest')
            ?? null;
        const rawItems = Array.isArray(input.items) ? input.items : input.children;
        const items = Array.isArray(rawItems)
            ? rawItems
                .filter(isAgentRecord)
                .map(item => normalizeAgentBookmarkEntry(item, actionId))
            : [];
        const color = getAgentNullableStringInput(input, 'color');
        return {
            title,
            pageIndex,
            pageYRatio: normalizeAgentBookmarkPageYRatioInput(input, pageIndex, actionId),
            namedDest: namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null,
            bold: getAgentBooleanInput(input, 'bold') ?? false,
            italic: getAgentBooleanInput(input, 'italic') ?? false,
            color: color === null ? null : normalizeBookmarkColor(color),
            items,
        };
    }

    function normalizeAgentBookmarkInput(input: Record<string, unknown>, actionId: string) {
        const rawBookmark = input.bookmark;
        return normalizeAgentBookmarkEntry(
            isAgentRecord(rawBookmark) ? rawBookmark : input,
            actionId,
        );
    }

    function createAgentBookmarkSnapshot() {
        return createAgentBookmarkPlanSnapshot(bookmarkItems.value, {dirty: bookmarksDirty.value});
    }

    function getBlockingBookmarkIssues(snapshot: TAgentBookmarkSnapshot) {
        return snapshot.issues.filter(issue => issue.severity === 'error');
    }

    function getBookmarkIssueKey(issue: TAgentBookmarkIssue) {
        return [
            issue.code,
            issue.path?.join('.') ?? '',
            issue.page ?? '',
        ].join('|');
    }

    function getNewBlockingBookmarkIssues(proposedBookmarks: readonly IPdfBookmarkEntry[]) {
        const currentIssueKeys = new Set(getBlockingBookmarkIssues(createAgentBookmarkSnapshot()).map(getBookmarkIssueKey));
        const proposedSnapshot = createAgentBookmarkPlanSnapshot(proposedBookmarks, {dirty: bookmarksDirty.value});
        return getBlockingBookmarkIssues(proposedSnapshot)
            .filter(issue => !currentIssueKeys.has(getBookmarkIssueKey(issue)));
    }

    function assertAgentBookmarkChangeIsAllowed(
        proposedBookmarks: readonly IPdfBookmarkEntry[],
        actionId: string,
    ) {
        const newBlockingIssues = getNewBlockingBookmarkIssues(proposedBookmarks);
        if (newBlockingIssues.length === 0) {
            return;
        }

        const firstIssue = newBlockingIssues[0];
        if (!firstIssue) {
            return;
        }
        throw new Error(`${actionId} refused to apply unsafe bookmark destinations: ${firstIssue.message}`);
    }

    function updateAgentBookmarks(bookmarks: TAgentMutableBookmarkEntry[]) {
        handleBookmarksChange({
            bookmarks,
            dirty: true,
            history: 'record',
        });
        return createAgentBookmarkSnapshot();
    }

    function setAgentBookmarkTree(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentBookmarkPlan(input, actionId);
        assertAgentBookmarkChangeIsAllowed(plan.bookmarks, actionId);
        return {
            ...updateAgentBookmarks(plan.bookmarks),
            plan,
        };
    }

    function previewAgentBookmarkPlan(input: Record<string, unknown>, actionId: string) {
        return createAgentBookmarkPlan({
            input,
            currentBookmarks: bookmarkItems.value,
            totalPages: totalPages.value,
            dirty: bookmarksDirty.value,
            untitledTitle: t('bookmarks.untitled'),
            actionId,
        });
    }

    function applyAgentBookmarkPlan(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentBookmarkPlan(input, actionId);
        assertAgentBookmarkChangeIsAllowed(plan.bookmarks, actionId);
        return {
            ...updateAgentBookmarks(plan.bookmarks),
            plan,
        };
    }

    function addAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const parentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
        const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
        const bookmark = normalizeAgentBookmarkInput(input, actionId);
        const index = getAgentNumberInput(input, 'index');
        const insertIndex = index === null
            ? list.length
            : Math.min(list.length, Math.max(0, Math.trunc(index)));
        list.splice(insertIndex, 0, bookmark);
        assertAgentBookmarkChangeIsAllowed(bookmarks, actionId);
        return updateAgentBookmarks(bookmarks);
    }

    function addAgentBookmarks(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const batchParentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
        const rawItems = input.bookmarks ?? input.items;
        if (!Array.isArray(rawItems)) {
            throw new Error(`${actionId} requires input.bookmarks or input.items.`);
        }

        rawItems
            .filter(isAgentRecord)
            .forEach((item) => {
                const parentPath = getAgentBookmarkPathInput(item, 'parentPath') ?? batchParentPath;
                const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
                const insertIndex = getAgentNumberInput(item, 'index');
                const bookmark = normalizeAgentBookmarkEntry(item, actionId);
                list.splice(
                    insertIndex === null ? list.length : Math.min(list.length, Math.max(0, Math.trunc(insertIndex))),
                    0,
                    bookmark,
                );
            });
        assertAgentBookmarkChangeIsAllowed(bookmarks, actionId);
        return updateAgentBookmarks(bookmarks);
    }

    function updateAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const location = getBookmarkLocationAtPath(bookmarks, getAgentBookmarkPathInput(input), actionId);
        const bookmarkUpdates = isAgentRecord(input.bookmark) ? input.bookmark : input;
        const updated = {...location.bookmark};
        if (hasAgentInputKey(bookmarkUpdates, 'title')) {
            const rawTitle = getAgentRawStringInput(bookmarkUpdates, 'title')?.trim();
            updated.title = rawTitle && rawTitle.length > 0 ? rawTitle : t('bookmarks.untitled');
        }
        if (
            hasAgentInputKey(bookmarkUpdates, 'page')
            || hasAgentInputKey(bookmarkUpdates, 'pageNumber')
            || hasAgentInputKey(bookmarkUpdates, 'pageIndex')
        ) {
            updated.pageIndex = normalizeAgentBookmarkPageIndex(bookmarkUpdates, actionId);
            updated.pageYRatio = normalizeAgentBookmarkPageYRatioInput(bookmarkUpdates, updated.pageIndex, actionId);
        }
        if (hasAgentBookmarkPageYRatioInput(bookmarkUpdates)) {
            updated.pageYRatio = normalizeAgentBookmarkPageYRatioInput(bookmarkUpdates, updated.pageIndex, actionId);
        }
        if (hasAgentInputKey(bookmarkUpdates, 'namedDest') || hasAgentInputKey(bookmarkUpdates, 'dest')) {
            const namedDest = getAgentRawStringInput(bookmarkUpdates, 'namedDest')
                ?? getAgentRawStringInput(bookmarkUpdates, 'dest')
                ?? null;
            updated.namedDest = namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'bold')) {
            updated.bold = getAgentBooleanInput(bookmarkUpdates, 'bold') ?? false;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'italic')) {
            updated.italic = getAgentBooleanInput(bookmarkUpdates, 'italic') ?? false;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'color')) {
            const color = getAgentNullableStringInput(bookmarkUpdates, 'color');
            updated.color = color === null ? null : normalizeBookmarkColor(color);
        }
        const rawUpdatedItems = Array.isArray(bookmarkUpdates.items) ? bookmarkUpdates.items : bookmarkUpdates.children;
        if (Array.isArray(rawUpdatedItems)) {
            updated.items = rawUpdatedItems
                .filter(isAgentRecord)
                .map(item => normalizeAgentBookmarkEntry(item, actionId));
        }
        location.list.splice(location.index, 1, updated);
        assertAgentBookmarkChangeIsAllowed(bookmarks, actionId);
        return updateAgentBookmarks(bookmarks);
    }

    function deleteAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const location = getBookmarkLocationAtPath(bookmarks, getAgentBookmarkPathInput(input), actionId);
        location.list.splice(location.index, 1);
        return updateAgentBookmarks(bookmarks);
    }

    function deleteAgentBookmarks(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const paths = getAgentBookmarkPathListInput(input, actionId);
        paths.forEach(path => getBookmarkLocationAtPath(bookmarks, path, actionId));
        const rootPaths = resolveRootBookmarkPaths(paths);
        const nextBookmarks = removeBookmarkPaths(bookmarks, rootPaths);
        return updateAgentBookmarks(nextBookmarks);
    }

    function collectAgentBookmarkStyleRangePaths(bookmarks: TAgentMutableBookmarkEntry[], range: unknown, actionId: string) {
        const fromPath = isAgentRecord(range) ? normalizeAgentBookmarkPath(range.from) : null;
        const toPath = isAgentRecord(range) ? normalizeAgentBookmarkPath(range.to) : null;
        if (!fromPath?.length || !toPath?.length) {
            throw new Error(`${actionId} range requires from and to bookmark paths.`);
        }
        const parentPath = fromPath.slice(0, -1);
        if (!pathsAreEqual(parentPath, toPath.slice(0, -1))) {
            throw new Error(`${actionId} range endpoints must be siblings under the same parent.`);
        }
        const fromIndex = fromPath[fromPath.length - 1];
        const toIndex = toPath[toPath.length - 1];
        if (fromIndex === undefined || toIndex === undefined) {
            throw new Error(`${actionId} range requires valid bookmark paths.`);
        }
        const startIndex = Math.min(fromIndex, toIndex);
        const endIndex = Math.max(fromIndex, toIndex);
        if (endIndex >= getBookmarkListAtPath(bookmarks, parentPath, actionId).length) {
            throw new Error(`${actionId} range endpoint ${JSON.stringify(endIndex === fromIndex ? fromPath : toPath)} is outside its parent.`);
        }
        return Array.from({length: endIndex - startIndex + 1}, (_, offset) => [
            ...parentPath,
            startIndex + offset,
        ]);
    }

    function collectAgentBookmarkDepthPaths(bookmarks: TAgentMutableBookmarkEntry[], input: Record<string, unknown>, actionId: string) {
        const depth = getAgentNumberInput(input, 'depth');
        const level = getAgentNumberInput(input, 'level');
        const selectedDepth = depth !== null
            ? Math.max(0, Math.trunc(depth))
            : level !== null
                ? Math.max(0, Math.trunc(level) - 1)
                : null;
        if (selectedDepth === null) {
            return [];
        }
        const scopedParentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
        // Depth stays absolute inside a scoped subtree: walk the scope's children from its own path.
        const scopedItems = scopedParentPath.length === 0
            ? bookmarks
            : getBookmarkLocationAtPath(bookmarks, scopedParentPath, actionId).bookmark.items;
        return flattenBookmarks(scopedItems, scopedParentPath)
            .filter(entry => entry.depth === selectedDepth)
            .map(entry => entry.path);
    }

    function dedupeSortedAgentBookmarkPaths(paths: number[][]) {
        const sorted = [...paths].sort(compareAgentBookmarkPaths);
        return sorted.filter((path, index) => {
            const previous = sorted[index - 1];
            return index === 0 || previous === undefined || !pathsAreEqual(path, previous);
        });
    }

    function resolveAgentBookmarkStyleTargetPaths(
        bookmarks: TAgentMutableBookmarkEntry[],
        input: Record<string, unknown>,
        actionId: string,
    ) {
        const explicitPaths = getAgentBookmarkPathListInput(input, actionId, true);
        explicitPaths.forEach(path => getBookmarkLocationAtPath(bookmarks, path, actionId));
        const rangePaths = hasAgentInputKey(input, 'range')
            ? collectAgentBookmarkStyleRangePaths(bookmarks, input.range, actionId)
            : [];
        const selectedPaths = dedupeSortedAgentBookmarkPaths([
            ...explicitPaths,
            ...rangePaths,
            ...collectAgentBookmarkDepthPaths(bookmarks, input, actionId),
        ]);
        if (selectedPaths.length === 0) {
            throw new Error(`${actionId} did not match any bookmarks.`);
        }
        if (getAgentBooleanInput(input, 'includeDescendants') !== true) {
            return selectedPaths;
        }
        return flattenBookmarks(bookmarks)
            .filter(entry => selectedPaths.some(target => pathStartsWith(entry.path, target)))
            .map(entry => entry.path);
    }

    function getAgentBookmarkStyleUpdate(input: Record<string, unknown>, actionId: string) {
        const rawColor = hasAgentInputKey(input, 'color') ? getAgentNullableStringInput(input, 'color') : undefined;
        if (
            (hasAgentInputKey(input, 'color') && rawColor === undefined)
            || (typeof rawColor === 'string' && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(rawColor))
        ) {
            throw new Error(`${actionId} color must be a hex color such as #336699 or null.`);
        }
        const flag = (key: 'bold' | 'italic') => {
            if (!hasAgentInputKey(input, key)) {
                return undefined;
            }
            const value = getAgentBooleanInput(input, key);
            if (value === null) {
                throw new Error(`${actionId} ${key} must be a boolean.`);
            }
            return value;
        };
        return {
            bold: flag('bold'),
            italic: flag('italic'),
            color: typeof rawColor === 'string' ? normalizeBookmarkColor(rawColor) : rawColor,
        };
    }

    type TAgentBookmarkStyleUpdate = ReturnType<typeof getAgentBookmarkStyleUpdate>;

    function applyAgentBookmarkStyleAtPath(bookmarks: TAgentMutableBookmarkEntry[], path: number[], styleUpdate: TAgentBookmarkStyleUpdate, actionId: string) {
        const location = getBookmarkLocationAtPath(bookmarks, path, actionId);
        const updated = {
            ...location.bookmark,
            bold: styleUpdate.bold ?? location.bookmark.bold,
            italic: styleUpdate.italic ?? location.bookmark.italic,
            color: styleUpdate.color === undefined ? location.bookmark.color : styleUpdate.color,
        };
        if (
            updated.bold === location.bookmark.bold
            && updated.italic === location.bookmark.italic
            && updated.color === location.bookmark.color
        ) {
            return false;
        }
        location.list.splice(location.index, 1, updated);
        return true;
    }

    // Style-only edits cannot create unsafe destinations, so the destination
    // guard is skipped; a run that changes nothing records no undo entry.
    function setAgentBookmarkStyle(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const targetPaths = resolveAgentBookmarkStyleTargetPaths(bookmarks, input, actionId);
        const styleUpdate = getAgentBookmarkStyleUpdate(input, actionId);
        let changedCount = 0;
        for (const path of targetPaths) {
            if (applyAgentBookmarkStyleAtPath(bookmarks, path, styleUpdate, actionId)) {
                changedCount += 1;
            }
        }
        return {
            ...(changedCount === 0 ? createAgentBookmarkSnapshot() : updateAgentBookmarks(bookmarks)),
            targetCount: targetPaths.length,
            changedCount,
            targetPaths: targetPaths.slice(0, MAX_AGENT_BOOKMARK_STYLE_TARGET_PATHS),
            targetPathsTruncated: targetPaths.length > MAX_AGENT_BOOKMARK_STYLE_TARGET_PATHS,
        };
    }

    return {
        addAgentBookmark,
        addAgentBookmarks,
        applyAgentBookmarkPlan,
        createAgentBookmarkSnapshot,
        deleteAgentBookmark,
        deleteAgentBookmarks,
        previewAgentBookmarkPlan,
        setAgentBookmarkStyle,
        setAgentBookmarkTree,
        updateAgentBookmark,
    };
}
