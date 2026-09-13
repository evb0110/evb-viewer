import type { Ref } from 'vue';
import { isEqual } from 'es-toolkit/predicate';
import {
    getAgentNumberInput,
    getAgentRawStringInput,
    isAgentRecord,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    getAgentPageNumberInput,
    normalizeAgentPageNumber,
    requireAgentPdfPageCount,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type {
    IPdfPageLabelRange,
    TPageLabelStyle,
} from '@app/types/pdfContracts';
import {
    applyPageLabelRange,
    applySparsePageLabelUpdates,
    buildPageLabelSegments,
    buildPageLabelsFromRanges,
    countPageLabelDifferences,
    createPageLabelModel,
    derivePageLabelRangesFromLabels,
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
    PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES,
    type IDocumentPageLabelModel,
    type TDocumentPageLabelLookup,
} from '@app/modules/document-viewer/public';

type TAgentMetadataIssueSeverity = 'error' | 'warning' | 'info';
type TAgentPageLabelInputMode = 'ranges' | 'segments' | 'labels';

interface IAgentMetadataIssue {
    severity: TAgentMetadataIssueSeverity;
    code: string;
    message: string;
    page?: number | null;
    path?: number[];
}

interface IAgentPageLabelSegment {
    startPage: number;
    endPage: number;
    pageCount: number;
    style: TPageLabelStyle;
    prefix: string;
    startNumber: number;
    startLabel: string;
    endLabel: string;
}

interface IAgentPageLabelSample {
    page: number;
    label: string;
}

interface IAgentPageLabelSnapshot {
    totalPages: number;
    dirty: boolean;
    isDefault: boolean;
    summary: {
        rangeCount: number;
        firstLabel: string | null;
        lastLabel: string | null;
        duplicateLabelCount: number;
    };
    issues: IAgentMetadataIssue[];
    ranges: IPdfPageLabelRange[];
    segments: IAgentPageLabelSegment[];
    samples: IAgentPageLabelSample[];
    labels: string[] | null;
    viewerState?: {
        displayMode: 'pdf-labels' | 'physical-pages';
        expectedDisplayMode: 'pdf-labels' | 'physical-pages';
        labelsMaterialized: boolean;
        matchesMetadata: boolean;
        lookup: 'range-model' | 'array' | 'none';
        resolved: boolean;
    };
}

interface IAgentPageLabelPlan {
    inputMode: TAgentPageLabelInputMode;
    ranges: IPdfPageLabelRange[];
    proposed: IAgentPageLabelSnapshot;
    diff: {
        wouldChange: boolean;
        changedPageCount: number;
        unchangedPageCount: number;
        firstChangedPage: number | null;
        lastChangedPage: number | null;
        changedPages: Array<{
            page: number;
            before: string;
            after: string;
        }>;
    };
    issues: IAgentMetadataIssue[];
}

const AGENT_PAGE_LABEL_STYLES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const satisfies ReadonlyArray<Exclude<TPageLabelStyle, null>>;

const MAX_ISSUE_COUNT = 50;
const MAX_DIFF_SAMPLE_COUNT = 50;
const MAX_LABEL_SAMPLE_COUNT = 40;

function hasInputKey(input: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(input, key);
}

function getRawStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' ? value : null;
}

function getStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = getRawStringInput(input, key);
    return value !== null && value.trim().length > 0 ? value.trim() : null;
}

function getNumberInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function pushIssue(issues: IAgentMetadataIssue[], issue: IAgentMetadataIssue) {
    if (issues.length < MAX_ISSUE_COUNT) {
        issues.push(issue);
    }
}

function requirePageCount(totalPages: number, actionId: string) {
    if (totalPages <= 0) {
        throw new Error(`${actionId} requires an open PDF document.`);
    }
    return totalPages;
}

