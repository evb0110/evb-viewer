import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    applySparsePageLabelUpdates,
    buildPageLabelsFromRanges,
    buildWholeDocumentPageLabelRanges,
    countPageLabelDifferences,
    createPageLabelModel,
    derivePageLabelRangesFromLabels,
    findPageByPageLabelInput,
    formatPageIndicatorWithOptions,
    getVisiblePageLabel,
    materializePageLabelsForCompatibility,
    getMaxPageIndicatorLength,
    getPageIndicatorLayoutMetrics,
    getPageLabelStartNumberMax,
    normalizePageLabelRanges,
    replacePageLabelRange,
} from '@app/modules/document-viewer/pageLabels';
import { ref } from 'vue';
import { formatPageLabelForDisplay } from '@pdf-core/pdfPageLabels';
import type { IPdfPageLabelRange } from '@contracts/pdfPageLabels';
import { createDocumentAgentPageLabels } from '@app/modules/workspace-shell/agent/createDocumentAgentPageLabels';

describe('document page labels', () => {
    it('uses the last numeric page for default labels', () => {
        expect(getMaxPageIndicatorLength(348, null)).toBe(3);
    });

    it('reserves enough width for the longest formatted logical label', () => {
        const pageLabels = [
            'ix',
            'x',
            'A-12',
            'Appendix',
        ];

        const expected = Math.max(...pageLabels.map((_, index) => formatPageIndicatorWithOptions(index + 1, pageLabels).length));

        expect(getMaxPageIndicatorLength(pageLabels.length, pageLabels)).toBe(expected);
    });

    it('falls back to numeric width when labels do not match page count', () => {
        expect(getMaxPageIndicatorLength(120, [
            'i',
            'ii',
        ])).toBe(3);
    });

    it('supports compact page-indicator length calculations for the toolbar', () => {
        const pageLabels = [
            'i',
            'ii',
            'iii',
            'iv',
            'v',
            'vi',
            'vii',
            'viii',
            'ix',
            'x',
            'xi',
            'xii',
            'xiii',
            'xiv',
            'xv',
            'xvi',
        ];

        const expected = Math.max(...pageLabels.map((_, index) => formatPageIndicatorWithOptions(
            index + 1,
            pageLabels,
            { compactPhysicalPage: true },
        ).length));

        expect(getMaxPageIndicatorLength(16, pageLabels, { compactPhysicalPage: true })).toBe(expected);
    });

    it('keeps the default page indicator spacing for general UI', () => {
        expect(formatPageIndicatorWithOptions(16, [
            'i',
            'ii',
            'iii',
            'iv',
            'v',
            'vi',
            'vii',
            'viii',
            'ix',
            'x',
            'xi',
            'xii',
            'xiii',
            'xiv',
            'xv',
            'xvi',
        ])).toBe('xvi (16)');
    });

    it('supports a compact toolbar indicator without the extra space', () => {
        expect(formatPageIndicatorWithOptions(16, [
            'i',
            'ii',
            'iii',
            'iv',
            'v',
            'vi',
            'vii',
            'viii',
            'ix',
            'x',
            'xi',
            'xii',
            'xiii',
            'xiv',
            'xv',
            'xvi',
        ], { compactPhysicalPage: true })).toBe('xvi(16)');
    });

    it('sizes page indicator display without mirroring the total width', () => {
        const totalPages = 348;
        const pageLabels = Array.from({ length: totalPages }, (_, index) => {
            if (index < 17) {
                return [
                    'i',
                    'ii',
                    'iii',
                    'iv',
                    'v',
                    'vi',
                    'vii',
                    'viii',
                    'ix',
                    'x',
                    'xi',
                    'xii',
                    'xiii',
                    'xiv',
                    'xv',
                    'xvi',
                    'xvii',
                ][index] ?? String(index + 1);
            }

            return String(index - 16);
        });

        expect(getPageIndicatorLayoutMetrics(totalPages, pageLabels, true)).toEqual({
            currentWidthCh: 9,
            totalWidthCh: 3,
            separatorWidthCh: 1,
            displayWidthCh: 15,
        });
    });

    it('uses the compact page-indicator width for toolbar layout metrics', () => {
        const totalPages = 348;
        const pageLabels = Array.from({ length: totalPages }, (_, index) => {
            if (index < 17) {
                return [
                    'i',
                    'ii',
                    'iii',
                    'iv',
                    'v',
                    'vi',
                    'vii',
                    'viii',
                    'ix',
                    'x',
                    'xi',
                    'xii',
                    'xiii',
                    'xiv',
                    'xv',
                    'xvi',
                    'xvii',
                ][index] ?? String(index + 1);
            }

            return String(index - 16);
        });

        expect(getPageIndicatorLayoutMetrics(totalPages, pageLabels, true, { compactPhysicalPage: true })).toEqual({
            currentWidthCh: 8,
            totalWidthCh: 3,
            separatorWidthCh: 1,
            displayWidthCh: 14,
        });
    });

    it('keeps a smaller compact width when the total is hidden', () => {
        expect(getPageIndicatorLayoutMetrics(348, null, false)).toEqual({
            currentWidthCh: 3,
            totalWidthCh: 0,
            separatorWidthCh: 0,
            displayWidthCh: 5,
        });
    });

    it('reserves a stable placeholder total width when the document is empty', () => {
        const emptyMetrics = getPageIndicatorLayoutMetrics(0, null, true);
        const typicalMetrics = getPageIndicatorLayoutMetrics(348, null, true);

        expect(emptyMetrics.totalWidthCh).toBe(3);
        expect(emptyMetrics.displayWidthCh).toBe(typicalMetrics.displayWidthCh);
    });

    it('reserves a stable placeholder total width for short documents', () => {
        const shortMetrics = getPageIndicatorLayoutMetrics(5, null, true);

        expect(shortMetrics.totalWidthCh).toBe(3);
        expect(shortMetrics.displayWidthCh).toBe(getPageIndicatorLayoutMetrics(348, null, true).displayWidthCh);
    });

    it('prefers numeric page labels over physical page numbers when labels exist', () => {
        const totalPages = 348;
        const pageLabels = Array.from({ length: totalPages }, (_, index) => {
            if (index < 25) {
                return String(index + 1);
            }

            return String(index - 24);
        });

        expect(findPageByPageLabelInput('132', totalPages, pageLabels)).toBe(157);
    });

    it('reverse-maps a label through the known prefix of its numbering segment', () => {
        const cases: Array<{
            label: string;
            page: number;
            ranges: Parameters<typeof createPageLabelModel>[1];
        }> = [
            {
                label: '14',
                page: 4,
                ranges: [{
                    startPage: 1,
                    style: 'D',
                    prefix: '1',
                    startNumber: 1,
                }],
            },
            {
                label: 'SecD',
                page: 4,
                ranges: [{
                    startPage: 1,
                    style: 'A',
                    prefix: 'Sec',
                    startNumber: 1,
                }],
            },
            {
                label: 'CIV',
                page: 4,
                ranges: [{
                    startPage: 1,
                    style: 'R',
                    prefix: 'C',
                    startNumber: 1,
                }],
            },
            {
                label: 'iv',
                page: 4,
                ranges: [{
                    startPage: 1,
                    style: 'R',
                    prefix: '',
                    startNumber: 1,
                }],
            },
            {
                label: 'part-4',
                page: 4,
                ranges: [{
                    startPage: 1,
                    style: 'D',
                    prefix: 'Part-',
                    startNumber: 1,
                }],
            },
        ];

        for (const {
            label, page, ranges,
        } of cases) {
            const model = createPageLabelModel(20, ranges);
            expect(model.labelAt(page)).toMatch(new RegExp(`^${label.toLowerCase()}$`, 'i'));
            expect(findPageByPageLabelInput(label, 20, model)).toBe(page);
        }
    });

    it('bounds the label an accepted start value can format into', () => {
        const alphabetic = createPageLabelModel(1, [{
            startPage: 1,
            style: 'A',
            prefix: '',
            startNumber: 20_000_000_000,
        }]);
        const roman = createPageLabelModel(1, [{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1_000_000_000,
        }]);
        const decimal = createPageLabelModel(1, [{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 20_000_000_000,
        }]);

        expect(formatPageLabelForDisplay(alphabetic.ranges[0]!)).toHaveLength(65);
        expect(formatPageLabelForDisplay(roman.ranges[0]!)).toHaveLength(65);
        expect(decimal.labelAt(1)).toBe('20000000000');
    });

    it('keeps the start value an imported range defines, even one the page-numbering field would not admit', () => {
        const ranges = normalizePageLabelRanges([{
            startPage: 1,
            style: 'A',
            prefix: '',
            startNumber: 130,
        }], 1);

        expect(ranges[0]?.startNumber).toBe(130);
        expect(createPageLabelModel(1, ranges).labelAt(1)).toBe('ZZZZZ');
    });

    it('renumbers only the edited page and keeps the numbering the later pages already had', () => {
        const ranges = replacePageLabelRange(
            150,
            [{
                startPage: 1,
                style: 'A',
                prefix: '',
                startNumber: 1,
            }],
            {
                startPage: 110,
                endPage: 110,
            },
            {
                style: 'D',
                prefix: '',
                startNumber: 1,
            },
        );
        const model = createPageLabelModel(150, ranges);

        expect(model.labelAt(109)).toBe('EEEEE');
        expect(model.labelAt(110)).toBe('1');
        expect(model.labelAt(111)).toBe('GGGGG');
    });

    it('admits a typed start value only up to the bound its numbering style can print', () => {
        const ranges = replacePageLabelRange(
            1,
            [],
            {
                startPage: 1,
                endPage: 1,
            },
            {
                style: 'A',
                prefix: '',
                startNumber: 20_000_000_000,
            },
        );

        expect(ranges[0]?.startNumber).toBe(getPageLabelStartNumberMax('A'));
    });

    it('reads an imported start value from a label too long to scan, and shows it bounded', () => {
        // 1,000,000,000 in letter style is "L" repeated 38,461,539 times.
        const label = 'L'.repeat(38_461_539);
        const ranges = derivePageLabelRangesFromLabels([label], 1);
        const shown = formatPageLabelForDisplay(ranges[0]!);

        expect(ranges).toEqual([{
            startPage: 1,
            style: 'A',
            prefix: '',
            startNumber: 1_000_000_000,
        }]);
        expect(shown.length).toBeLessThan(300);
        expect(shown.endsWith('…')).toBe(true);
    });

    it('keeps a long literal label whole in its ranges and shows only a bounded head of it', () => {
        const label = `${'Front matter '.repeat(8)}end. `;
        const ranges = derivePageLabelRangesFromLabels([label], 1);
        const shown = formatPageLabelForDisplay(ranges[0]!);

        expect(ranges).toEqual([{
            startPage: 1,
            style: null,
            prefix: label,
            startNumber: 1,
        }]);
        expect(shown.length).toBeLessThan(300);
        expect(shown.endsWith('…')).toBe(true);
    });

    it('shows a huge Roman start value as a bounded label', () => {
        const shown = formatPageLabelForDisplay({
            startPage: 1,
            style: 'R',
            prefix: '',
            startNumber: 1_000_000_000,
        });

        expect(shown.length).toBeLessThan(300);
        expect(shown.endsWith('…')).toBe(true);
    });

    it('prefers a logical label over a coincident physical page number', () => {
        const model = createPageLabelModel(20, [{
            startPage: 1,
            style: 'D',
            prefix: '1',
            startNumber: 1,
        }]);

        expect(model.labelAt(4)).toBe('14');
        expect(findPageByPageLabelInput('14', 20, model)).toBe(4);
    });

    it('matches an exact label in a later segment before a case-only match in an earlier one', () => {
        const romanModel = createPageLabelModel(20, [
            {
                startPage: 1,
                style: 'R',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: 11,
                style: 'r',
                prefix: '',
                startNumber: 1,
            },
        ]);
        const alphabeticModel = createPageLabelModel(20, [
            {
                startPage: 1,
                style: 'A',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: 11,
                style: 'a',
                prefix: '',
                startNumber: 1,
            },
        ]);

        expect(findPageByPageLabelInput('iv', 20, romanModel)).toBe(14);
        expect(findPageByPageLabelInput('IV', 20, romanModel)).toBe(4);
        expect(findPageByPageLabelInput('a', 20, alphabeticModel)).toBe(11);
        expect(findPageByPageLabelInput('A', 20, alphabeticModel)).toBe(1);
    });

    it('builds whole-document numbering ranges without depending on existing broken labels', () => {
        const ranges = buildWholeDocumentPageLabelRanges(348, {
            style: 'D',
            prefix: '',
            startNumber: 1,
        });

        expect(ranges).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        expect(buildPageLabelsFromRanges(3, ranges)).toEqual([
            '1',
            '2',
            '3',
        ]);
    });

    it('resolves million-page labels from canonical ranges and bounded windows', () => {
        const totalPages = 1_000_000;
        const ranges = [
            {
                startPage: 1,
                style: 'D' as const,
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: 500_001,
                style: 'D' as const,
                prefix: 'Appendix ',
                startNumber: 1,
            },
        ];
        const model = createPageLabelModel(totalPages, ranges);

        expect(model.ranges).toEqual(ranges);
        expect(model.segments).toEqual([
            {
                ...ranges[0],
                endPage: 500_000,
            },
            {
                ...ranges[1],
                endPage: totalPages,
            },
        ]);
        expect(model.labelAt(1)).toBe('1');
        expect(model.labelAt(500_000)).toBe('500000');
        expect(model.labelAt(500_001)).toBe('Appendix 1');
        expect(model.labelAt(totalPages)).toBe('Appendix 500000');
        expect(model.labelAt(0)).toBeNull();
        expect(findPageByPageLabelInput('Appendix 500000', totalPages, model)).toBe(totalPages);
        expect(getMaxPageIndicatorLength(totalPages, model)).toBeGreaterThan(String(totalPages).length);
        expect(model.readWindow(499_999, 500_004)).toEqual([
            '499999',
            '500000',
            'Appendix 1',
            'Appendix 2',
            'Appendix 3',
            'Appendix 4',
        ]);
        expect(model.readWindow(500_000, 500_000 + 500)).toHaveLength(128);
    });

    it('edits million-page ranges and counts only the changed span', () => {
        const totalPages = 1_000_000;
        const initialRanges = buildWholeDocumentPageLabelRanges(totalPages, {
            style: 'D',
            prefix: '',
            startNumber: 1,
        });
        const editedRanges = replacePageLabelRange(
            totalPages,
            initialRanges,
            {
                startPage: 400_000,
                endPage: 400_010,
            },
            {
                style: 'R',
                prefix: 'Section ',
                startNumber: 1,
            },
        );
        const editedModel = createPageLabelModel(totalPages, editedRanges);

        expect(editedRanges).toHaveLength(3);
        expect(editedModel.labelAt(399_999)).toBe('399999');
        expect(editedModel.labelAt(400_000)).toBe('Section I');
        expect(editedModel.labelAt(400_010)).toBe('Section XI');
        expect(editedModel.labelAt(400_011)).toBe('400011');
        expect(countPageLabelDifferences(totalPages, initialRanges, editedRanges)).toBe(11);

        const sparseRanges = applySparsePageLabelUpdates(totalPages, initialRanges, [
            {
                page: 123_456,
                label: 'Cover',
            },
            {
                page: 987_654,
                label: 'Back',
            },
        ]);
        const sparseModel = createPageLabelModel(totalPages, sparseRanges);
        expect(sparseModel.labelAt(123_456)).toBe('Cover');
        expect(sparseModel.labelAt(987_654)).toBe('Back');
        expect(sparseRanges.length).toBeLessThan(10);
    });

    it('keeps the range model exactly equivalent to the compatibility array on small documents', () => {
        const totalPages = 16;
        const ranges = [
            {
                startPage: 1,
                style: 'r' as const,
                prefix: 'Front ',
                startNumber: 3,
            },
            {
                startPage: 5,
                style: null,
                prefix: 'Plate',
                startNumber: 1,
            },
            {
                startPage: 8,
                style: 'A' as const,
                prefix: 'App ',
                startNumber: 1,
            },
        ];
        const model = createPageLabelModel(totalPages, ranges);
        const labels = buildPageLabelsFromRanges(totalPages, ranges);

        expect(model.readWindow(1, totalPages)).toEqual(labels);
        expect(labels.map((_, index) => model.labelAt(index + 1))).toEqual(labels);
    });
});


