import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupSummaryWarningEvent,
} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupProgressReporter,
    reportScanCleanupSummaryWarningEvent,
} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {SCAN_CLEANUP_PROGRESS_SCHEMA} from '@contracts/scan-cleanup/progress';

describe('scan cleanup progress reporter', () => {
    it('keeps completed-page progress bounded for a long document', () => {
        const reports: TScanCleanupProgress[] = [];
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => false,
            {now: () => 0},
        );
        function* completedPages() {
            for (let pageNumber = 1; pageNumber <= SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1; pageNumber += 1) {
                yield pageNumber;
            }
        }

        emit(
            'rendering',
            SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1,
            SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES + 1,
            completedPages(),
        );

        expect(reports[0]!.completedPageNumbers).toHaveLength(SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES);
        expect(reports[0]!.completedPageNumbers?.[0]).toBe(1);
        expect(reports[0]!.completedPageNumbersTruncated).toBe(true);
        expect(SCAN_CLEANUP_PROGRESS_SCHEMA.decode(reports[0])).toEqual(reports[0]);
    });

    it('uses one monotonic rendering band for a streaming raster pipeline', () => {
        const reports: TScanCleanupProgress[] = [];
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => false,
            {
                isRasterStreaming: () => true,
                now: () => 0,
            },
        );

        emit('probing', 3, 10);
        emit('extracting', 10, 10);
        emit('rendering', 0, 392);
        emit('rendering', 196, 392);
        emit('rendering', 392, 392);
        emit('assembling', 1, 2);

        expect(reports.map(report => report.stage)).not.toContain('rasterizing');
        expect(reports.map(report => report.percent)).toEqual(
            [...reports.map(report => report.percent)].sort((left, right) => left - right),
        );
        expect(reports.find(report => report.stage === 'rendering' && report.completedUnits === 0)?.percent)
            .toBe(10);
        expect(reports.find(report => report.stage === 'rendering' && report.completedUnits === 392)?.percent)
            .toBe(88);
        expect(reports.map(report => [
            report.stageIndex,
            report.stageCount,
        ])).toEqual([
            [
                2,
                7,
            ],
            [
                3,
                7,
            ],
            [
                4,
                7,
            ],
            [
                4,
                7,
            ],
            [
                4,
                7,
            ],
            [
                6,
                7,
            ],
        ]);
    });

    it('withholds ETA until sampled and then estimates only the reporting stage', () => {
        const reports: TScanCleanupProgress[] = [];
        let now = 0;
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => false,
            {
                isRasterStreaming: () => true,
                now: () => now,
            },
        );

        emit('rendering', 0, 392);
        for (let completed = 1; completed <= 5; completed += 1) {
            now += 2_000;
            emit('rendering', completed, 392);
        }

        expect(reports.at(-2)?.etaSeconds).toBeUndefined();
        // Five pages at two seconds each leaves 387 pages in this stage, and the
        // stages behind it are not priced into a page rate that cannot measure
        // them: 387 pages at two seconds is 774 seconds and nothing more.
        expect(reports.at(-1)?.etaSeconds).toBe(774);
    });

    it('does not carry one stage ETA floor into the next stage', () => {
        const reports: TScanCleanupProgress[] = [];
        let now = 0;
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => false,
            {
                isRasterStreaming: () => true,
                now: () => now,
            },
        );

        // Finish rendering fast enough that its closing ETA is a few seconds.
        emit('rendering', 0, 10);
        now = 10_000;
        emit('rendering', 9, 10);
        expect(reports.at(-1)?.etaSeconds).toBe(2);

        // A slower stage that follows must be free to report its own larger
        // estimate rather than inheriting the previous stage's floor.
        now = 20_000;
        emit('assembling', 0, 10);
        now = 40_000;
        emit('assembling', 5, 10);
        expect(reports.at(-1)?.etaSeconds).toBe(20);
    });

    it('never raises a displayed ETA when a slower sample changes the rate estimate', () => {
        const reports: TScanCleanupProgress[] = [];
        let now = 0;
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => false,
            {
                isRasterStreaming: () => true,
                now: () => now,
            },
        );

        emit('rendering', 0, 392);
        now = 10_000;
        emit('rendering', 5, 392);
        const initialEta = reports.at(-1)?.etaSeconds;
        now = 18_000;
        emit('rendering', 6, 392);

        expect(initialEta).toBeTypeOf('number');
        expect(reports.at(-1)?.etaSeconds).toBe(initialEta);
    });

    it('never rewinds when a matched lossless run switches to raster rendering', () => {
        const reports: TScanCleanupProgress[] = [];
        let lossless = true;
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => lossless,
            {now: () => 0},
        );

        emit('rasterizing', 8, 10);
        lossless = false;
        emit('rendering', 1, 10);

        expect(reports[1]!.percent).toBeGreaterThanOrEqual(reports[0]!.percent);
        expect(reports[0]).toMatchObject({
            stageIndex: 4,
            stageCount: 8,
        });
        expect(reports[1]).toMatchObject({
            stageIndex: 5,
            stageCount: 8,
        });
    });
});

describe('scan cleanup summary warning events', () => {
    it('accumulates every condition beside the sentence it produced', () => {
        // The array the run collected before its summary existed is a seed the
        // summary copies, so later conditions land on the summary and cannot
        // reach back into the collection the caller still holds.
        const seed: TScanCleanupSummaryWarningEvent[] = [{event: {code: 'matched-canvas-dropped'}}];
        const summary = createEmptyScanCleanupSummary(2, [], seed);
        const reported: string[] = [];
        const report = (message: string) => reported.push(message);

        reportScanCleanupSummaryWarningEvent(summary, {
            event: {code: 'matched-canvas-margins-reduced'},
            pageNumber: requirePageNumber(1),
            half: 'left',
        }, report);
        reportScanCleanupSummaryWarningEvent(summary, {
            event: {code: 'matched-canvas-margins-unavailable'},
            pageNumber: requirePageNumber(2),
        }, report);

        expect(summary.warningEvents).toEqual([
            {event: {code: 'matched-canvas-dropped'}},
            {
                event: {code: 'matched-canvas-margins-reduced'},
                pageNumber: 1,
                half: 'left',
            },
            {
                event: {code: 'matched-canvas-margins-unavailable'},
                pageNumber: 2,
            },
        ]);
        expect(seed).toEqual([{event: {code: 'matched-canvas-dropped'}}]);
        expect(reported.length).toBe(2);
    });

    it('opens the typed list on a summary that carries none', () => {
        // A summary decoded from a run that predates this channel has no list
        // at all. The first condition reported on it opens one rather than
        // being dropped.
        const summary: TScanCleanupSummary = createEmptyScanCleanupSummary(1, []);
        delete summary.warningEvents;

        reportScanCleanupSummaryWarningEvent(summary, {event: {code: 'matched-canvas-dropped'}}, () => undefined);
        reportScanCleanupSummaryWarningEvent(summary, {
            event: {code: 'matched-canvas-margins-reduced'},
            pageNumber: requirePageNumber(3),
        }, () => undefined);

        expect(summary.warningEvents).toEqual([
            {event: {code: 'matched-canvas-dropped'}},
            {
                event: {code: 'matched-canvas-margins-reduced'},
                pageNumber: 3,
            },
        ]);
    });
});