function normalizePageNumber(value: number | null | undefined, totalPages: number, actionId: string) {
    requirePageCount(totalPages, actionId);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${actionId} requires a valid one-based page number.`);
    }
    const page = Math.trunc(value);
    if (page < 1 || page > totalPages) {
        throw new Error(`${actionId} page ${page} is outside the document.`);
    }
    return page;
}

function getPageNumberInput(input: Record<string, unknown>, totalPages: number, actionId: string) {
    return normalizePageNumber(
        getNumberInput(input, 'page') ?? getNumberInput(input, 'pageNumber') ?? getNumberInput(input, 'startPage'),
        totalPages,
        actionId,
    );
}

function normalizeAgentPageLabelStyle(value: unknown): TPageLabelStyle {
    if (value === null) {
        return null;
    }
    if (isOneOf(AGENT_PAGE_LABEL_STYLES, value)) {
        return value;
    }
    if (typeof value !== 'string') {
        return 'D';
    }

    switch (value.trim().toLowerCase()) {
        case 'decimal':
        case 'number':
        case 'numbers':
        case 'arabic':
            return 'D';
        case 'roman':
        case 'roman-upper':
        case 'uppercase-roman':
            return 'R';
        case 'roman-lower':
        case 'lowercase-roman':
            return 'r';
        case 'letters':
        case 'letters-upper':
        case 'alpha':
        case 'alpha-upper':
        case 'uppercase-alpha':
            return 'A';
        case 'letters-lower':
        case 'alpha-lower':
        case 'lowercase-alpha':
            return 'a';
        case 'literal':
        case 'none':
        case 'prefix':
        case '':
            return null;
        default:
            return 'D';
    }
}

function normalizePageLabelRangeInput(
    input: Record<string, unknown>,
    totalPages: number,
    actionId: string,
): IPdfPageLabelRange {
    const literalLabel = getRawStringInput(input, 'label');
    const hasExplicitStyle = hasInputKey(input, 'style') || hasInputKey(input, 'numberStyle') || hasInputKey(input, 'format');
    const hasExplicitPrefix = hasInputKey(input, 'prefix');
    return {
        startPage: getPageNumberInput(input, totalPages, actionId),
        style: !hasExplicitStyle && !hasExplicitPrefix && literalLabel !== null
            ? null
            : normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
        prefix: !hasExplicitStyle && !hasExplicitPrefix && literalLabel !== null
            ? literalLabel
            : getRawStringInput(input, 'prefix') ?? '',
        startNumber: Math.max(1, Math.trunc(
            getNumberInput(input, 'startNumber')
            ?? getNumberInput(input, 'number')
            ?? 1,
        )),
    };
}

function normalizeEndPageInput(
    input: Record<string, unknown>,
    startPage: number,
    totalPages: number,
    actionId: string,
) {
    const endPage = normalizePageNumber(
        getNumberInput(input, 'endPage')
        ?? getNumberInput(input, 'toPage')
        ?? getNumberInput(input, 'lastPage')
        ?? startPage,
        totalPages,
        actionId,
    );
    if (endPage < startPage) {
        throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
    }
    return endPage;
}

function createDefaultRanges(totalPages: number) {
    return normalizePageLabelRanges([{
        startPage: 1,
        style: 'D',
        prefix: '',
        startNumber: 1,
    }], totalPages);
}

function createPageLabelLookup(
    totalPages: number,
    ranges: IPdfPageLabelRange[],
    labels: readonly string[] | null,
): TDocumentPageLabelLookup {
    if (
        labels
        && labels.length === totalPages
        && totalPages <= PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
    ) {
        return labels;
    }
    return createPageLabelModel(totalPages, ranges);
}

function chooseBaseRanges(
    input: Record<string, unknown>,
    totalPages: number,
    currentRanges: IPdfPageLabelRange[],
) {
    const base = getStringInput(input, 'base') ?? getStringInput(input, 'baseLabels');
    return base === 'default' || base === 'physical'
        ? createDefaultRanges(totalPages)
        : currentRanges;
}

function applyPageLabelSegmentToRanges(
    ranges: IPdfPageLabelRange[],
    segment: Record<string, unknown>,
    totalPages: number,
    actionId: string,
) {
    const range = normalizePageLabelRangeInput(segment, totalPages, actionId);
    const endPage = normalizeEndPageInput(segment, range.startPage, totalPages, actionId);
    return applyPageLabelRange(
        totalPages,
        ranges,
        {
            startPage: range.startPage,
            endPage,
        },
        range,
    );
}

function applyExplicitLabelsToRanges(
    ranges: IPdfPageLabelRange[],
    input: Record<string, unknown>,
    totalPages: number,
    actionId: string,
) {
    const rawLabels = input.labels;
    if (Array.isArray(rawLabels)) {
        const startPage = normalizePageNumber(
            getNumberInput(input, 'startPage') ?? getNumberInput(input, 'page') ?? 1,
            totalPages,
            actionId,
        );
        const rawLabelValues: readonly unknown[] = rawLabels;
        function* updates() {
            const endIndex = Math.min(
                rawLabelValues.length,
                totalPages - startPage + 1,
            );
            for (let index = 0; index < endIndex; index += 1) {
                const label = rawLabelValues[index];
                yield {
                    page: startPage + index,
                    label: typeof label === 'string' ? label : '',
                };
            }
        }
        ranges = applySparsePageLabelUpdates(totalPages, ranges, updates());
    }

    const updates = input.updates;
    if (Array.isArray(updates)) {
        const updateValues: readonly unknown[] = updates;
        function* normalizedUpdates() {
            for (const value of updateValues) {
                if (!isRecord(value)) {
                    continue;
                }
                yield {
                    page: normalizePageNumber(
                        getNumberInput(value, 'page') ?? getNumberInput(value, 'pageNumber'),
                        totalPages,
                        actionId,
                    ),
                    label: getRawStringInput(value, 'label') ?? '',
                };
            }
        }
        ranges = applySparsePageLabelUpdates(totalPages, ranges, normalizedUpdates());
    }

    if (!Array.isArray(rawLabels) && !Array.isArray(updates) && hasInputKey(input, 'label')) {
        const page = normalizePageNumber(
            getNumberInput(input, 'page') ?? getNumberInput(input, 'pageNumber'),
            totalPages,
            actionId,
        );
        ranges = applySparsePageLabelUpdates(totalPages, ranges, [{
            page,
            label: getRawStringInput(input, 'label') ?? '',
        }]);
    }

    return ranges;
}

function createRangesFromPageLabelInput(
    input: Record<string, unknown>,
    totalPages: number,
    currentRanges: IPdfPageLabelRange[],
    actionId: string,
) {
    const rawRanges = input.ranges;
    if (Array.isArray(rawRanges)) {
        return {
            inputMode: 'ranges' as const,
            ranges: normalizePageLabelRanges(
                rawRanges
                    .filter(isRecord)
                    .map(range => normalizePageLabelRangeInput(range, totalPages, actionId)),
                totalPages,
            ),
        };
    }

    const rawSegments = input.segments;
    if (Array.isArray(rawSegments)) {
        let ranges = chooseBaseRanges(input, totalPages, currentRanges);
        const segments = rawSegments.filter(isRecord);
        for (const segment of segments) {
            ranges = applyPageLabelSegmentToRanges(ranges, segment, totalPages, actionId);
        }
        return {
            inputMode: 'segments' as const,
            ranges,
        };
    }

    if (
        Array.isArray(input.labels)
        || Array.isArray(input.updates)
        || hasInputKey(input, 'label')
    ) {
        let ranges = chooseBaseRanges(input, totalPages, currentRanges);
        const rawLabels = input.labels;
        const startPage = getNumberInput(input, 'startPage')
            ?? getNumberInput(input, 'page')
            ?? 1;
        if (
            Array.isArray(rawLabels)
            && startPage === 1
            && rawLabels.length === totalPages
        ) {
            const exactLabels = rawLabels.every(label => typeof label === 'string')
                ? rawLabels
                : rawLabels.map(label => typeof label === 'string' ? label : '');
            ranges = derivePageLabelRangesFromLabels(exactLabels, totalPages);
        } else {
            ranges = applyExplicitLabelsToRanges(ranges, input, totalPages, actionId);
        }
        return {
            inputMode: 'labels' as const,
            ranges: normalizePageLabelRanges(ranges, totalPages),
        };
    }

    throw new Error(`${actionId} requires input.ranges, input.segments, input.labels, input.updates, or input.label.`);
}

function createPageLabelSegments(
    ranges: IPdfPageLabelRange[],
    lookup: TDocumentPageLabelLookup,
    totalPages: number,
) {
    return buildPageLabelSegments(totalPages, ranges).map((segment): IAgentPageLabelSegment => {
        return {
            startPage: segment.startPage,
            endPage: segment.endPage,
            pageCount: Math.max(0, segment.endPage - segment.startPage + 1),
            style: segment.style,
            prefix: segment.prefix,
            startNumber: segment.startNumber,
            startLabel: lookupLabel(lookup, segment.startPage),
            endLabel: lookupLabel(lookup, segment.endPage),
        };
    });
}

function lookupLabel(lookup: TDocumentPageLabelLookup, page: number) {
    if (isPageLabelArray(lookup)) {
        return lookup[page - 1] ?? '';
    }
    return lookup?.labelAt(page) ?? '';
}

function lookupMatchesModel(
    lookup: TDocumentPageLabelLookup,
    model: IDocumentPageLabelModel,
    totalPages: number,
) {
    if (isPageLabelArray(lookup)) {
        return lookup.length === totalPages
            && lookup.every((label, index) => label === model.labelAt(index + 1));
    }
    return lookup?.totalPages === totalPages && isEqual(lookup.ranges, model.ranges);
}

function isPageLabelArray(
    lookup: TDocumentPageLabelLookup,
): lookup is readonly string[] {
    return Array.isArray(lookup);
}

function createPageLabelSamples(
    ranges: IPdfPageLabelRange[],
    lookup: TDocumentPageLabelLookup,
    totalPages: number,
) {
    const pages = new Set<number>();
    [
        1,
        2,
        totalPages - 1,
        totalPages,
    ].forEach(page => {
        if (page >= 1 && page <= totalPages) {
            pages.add(page);
        }
    });

    for (const segment of createPageLabelSegments(ranges, lookup, totalPages)) {
        [
            segment.startPage,
            segment.startPage + 1,
            segment.endPage - 1,
            segment.endPage,
        ].forEach(page => {
            if (page >= 1 && page <= totalPages) {
                pages.add(page);
            }
        });
        if (pages.size >= MAX_LABEL_SAMPLE_COUNT) {
            break;
        }
    }

    return Array.from(pages)
        .sort((left, right) => left - right)
        .slice(0, MAX_LABEL_SAMPLE_COUNT)
        .map(page => ({
            page,
            label: lookupLabel(lookup, page),
        }));
}

function createDuplicateLabelIssues(
    ranges: IPdfPageLabelRange[],
    lookup: TDocumentPageLabelLookup,
    totalPages: number,
) {
    const counts = new Map<string, number>();
    if (isPageLabelArray(lookup)) {
        for (const label of lookup) {
            if (!label) {
                continue;
            }
            counts.set(label, (counts.get(label) ?? 0) + 1);
        }
    } else {
        for (const segment of buildPageLabelSegments(totalPages, ranges)) {
            if (segment.style === null && segment.prefix) {
                counts.set(
                    segment.prefix,
                    (counts.get(segment.prefix) ?? 0) + segment.endPage - segment.startPage + 1,
                );
            }
        }
    }

    return Array.from(counts.entries())
        .filter(([
            , count,
        ]) => count > 1)
        .slice(0, 10)
        .map(([
            label,
            count,
        ]): IAgentMetadataIssue => ({
            severity: 'info',
            code: 'duplicate_page_label',
            message: `Page label "${label}" appears on ${count} pages.`,
        }));
}

function createPageLabelIssues(
    ranges: IPdfPageLabelRange[],
    lookup: TDocumentPageLabelLookup,
    totalPages: number,
) {
    const issues = createDuplicateLabelIssues(ranges, lookup, totalPages);
    const segments = createPageLabelSegments(ranges, lookup, totalPages);
    for (const segment of segments) {
        if (segment.style === null && segment.pageCount > 1) {
            pushIssue(issues, {
                severity: 'warning',
                code: 'repeated_literal_label_range',
                message: `Literal label "${segment.prefix}" repeats from page ${segment.startPage} to ${segment.endPage}.`,
                page: segment.startPage,
            });
        }
    }
    return issues;
}

function countDuplicateLabels(
    ranges: IPdfPageLabelRange[],
    lookup: TDocumentPageLabelLookup,
    totalPages: number,
) {
    if (!isPageLabelArray(lookup)) {
        let duplicateCount = 0;
        const counts = new Map<string, number>();
        for (const segment of buildPageLabelSegments(totalPages, ranges)) {
            if (segment.style !== null || !segment.prefix) {
                continue;
            }
            const count = counts.get(segment.prefix) ?? 0;
            const segmentCount = segment.endPage - segment.startPage + 1;
            duplicateCount += Math.max(0, count + segmentCount - 1) - Math.max(0, count - 1);
            counts.set(segment.prefix, count + segmentCount);
        }
        return duplicateCount;
    }

    const counts = new Map<string, number>();
    let duplicateCount = 0;
    for (const label of lookup) {
        if (!label) {
            continue;
        }
        const count = counts.get(label) ?? 0;
        if (count === 1) {
            duplicateCount += 1;
        }
        counts.set(label, count + 1);
    }
    return duplicateCount;
}

export function createAgentPageLabelSnapshot(options: {
    totalPages: number;
    dirty: boolean;
    pageLabelRanges: readonly IPdfPageLabelRange[];
    pageLabels?: readonly string[] | null;
    pageLabelModel?: IDocumentPageLabelModel;
}): IAgentPageLabelSnapshot {
    const totalPages = Math.max(0, Math.trunc(options.totalPages));
    const ranges = normalizePageLabelRanges([...options.pageLabelRanges], totalPages);
    const labels = totalPages > 0 && totalPages <= PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
        ? options.pageLabels && options.pageLabels.length === totalPages
            ? [...options.pageLabels]
            : buildPageLabelsFromRanges(totalPages, ranges)
        : null;
    const lookup = labels
        ?? (
            options.pageLabelModel?.totalPages === totalPages
                ? options.pageLabelModel
                : null
        )
        ?? createPageLabelLookup(totalPages, ranges, labels);
    const issues = createPageLabelIssues(ranges, lookup, totalPages);
    return {
        totalPages,
        dirty: options.dirty,
        isDefault: isImplicitDefaultPageLabels(ranges, totalPages),
        summary: {
            rangeCount: ranges.length,
            firstLabel: totalPages > 0 ? lookupLabel(lookup, 1) : null,
            lastLabel: totalPages > 0 ? lookupLabel(lookup, totalPages) : null,
            duplicateLabelCount: countDuplicateLabels(ranges, lookup, totalPages),
        },
        issues,
        ranges,
        segments: createPageLabelSegments(ranges, lookup, totalPages),
        samples: createPageLabelSamples(ranges, lookup, totalPages),
        labels,
    };
}

function createPageLabelDiff(options: {
    totalPages: number;
    beforeRanges: readonly IPdfPageLabelRange[];
    afterRanges: readonly IPdfPageLabelRange[];
    beforeLabels: readonly string[] | null;
    afterLabels: readonly string[] | null;
}) {
    const changedPages: IAgentPageLabelPlan['diff']['changedPages'] = [];
    let firstChangedPage: number | null = null;
    let lastChangedPage: number | null = null;
    let changedPageCount = 0;

    const beforeLookup = createPageLabelLookup(
        options.totalPages,
        [...options.beforeRanges],
        options.beforeLabels,
    );
    const afterLookup = createPageLabelLookup(
        options.totalPages,
        [...options.afterRanges],
        options.afterLabels,
    );

    if (
        options.beforeLabels !== null
        && options.afterLabels !== null
        && options.totalPages <= PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
    ) {
        const pageCount = Math.max(options.beforeLabels.length, options.afterLabels.length);
        for (let index = 0; index < pageCount; index += 1) {
            const before = options.beforeLabels[index] ?? '';
            const after = options.afterLabels[index] ?? '';
            if (before === after) {
                continue;
            }
            const page = index + 1;
            changedPageCount += 1;
            firstChangedPage ??= page;
            lastChangedPage = page;
            if (changedPages.length < MAX_DIFF_SAMPLE_COUNT) {
                changedPages.push({
                    page,
                    before,
                    after,
                });
            }
        }
    } else {
        changedPageCount = countPageLabelDifferences(
            options.totalPages,
            options.beforeRanges,
            options.afterRanges,
        );
        const samplePages = new Set<number>([
            1,
            2,
            options.totalPages - 1,
            options.totalPages,
        ]);
        for (const range of [
            ...options.beforeRanges,
            ...options.afterRanges,
        ]) {
            samplePages.add(range.startPage);
            samplePages.add(range.startPage + 1);
            samplePages.add(range.startPage - 1);
        }
        for (const page of Array.from(samplePages).sort((left, right) => left - right)) {
            if (page < 1 || page > options.totalPages) {
                continue;
            }
            const before = lookupLabel(beforeLookup, page);
            const after = lookupLabel(afterLookup, page);
            if (before === after) {
                continue;
            }
            firstChangedPage = firstChangedPage === null ? page : Math.min(firstChangedPage, page);
            lastChangedPage = lastChangedPage === null ? page : Math.max(lastChangedPage, page);
            if (changedPages.length < MAX_DIFF_SAMPLE_COUNT) {
                changedPages.push({
                    page,
                    before,
                    after,
                });
            }
        }
        if (changedPageCount > 0 && firstChangedPage === null) {
            firstChangedPage = 1;
            lastChangedPage = options.totalPages;
        }
    }

    return {
        wouldChange: changedPageCount > 0,
        changedPageCount,
        unchangedPageCount: Math.max(0, options.totalPages - changedPageCount),
        firstChangedPage,
        lastChangedPage,
        changedPages,
    };
}

export function createAgentPageLabelPlan(options: {
    input: Record<string, unknown>;
    totalPages: number;
    currentRanges: readonly IPdfPageLabelRange[];
    currentLabels?: readonly string[] | null;
    dirty: boolean;
    actionId: string;
}): IAgentPageLabelPlan {
    const totalPages = requirePageCount(options.totalPages, options.actionId);
    const currentRanges = normalizePageLabelRanges([...options.currentRanges], totalPages);
    const beforeLabels = totalPages <= PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
        ? options.currentLabels && options.currentLabels.length === totalPages
            ? [...options.currentLabels]
            : buildPageLabelsFromRanges(totalPages, currentRanges)
        : null;
    const plan = createRangesFromPageLabelInput(
        options.input,
        totalPages,
        currentRanges,
        options.actionId,
    );
    const proposed = createAgentPageLabelSnapshot({
        totalPages,
        dirty: options.dirty,
        pageLabelRanges: plan.ranges,
        pageLabels: null,
    });

    return {
        inputMode: plan.inputMode,
        ranges: proposed.ranges,
        proposed,
        diff: createPageLabelDiff({
            totalPages,
            beforeRanges: currentRanges,
            afterRanges: plan.ranges,
            beforeLabels,
            afterLabels: proposed.labels,
        }),
        issues: proposed.issues,
    };
}

const createAgentPageLabelPlanSnapshot = createAgentPageLabelSnapshot;

interface ICreateDocumentAgentPageLabelsOptions {
    handlePageLabelRangesUpdate: (ranges: IPdfPageLabelRange[]) => void;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabels: Ref<string[] | null>;
    pageLabelModel?: Ref<IDocumentPageLabelModel | null> | undefined;
    pageLabelsResolved?: Ref<boolean> | undefined;
    pageLabelsDirty: Ref<boolean>;
    totalPages: Ref<number>;
}

export function createDocumentAgentPageLabels(options: ICreateDocumentAgentPageLabelsOptions) {
    const {
        handlePageLabelRangesUpdate,
        pageLabelModel,
        pageLabelRanges,
        pageLabels,
        pageLabelsResolved,
        pageLabelsDirty,
        totalPages,
    } = options;

    function normalizeAgentPageLabelRange(input: Record<string, unknown>, actionId: string): IPdfPageLabelRange {
        return {
            startPage: getAgentPageNumberInput(input, totalPages.value, actionId),
            style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
            prefix: getAgentRawStringInput(input, 'prefix') ?? '',
            startNumber: Math.max(1, Math.trunc(
                getAgentNumberInput(input, 'startNumber')
                ?? getAgentNumberInput(input, 'number')
                ?? 1,
            )),
        };
    }

    function createAgentPageLabelSnapshot() {
        const viewerLabelsResolved = pageLabelsResolved?.value ?? true;
        const viewerModel = viewerLabelsResolved
            && pageLabelModel?.value?.totalPages === totalPages.value
            ? pageLabelModel.value
            : null;
        const expectedModel = createPageLabelModel(totalPages.value, pageLabelRanges.value);
        const snapshot = createAgentPageLabelPlanSnapshot({
            totalPages: totalPages.value,
            dirty: pageLabelsDirty.value,
            pageLabelRanges: pageLabelRanges.value,
            pageLabels: pageLabels.value,
            pageLabelModel: expectedModel,
        });
        const expectedIsDefault = isImplicitDefaultPageLabels(
            pageLabelRanges.value,
            totalPages.value,
        );
        const viewerLookup: TDocumentPageLabelLookup = viewerModel
            ?? (pageLabels.value?.length === totalPages.value ? pageLabels.value : null);
        const viewerMatchesMetadata = viewerLabelsResolved && (viewerLookup === null
            ? expectedIsDefault
            : lookupMatchesModel(viewerLookup, expectedModel, totalPages.value));
        const viewerLabelsMaterialized = Array.isArray(viewerLookup);
        const viewerDisplayMode = viewerLookup === null ? 'physical-pages' : 'pdf-labels';
        const expectedDisplayMode = expectedIsDefault ? 'physical-pages' : 'pdf-labels';
        const viewerLookupKind = viewerModel
            ? 'range-model' as const
            : pageLabels.value?.length === totalPages.value
                ? 'array' as const
                : 'none' as const;
        return {
            ...snapshot,
            viewerState: {
                displayMode: viewerDisplayMode,
                expectedDisplayMode,
                labelsMaterialized: viewerLabelsMaterialized,
                matchesMetadata: viewerMatchesMetadata,
                lookup: viewerLookupKind,
                resolved: viewerLabelsResolved,
            },
            issues: !viewerLabelsResolved
                ? [
                    ...snapshot.issues,
                    {
                        severity: 'warning' as const,
                        code: 'viewer_page_labels_unresolved',
                        message: 'The viewer page-label lookup is still resolving; do not claim the visible page indicator is verified.',
                    },
                ]
                : viewerMatchesMetadata === false
                    ? [
                        ...snapshot.issues,
                        {
                            severity: 'warning' as const,
                            code: 'viewer_page_labels_out_of_sync',
                            message: 'The viewer page indicator is not using the current PDF page-label metadata.',
                        },
                    ]
                    : snapshot.issues,
        };
    }

    function updateAgentPageLabelRanges(ranges: IPdfPageLabelRange[]) {
        handlePageLabelRangesUpdate(ranges);
        return createAgentPageLabelSnapshot();
    }

    function getAgentPageLabelRangesInput(input: Record<string, unknown>, actionId: string) {
        const rawRanges = input.ranges;
        if (!Array.isArray(rawRanges)) {
            throw new Error(`${actionId} requires input.ranges.`);
        }
        return rawRanges
            .filter(isAgentRecord)
            .map(range => normalizeAgentPageLabelRange(range, actionId));
    }

    function getAgentPageLabelApplyRangeOptions(input: Record<string, unknown>, actionId: string) {
        const startPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'startPage') ?? getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
            totalPages.value,
            actionId,
        );
        const endPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'endPage') ?? getAgentNumberInput(input, 'toPage') ?? startPage,
            totalPages.value,
            actionId,
        );
        if (endPage < startPage) {
            throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
        }
        return {
            startPage,
            endPage,
            style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
            prefix: getAgentRawStringInput(input, 'prefix') ?? '',
            startNumber: Math.max(1, Math.trunc(
                getAgentNumberInput(input, 'startNumber')
                ?? getAgentNumberInput(input, 'number')
                ?? 1,
            )),
        };
    }

    function applyAgentPageLabelsToRange(input: Record<string, unknown>, actionId: string) {
        const {
            startPage,
            endPage,
            style,
            prefix,
            startNumber,
        } = getAgentPageLabelApplyRangeOptions(input, actionId);
        return updateAgentPageLabelRanges(applyPageLabelRange(
            totalPages.value,
            pageLabelRanges.value,
            {
                startPage,
                endPage,
            },
            {
                style,
                prefix,
                startNumber,
            },
        ));
    }

    function setAgentPageLabels(input: Record<string, unknown>, actionId: string) {
        const pageCount = requireAgentPdfPageCount(totalPages.value, actionId);
        let ranges = normalizePageLabelRanges(pageLabelRanges.value, pageCount);
        const rawLabels = input.labels;
        if (Array.isArray(rawLabels)) {
            if (rawLabels.length === pageCount) {
                const exactLabels = rawLabels.every(label => typeof label === 'string')
                    ? rawLabels
                    : rawLabels.map(label => typeof label === 'string' ? label : '');
                ranges = derivePageLabelRangesFromLabels(exactLabels, pageCount);
            } else {
                const rawLabelValues: readonly unknown[] = rawLabels;
                function* updates() {
                    for (let index = 0; index < rawLabelValues.length; index += 1) {
                        const page = index + 1;
                        if (page > pageCount) {
                            break;
                        }
                        const label = rawLabelValues[index];
                        yield {
                            page,
                            label: typeof label === 'string' ? label : '',
                        };
                    }
                }
                ranges = applySparsePageLabelUpdates(
                    pageCount,
                    ranges,
                    updates(),
                );
            }
        }

        const updates = input.updates;
        if (Array.isArray(updates)) {
            const updateValues: readonly unknown[] = updates;
            function* normalizedUpdates() {
                for (const value of updateValues) {
                    if (!isAgentRecord(value)) {
                        continue;
                    }
                    yield {
                        page: getAgentPageNumberInput(value, totalPages.value, actionId),
                        label: getAgentRawStringInput(value, 'label') ?? '',
                    };
                }
            }
            ranges = applySparsePageLabelUpdates(
                pageCount,
                ranges,
                normalizedUpdates(),
            );
        }

        if (!Array.isArray(rawLabels) && !Array.isArray(updates)) {
            const page = getAgentPageNumberInput(input, totalPages.value, actionId);
            ranges = applySparsePageLabelUpdates(pageCount, ranges, [{
                page,
                label: getAgentRawStringInput(input, 'label') ?? '',
            }]);
        }

        return updateAgentPageLabelRanges(ranges);
    }

    function previewAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
        const plan = createAgentPageLabelPlan({
            input,
            totalPages: totalPages.value,
            currentRanges: pageLabelRanges.value,
            currentLabels: pageLabels.value,
            dirty: pageLabelsDirty.value,
            actionId,
        });
        const currentSnapshot = createAgentPageLabelSnapshot();
        const viewerIssues = currentSnapshot.issues.filter(issue => (
            issue.code === 'viewer_page_labels_unresolved'
            || issue.code === 'viewer_page_labels_out_of_sync'
        ));
        return {
            ...plan,
            currentViewerState: currentSnapshot.viewerState,
            issues: [
                ...plan.issues,
                ...viewerIssues,
            ],
        };
    }

    function applyAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentPageLabelPlan(input, actionId);
        const snapshot = updateAgentPageLabelRanges(plan.ranges);
        return {
            ...snapshot,
            plan,
        };
    }

    return {
        applyAgentPageLabelPlan,
        applyAgentPageLabelsToRange,
        createAgentPageLabelSnapshot,
        getAgentPageLabelRangesInput,
        previewAgentPageLabelPlan,
        setAgentPageLabels,
        updateAgentPageLabelRanges,
    };
}
