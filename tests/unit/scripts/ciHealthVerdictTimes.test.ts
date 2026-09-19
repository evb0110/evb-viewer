import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    formatVerdictTimesReport,
    summarizeVerdictTimes,
} from '@scripts/ci/ci-health.mjs';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-19T00:00:00Z');
const SCOPE = {
    days: 1,
    now: NOW,
};

/** The shape `gh api .../actions/workflows/<file>/runs` returns for a push run. */
function recordRun({
    conclusion = 'success',
    hoursAgo,
    minutes,
    sha,
    status = 'completed',
}: {
    conclusion?: string | null;
    hoursAgo: number;
    minutes: number;
    sha: string;
    status?: string;
}) {
    const createdAtMs = NOW - hoursAgo * HOUR_MS;
    return {
        conclusion,
        created_at: new Date(createdAtMs).toISOString(),
        head_sha: sha,
        id: hoursAgo * 1000,
        run_number: 1000 - hoursAgo,
        status,
        updated_at: new Date(createdAtMs + minutes * 60_000).toISOString(),
    };
}

describe('ci-health verdict times', () => {
    it('measures push to completed verdict from the run timestamps alone', () => {
        const {current} = summarizeVerdictTimes([
            recordRun({
                hoursAgo: 20,
                minutes: 10,
                sha: 'a',
            }),
            recordRun({
                hoursAgo: 16,
                minutes: 12,
                sha: 'b',
            }),
            recordRun({
                hoursAgo: 12,
                minutes: 14,
                sha: 'c',
            }),
            recordRun({
                hoursAgo: 8,
                minutes: 40,
                sha: 'd',
            }),
        ], SCOPE);

        expect(current.candidates).toBe(4);
        expect(current.medianMinutes).toBe(12);
        expect(current.p90Minutes).toBe(40);
        expect(current.redShare).toBe(0);
    });

    // A cancelled run says nothing, so averaging it in would report the time
    // CI took to produce no answer as the time to a verdict.
    it('excludes cancelled runs from the times and counts them separately', () => {
        const {current} = summarizeVerdictTimes([
            recordRun({
                hoursAgo: 20,
                minutes: 10,
                sha: 'a',
            }),
            recordRun({
                conclusion: 'cancelled',
                hoursAgo: 18,
                minutes: 90,
                sha: 'b',
            }),
            recordRun({
                conclusion: null,
                hoursAgo: 2,
                minutes: 3,
                sha: 'c',
                status: 'in_progress',
            }),
        ], SCOPE);

        expect(current.candidates).toBe(1);
        expect(current.medianMinutes).toBe(10);
        expect(current.withoutVerdict).toBe(1);
    });

    // A rerun hours later must not be reported as a slow verdict for the
    // commit whose first run already answered.
    it('counts each candidate once, through the first verdict its sha reached', () => {
        const {current} = summarizeVerdictTimes([
            recordRun({
                conclusion: 'failure',
                hoursAgo: 20,
                minutes: 11,
                sha: 'a',
            }),
            recordRun({
                hoursAgo: 4,
                minutes: 13,
                sha: 'a',
            }),
        ], SCOPE);

        expect(current.candidates).toBe(1);
        expect(current.medianMinutes).toBe(11);
        expect(current.redShare).toBe(1);
    });

    it('reports the longest red streak in commits and the share of red candidates', () => {
        const {current} = summarizeVerdictTimes([
            recordRun({
                conclusion: 'failure',
                hoursAgo: 20,
                minutes: 10,
                sha: 'a',
            }),
            recordRun({
                conclusion: 'failure',
                hoursAgo: 18,
                minutes: 10,
                sha: 'b',
            }),
            recordRun({
                conclusion: 'failure',
                hoursAgo: 16,
                minutes: 10,
                sha: 'c',
            }),
            recordRun({
                hoursAgo: 14,
                minutes: 10,
                sha: 'd',
            }),
            recordRun({
                conclusion: 'failure',
                hoursAgo: 12,
                minutes: 10,
                sha: 'e',
            }),
        ], SCOPE);

        expect(current.longestRedStreak).toBe(3);
        expect(current.redShare).toBeCloseTo(0.8, 5);
    });

    // An hour is judged by the newest verdict behind it, so a red verdict from
    // before the window keeps colouring its first hours until something green
    // lands. Here that is hour 13 of 24.
    it('counts an hour as green only while the newest verdict behind it is green', () => {
        const {current} = summarizeVerdictTimes([
            recordRun({
                conclusion: 'failure',
                hoursAgo: 30,
                minutes: 0,
                sha: 'a',
            }),
            recordRun({
                hoursAgo: 11,
                minutes: 0,
                sha: 'b',
            }),
        ], SCOPE);

        expect(current.hoursWithoutGreenShare).toBeCloseTo(12 / 24, 5);
    });

    it('leaves hours with no verdict behind them out of the denominator', () => {
        const {current} = summarizeVerdictTimes([recordRun({
            hoursAgo: 6,
            minutes: 0,
            sha: 'a',
        })], SCOPE);

        expect(current.hoursWithoutGreenShare).toBe(0);
    });

    it('measures the previous equal window the same way so a trend is visible', () => {
        const {
            current, previous,
        } = summarizeVerdictTimes([
            recordRun({
                conclusion: 'failure',
                hoursAgo: 40,
                minutes: 32,
                sha: 'old',
            }),
            recordRun({
                hoursAgo: 6,
                minutes: 11,
                sha: 'new',
            }),
        ], SCOPE);

        expect(previous.candidates).toBe(1);
        expect(previous.medianMinutes).toBe(32);
        expect(previous.redShare).toBe(1);
        expect(current.candidates).toBe(1);
        expect(current.medianMinutes).toBe(11);
        expect(current.redShare).toBe(0);
    });

    it('reports an empty window without inventing a number', () => {
        const {current} = summarizeVerdictTimes([], SCOPE);

        expect(current).toMatchObject({
            candidates: 0,
            hoursWithoutGreenShare: null,
            longestRedStreak: 0,
            medianMinutes: null,
            p90Minutes: null,
            redShare: null,
        });
        expect(formatVerdictTimesReport({
            current,
            previous: current,
        }, {
            branch: 'main',
            workflow: 'ci.yml',
        })).toContain('n/a');
    });

    it('prints both windows on one line each', () => {
        const report = formatVerdictTimesReport(summarizeVerdictTimes([recordRun({
            hoursAgo: 6,
            minutes: 11,
            sha: 'new',
        })], SCOPE), {
            branch: 'main',
            workflow: 'ci.yml',
        });

        expect(report).toContain('Verdict times: ci.yml push runs on main');
        expect(report).toMatch(/current .*11\.0m/u);
        expect(report).toMatch(/previous .*n\/a/u);
    });
});
