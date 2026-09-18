import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    classifyShaJobs,
    formatShaReport,
    TIER_WORKFLOWS,
} from '@scripts/ci/ci-health.mjs';

interface IRecordedRun {
    created_at: string;
    head_sha: string;
    id: number;
    run_number: number;
    status: string;
    conclusion: string | null;
}

interface IRecordedJob {
    id: number;
    name: string;
    conclusion: string | null;
}

interface IRecordedInspection {
    run: IRecordedRun;
    jobs: IRecordedJob[];
}

/** The shape `gh api .../actions/workflows/<file>/runs` and `/jobs` return. */
function recordRun(
    index: number,
    sha: string,
    conclusion: string,
    jobs: Record<string, string | null>,
): IRecordedInspection {
    return {
        jobs: Object.entries(jobs).map(([
            name,
            jobConclusion,
        ], jobIndex) => ({
            conclusion: jobConclusion,
            id: index * 100 + jobIndex,
            name,
        })),
        run: {
            conclusion,
            created_at: `2026-09-1${index}T10:00:00Z`,
            head_sha: sha,
            id: 1000 + index,
            run_number: 500 + index,
            status: 'completed',
        },
    };
}

const GREEN_JOBS = {
    'Electron Blocking Smoke': 'success',
    'Publication Policy': 'success',
    'Quality Gates': 'success',
};

function requireJob(report: ReturnType<typeof classifyShaJobs>, name: string) {
    const job = report.jobs.find(candidate => candidate.name === name);
    if (job === undefined) {
        throw new Error(`Attribution report has no job named ${name}.`);
    }
    return job;
}

