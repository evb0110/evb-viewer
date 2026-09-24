import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { ref } from 'vue';
import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import {requireIsoTimestamp} from '@contracts/timestamps';
import {
    createDebugLogRuntimeErrorPresentation,
    isUiReportableDebugLog,
} from '@app/utils/runtimeErrorFilter';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';

const cookieStore = new Map<string, ReturnType<typeof ref>>();
const stateStore = new Map<string, ReturnType<typeof ref>>();

/**
 * Replays what the main process broadcasts, through the same predicate, the same
 * entry-to-report mapping and the same report store the runtime-error log stream
 * uses. Nothing about how a log entry becomes a report is restated here, so a
 * change to that mapping shows up in these expectations rather than passing
 * against a copy of the old shape.
 */
async function streamMainProcessLogs(entries: IDebugLogEntry[]) {
    const { useRuntimeErrorReports } = await import('@app/composables/useRuntimeErrorReports');
    const reports = useRuntimeErrorReports();
    for (const entry of entries) {
        if (!isUiReportableDebugLog(entry)) {
            continue;
        }
        const presentation = createDebugLogRuntimeErrorPresentation(entry, 'Application error');
        if (presentation) {
            reports.reportRuntimeError(presentation);
        }
    }
    return reports;
}

function logEntry(
    source: string,
    level: NonNullable<IDebugLogEntry['level']>,
    message: string,
): IDebugLogEntry {
    const base = {
        source,
        message: `[${level}] ${message}`,
        timestamp: requireIsoTimestamp('2026-08-23T08:57:36.046Z'),
    };
    if (level === 'ERROR') {
        return {
            ...base,
            level,
            failureRef: {
                eventId: (source === 'working-copy' ? 'b' : 'a').repeat(32),
                code: 'UNCLASSIFIED_MAIN_ERROR',
                severity: 'error',
            },
        };
    }
    return {
        ...base,
        level,
    };
}

describe('scan cleanup runtime diagnostic reporting', () => {
    beforeEach(() => {
        vi.resetModules();
        cookieStore.clear();
        stateStore.clear();
        installNuxtStateTestStubs(cookieStore, stateStore);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        cookieStore.clear();
        stateStore.clear();
    });

    it('reports nothing when a source-tab close cancels an active run', async () => {
        // Closing the document tab cancels the run. Every layer that observes
        // the resulting rejection now describes it as a cancellation, so the
        // renderer has no application error to surface.
        const reports = await streamMainProcessLogs([
            logEntry('worker-task', 'WARN', 'Worker cancellation requested: path=scan-cleanup-worker.js reason=abort elapsedMs=9814'),
            logEntry('worker-task', 'INFO', 'Worker exited while cancelling: path=scan-cleanup-worker.js code=1 online=true'),
            logEntry('scan-cleanup-worker-task', 'INFO', 'Scan cleanup worker task canceled'),
            logEntry('working-copy', 'DEBUG', 'Cancelled 1 dependent operation(s) for a closing working copy'),
        ]);

        expect(reports.reports.value).toEqual([]);
    });

    it('keeps one propagated worker failure to a single diagnostic', async () => {
        const reports = await streamMainProcessLogs([
            logEntry(
                'worker-task',
                'ERROR',
                'Worker reported failure: path=scan-cleanup-worker.js elapsedMs=15841 message=pdftoppm failed',
            ),
            logEntry(
                'scan-cleanup-worker-task',
                'WARN',
                'Scan cleanup worker task rejected (already reported): Error: pdftoppm failed',
            ),
        ]);

        expect(reports.reports.value).toHaveLength(1);
        expect(reports.reports.value[0]).toMatchObject({
            count: 1,
            id: 'a'.repeat(32),
            source: 'UNCLASSIFIED_MAIN_ERROR',
        });
        expect(reports.reports.value[0]?.detail).toContain('path=scan-cleanup-worker.js');
    });

    it('still surfaces an unrelated failure alongside a reported one', async () => {
        const reports = await streamMainProcessLogs([
            logEntry('worker-task', 'ERROR', 'Worker reported failure: path=scan-cleanup-worker.js message=pdftoppm failed'),
            logEntry('scan-cleanup-worker-task', 'WARN', 'Scan cleanup worker task rejected (already reported): Error: pdftoppm failed'),
            logEntry('working-copy', 'ERROR', 'Refused to delete a working directory containing its original backing: /tmp/pdf-work-1'),
        ]);

        expect(reports.reports.value.map(report => report.id)).toEqual([
            'b'.repeat(32),
            'a'.repeat(32),
        ]);
        expect(reports.reports.value.map(report => report.detail)).toEqual([
            expect.stringContaining('Refused to delete a working directory'),
            expect.stringContaining('Worker reported failure'),
        ]);
    });
});
