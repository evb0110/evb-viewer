import {describe, expect, it} from 'vitest';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

interface IWorkflowRunInfo {
    conclusion: string | null;
    databaseId: number;
    status: string;
    url: string;
}

interface IWorkflowRunModule {
    getRepositoryUrlFromRunUrl: (runUrl: string) => string;
    getRunArtifactsUrl: (runUrl: string) => string;
    isTransientGitHubCliError: (error: unknown) => boolean;
    waitForWorkflowRunStart: (options: {
        createdAfter?: string;
        displayTitles?: string[];
        findWorkflowRunFn: (options: {
            createdAfter: string;
            displayTitles: string[];
            targetSha: string;
            workflow: string;
        }) => IWorkflowRunInfo | null;
        nowFn: () => number;
        readStartTimeoutMsFn: () => number;
        sleepFn: (duration: number) => Promise<void>;
        stderr?: {write: (message: string) => void};
        targetSha?: string;
        workflow: string;
    }) => Promise<IWorkflowRunInfo>;
}

const {getRepositoryUrlFromRunUrl, getRunArtifactsUrl, isTransientGitHubCliError, waitForWorkflowRunStart} = (await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/github-workflow-run.mjs')).href
)) as IWorkflowRunModule;

describe('GitHub workflow run handoff', () => {
    it('stops once the dispatched workflow run is visible', async () => {
        const matcherArgs: unknown[] = [];
        let now = 0;
        let attempts = 0;

        const runInfo = await waitForWorkflowRunStart({
            createdAfter: '2026-06-21T10:00:00.000Z',
            displayTitles: ['Build Release Artifacts abc123'],
            findWorkflowRunFn: (options) => {
                matcherArgs.push(options);
                attempts += 1;

                return attempts === 1
                    ? null
                    : {
                          conclusion: null,
                          databaseId: 123,
                          status: 'queued',
                          url: 'https://github.com/example/repo/actions/runs/123',
                      };
            },
            nowFn: () => now,
            readStartTimeoutMsFn: () => 60_000,
            sleepFn: async (duration: number) => {
                now += duration;
            },
            targetSha: 'abc123',
            workflow: 'Build Release Artifacts',
        });

        expect(runInfo.status).toBe('queued');
        expect(matcherArgs).toEqual([
            {
                createdAfter: '2026-06-21T10:00:00.000Z',
                displayTitles: ['Build Release Artifacts abc123'],
                targetSha: 'abc123',
                workflow: 'Build Release Artifacts',
            },
            {
                createdAfter: '2026-06-21T10:00:00.000Z',
                displayTitles: ['Build Release Artifacts abc123'],
                targetSha: 'abc123',
                workflow: 'Build Release Artifacts',
            },
        ]);
    });

    it('retries transient polling failures while locating a run', async () => {
        const stderr: string[] = [];
        let now = 0;
        let attempts = 0;

        await waitForWorkflowRunStart({
            findWorkflowRunFn: () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error('Get "https://api.github.com": 503 Service Unavailable');
                }

                return {
                    conclusion: null,
                    databaseId: 456,
                    status: 'in_progress',
                    url: 'https://github.com/example/repo/actions/runs/456',
                };
            },
            nowFn: () => now,
            readStartTimeoutMsFn: () => 60_000,
            sleepFn: async (duration: number) => {
                now += duration;
            },
            stderr: {write: (message: string) => stderr.push(message)},
            workflow: 'Release',
        });

        expect(attempts).toBe(2);
        expect(stderr.join('')).toContain('Transient GitHub polling failure');
    });

    it('builds stable handoff links from the workflow run URL', () => {
        const runUrl = 'https://github.com/example/repo/actions/runs/123';

        expect(getRunArtifactsUrl(runUrl)).toBe('https://github.com/example/repo/actions/runs/123#artifacts');
        expect(getRepositoryUrlFromRunUrl(runUrl)).toBe('https://github.com/example/repo');
        expect(isTransientGitHubCliError(new Error('HTTP 401: Requires authentication'))).toBe(false);
    });
});