describe('ci-health commit attribution', () => {
    it('marks a failure the previous run already had as inherited', () => {
        const inspected = [
            recordRun(1, 'a'.repeat(40), 'success', GREEN_JOBS),
            recordRun(2, 'b'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
            }),
            recordRun(3, 'c'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
            }),
        ];

        const report = classifyShaJobs(inspected, 'c'.repeat(40));
        const qualityGates = requireJob(report, 'Quality Gates');

        expect(report.found).toBe(true);
        expect(qualityGates.attribution).toBe('INHERITED');
        expect(qualityGates.firstBad?.sha).toBe('b'.repeat(10));
        expect(qualityGates.firstBad?.runNumber).toBe(502);
        expect(qualityGates.olderThanWindow).toBe(false);
    });

    it('marks the commit that turned a green job red as new', () => {
        const inspected = [
            recordRun(1, 'a'.repeat(40), 'success', GREEN_JOBS),
            recordRun(2, 'b'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Electron Blocking Smoke': 'failure',
            }),
        ];

        const report = classifyShaJobs(inspected, 'b'.repeat(40));
        const smoke = requireJob(report, 'Electron Blocking Smoke');

        expect(smoke.attribution).toBe('NEW');
        expect(smoke.firstBad?.sha).toBe('b'.repeat(10));
    });

    it('steps over a run that skipped the job instead of calling the failure new', () => {
        const inspected = [
            recordRun(1, 'a'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Electron Blocking Smoke': 'failure',
            }),
            recordRun(2, 'b'.repeat(40), 'success', {
                'Electron Blocking Smoke': 'skipped',
                'Publication Policy': 'success',
                'Quality Gates': 'success',
            }),
            recordRun(3, 'c'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Electron Blocking Smoke': 'failure',
            }),
        ];

        const report = classifyShaJobs(inspected, 'c'.repeat(40));
        const smoke = requireJob(report, 'Electron Blocking Smoke');

        expect(smoke.attribution).toBe('INHERITED');
        expect(smoke.firstBad?.sha).toBe('a'.repeat(10));
    });

    it('reports a streak that reaches the oldest run it can see as unbounded', () => {
        const inspected = [
            recordRun(1, 'a'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
            }),
            recordRun(2, 'b'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
            }),
        ];

        const report = classifyShaJobs(inspected, 'b'.repeat(40));
        const qualityGates = requireJob(report, 'Quality Gates');

        expect(qualityGates.attribution).toBe('INHERITED');
        expect(qualityGates.olderThanWindow).toBe(true);
        expect(formatShaReport([{
            ...report,
            tier: 'required',
            workflow: 'ci.yml',
        }], 'b'.repeat(40))).toContain('first bad at or before');
    });

    it('judges the newest attempt when a commit was rerun', () => {
        const rerun = recordRun(3, 'b'.repeat(40), 'success', GREEN_JOBS);
        const inspected = [
            recordRun(1, 'a'.repeat(40), 'success', GREEN_JOBS),
            recordRun(2, 'b'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
            }),
            rerun,
        ];

        const report = classifyShaJobs(inspected, 'b'.repeat(40));

        expect(report.run?.id).toBe(rerun.run.id);
        expect(report.jobs.every(job => job.conclusion === 'success')).toBe(true);
    });

    it('reports no run rather than guessing when the commit has none', () => {
        const report = classifyShaJobs(
            [recordRun(1, 'a'.repeat(40), 'success', GREEN_JOBS)],
            'f'.repeat(40),
        );

        expect(report).toEqual({
            found: false,
            jobs: [],
            run: null,
        });
        expect(formatShaReport([{
            ...report,
            tier: 'extended',
            workflow: 'ci-extended.yml',
        }], 'f'.repeat(40))).toContain('no run for this commit');
    });

    it('names a new failure in the verdict line and never asks for an inherited one', () => {
        const inherited = classifyShaJobs([
            recordRun(1, 'a'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
            }),
            recordRun(2, 'b'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
            }),
        ], 'b'.repeat(40));
        const introduced = classifyShaJobs([
            recordRun(1, 'a'.repeat(40), 'success', GREEN_JOBS),
            recordRun(2, 'b'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
            }),
        ], 'b'.repeat(40));

        expect(formatShaReport([{
            ...inherited,
            tier: 'required',
            workflow: 'ci.yml',
        }], 'b'.repeat(40))).toContain('verdict: every failure is inherited');
        expect(formatShaReport([{
            ...introduced,
            tier: 'required',
            workflow: 'ci.yml',
        }], 'b'.repeat(40))).toContain('verdict: this commit broke Quality Gates');
    });

    it('marks a superseded extended run as something other than a verdict', () => {
        const cancelled = recordRun(2, 'b'.repeat(40), 'cancelled', {
            ...GREEN_JOBS,
            'Browser Integration': 'cancelled',
        });
        cancelled.run.conclusion = 'cancelled';

        const report = classifyShaJobs([cancelled], 'b'.repeat(40));
        const text = formatShaReport([{
            ...report,
            tier: 'extended',
            workflow: 'ci-extended.yml',
        }], 'b'.repeat(40));

        expect(text).toContain('superseded, not a verdict');
        expect(text).toContain('verdict: no failing job attributable to this commit');
    });

    it('leaves the aggregate out of the per-job attribution', () => {
        const report = classifyShaJobs([
            recordRun(1, 'a'.repeat(40), 'success', GREEN_JOBS),
            recordRun(2, 'b'.repeat(40), 'failure', {
                ...GREEN_JOBS,
                'Quality Gates': 'failure',
                gates_ok: 'failure',
            }),
        ], 'b'.repeat(40));
        const text = formatShaReport([{
            ...report,
            tier: 'required',
            workflow: 'ci.yml',
        }], 'b'.repeat(40));

        expect(report.jobs.map(job => job.name)).not.toContain('gates_ok');
        expect(text).toContain('run 1002: failure');
        expect(text).toContain('verdict: this commit broke Quality Gates');
    });

    it('judges a commit by the required and extended tiers only', () => {
        expect(TIER_WORKFLOWS.map(entry => entry.workflow)).toEqual([
            'ci.yml',
            'ci-extended.yml',
        ]);
    });
});