describe('lossless page-label regressions', () => {
    it('F1 navigates to the full long logical label of page 2', () => {
        const prefix = 'LongPrefix-'.repeat(6);
        const model = createPageLabelModel(3, [{
            startPage: 1,
            style: 'D',
            prefix,
            startNumber: 1,
        }]);
        expect(findPageByPageLabelInput(`${prefix}2`, 3, model)).toBe(2);
        expect(findPageByPageLabelInput(formatPageLabelForDisplay(model.ranges[0]!, 1), 3, model)).toBe(2);
    });

    it('F2 preserves untouched literal labels when page 3 is edited for saving', () => {
        const common = 'x'.repeat(64);
        const labels = [
            `${common}first.`,
            `${common}second.`,
            'tail.',
        ];
        const ranges = derivePageLabelRangesFromLabels(labels, 3);
        const saved = replacePageLabelRange(3, ranges, {
            startPage: 3,
            endPage: 3,
        }, {
            style: 'D',
            prefix: '',
            startNumber: 1,
        });
        expect(buildPageLabelsFromRanges(3, saved)).toEqual([
            labels[0],
            labels[1],
            '1',
        ]);
    });

    it('F3 retains complete Unicode characters in the label', () => {
        const prefix = `${'x'.repeat(63)}😀more`;
        const model = createPageLabelModel(1, [{
            startPage: 1,
            style: null,
            prefix,
            startNumber: 1,
        }]);
        expect(model.labelAt(1)).toBe(prefix);
        expect(formatPageLabelForDisplay(model.ranges[0]!)).toBe(`${'x'.repeat(63)}😀…`);
        expect(formatPageLabelForDisplay(`${'x'.repeat(63)}e\u0301more`)).toBe(`${'x'.repeat(63)}e\u0301…`);
        expect(formatPageLabelForDisplay(`${'x'.repeat(63)}👨‍👩‍👧‍👦more`)).toBe(`${'x'.repeat(63)}👨‍👩‍👧‍👦…`);
    });

    it('F4 reports all 201 prefixes changed beyond character 64', () => {
        const common = 'x'.repeat(64);
        expect(countPageLabelDifferences(201,
            [{
                startPage: 1,
                style: 'D',
                prefix: `${common}first.`,
                startNumber: 1,
            }],
            [{
                startPage: 1,
                style: 'D',
                prefix: `${common}second.`,
                startNumber: 1,
            }],
        )).toBe(201);
    });

    it('F5 admits raw agent ranges through the alphabetic start policy', () => {
        const ranges = ref<IPdfPageLabelRange[]>([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        const agent = createDocumentAgentPageLabels({
            pageLabelRanges: ranges,
            pageLabels: ref(null),
            pageLabelsDirty: ref(false),
            totalPages: ref(3),
            handlePageLabelRangesUpdate: updated => { ranges.value = updated; },
        });
        const plan = agent.applyAgentPageLabelPlan({ranges: [{
            startPage: 1,
            style: 'A',
            prefix: '',
            startNumber: 1e9,
        }]}, 'regression');
        expect(plan.ranges[0]?.startNumber).toBeLessThanOrEqual(getPageLabelStartNumberMax('A'));
    });
});


describe('page-label presentation and lazy semantics', () => {
    it('refuses a shortened literal target shared by two pages', () => {
        const common = 'x'.repeat(80);
        const model = createPageLabelModel(2, [
            {
                startPage: 1,
                style: null,
                prefix: `${common}first`,
                startNumber: 1,
            },
            {
                startPage: 2,
                style: null,
                prefix: `${common}second`,
                startNumber: 1,
            },
        ]);
        expect(findPageByPageLabelInput(formatPageLabelForDisplay(model.ranges[0]!), 2, model)).toBeNull();
    });

    it('compares huge imported formulas without expanding their numbering', () => {
        const before = [{
            startPage: 1,
            style: 'A' as const,
            prefix: 'x'.repeat(64),
            startNumber: 20_000_000_000,
        }];
        expect(countPageLabelDifferences(201, before, before)).toBe(0);
        expect(countPageLabelDifferences(201, before, [{
            ...before[0]!,
            prefix: `${before[0]!.prefix}changed`,
        }])).toBe(201);
        const updated = applySparsePageLabelUpdates(201, before, [{
            page: 3,
            label: 'Cover',
        }]);
        expect(updated.find(range => range.startPage === 4)?.startNumber).toBe(20_000_000_003);
    });

    it('keeps an agent plan over huge imported starts compact and semantically exact', () => {
        const ranges = ref<IPdfPageLabelRange[]>([{
            startPage: 1,
            style: 'A',
            prefix: '',
            startNumber: 20_000_000_000,
        }]);
        const agent = createDocumentAgentPageLabels({
            pageLabelRanges: ranges,
            pageLabels: ref(null),
            pageLabelsDirty: ref(false),
            totalPages: ref(3),
            handlePageLabelRangesUpdate: updated => { ranges.value = updated; },
        });
        const result = agent.applyAgentPageLabelPlan({ segments: [{
            startPage: 2,
            endPage: 2,
            style: 'D',
            startNumber: 1,
        }] }, 'regression');
        expect(result.plan.diff.changedPageCount).toBe(1);
        expect(result.ranges.find(range => range.startPage === 3)?.startNumber).toBe(20_000_000_002);
        expect(result.labels).toBeNull();
        expect(result.summary.firstLabel?.length).toBeLessThanOrEqual(65);
    });

    it('admits formula plans and raw range inputs through the same start policy', () => {
        const ranges = ref<IPdfPageLabelRange[]>([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        const agent = createDocumentAgentPageLabels({
            pageLabelRanges: ranges,
            pageLabels: ref(null),
            pageLabelsDirty: ref(false),
            totalPages: ref(3),
            handlePageLabelRangesUpdate: updated => { ranges.value = updated; },
        });
        for (const style of [
            'A',
            'a',
            'R',
            'r',
        ] as const) {
            const range = {
                startPage: 1,
                endPage: 3,
                style,
                startNumber: 1e9,
            };
            expect(agent.getAgentPageLabelRangesInput({ ranges: [{
                ...range,
                page: 1,
            }] }, 'regression')[0]?.startNumber).toBe(getPageLabelStartNumberMax(style));
            expect(agent.previewAgentPageLabelPlan({ segments: [range] }, 'regression').ranges[0]?.startNumber).toBe(getPageLabelStartNumberMax(style));
            expect(agent.applyAgentPageLabelsToRange(range, 'regression').ranges[0]?.startNumber).toBe(getPageLabelStartNumberMax(style));
        }
    });
});


it('navigates long-prefix presentation across numbering styles and rejects hidden suffix ambiguity', () => {
    for (const style of [
        'D',
        'A',
        'a',
        'R',
        'r',
    ] as const) {
        const model = createPageLabelModel(3, [{
            startPage: 1,
            style,
            prefix: 'LongPrefix-'.repeat(6),
            startNumber: 1,
        }]);
        expect(findPageByPageLabelInput(formatPageLabelForDisplay(model.ranges[0]!, 1), 3, model)).toBe(2);
    }
    for (const style of [
        'A',
        'R',
    ] as const) {
        const model = createPageLabelModel(3, [{
            startPage: 1,
            style,
            prefix: 'x'.repeat(80),
            startNumber: 1e9,
        }]);
        expect(findPageByPageLabelInput(formatPageLabelForDisplay(model.ranges[0]!), 3, model)).toBeNull();
        const onePage = createPageLabelModel(1, model.ranges);
        expect(findPageByPageLabelInput(formatPageLabelForDisplay(model.ranges[0]!), 1, onePage)).toBe(1);
    }
});


describe('viewer page-label presentation', () => {
    const hugeRange = {
        startPage: 1,
        style: 'A' as const,
        prefix: '',
        startNumber: 20_000_000_000,
    };

    it('renders and sizes imported numbering without expanding its full label', () => {
        const model = createPageLabelModel(2, [hugeRange]);
        expect(getVisiblePageLabel(1, model)).toBe(`${'F'.repeat(64)}…`);
        expect(getVisiblePageLabel(2, model)).toBe(`${'G'.repeat(64)}…`);
        expect(getMaxPageIndicatorLength(2, model)).toBe(69);
    });

    it('keeps huge labels compact even for a small document compatibility path', () => {
        expect(materializePageLabelsForCompatibility(2, [hugeRange])).toBeNull();
        expect(materializePageLabelsForCompatibility(2, [hugeRange], [
            'wrong',
            'labels',
        ])).toBeNull();
    });

    it('bounds legacy array presentation without changing the original label', () => {
        const label = '📖'.repeat(100);
        expect(getVisiblePageLabel(1, [label])).toBe(`${'📖'.repeat(64)}…`);
        expect(label).toHaveLength(200);
    });
});
