import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertArtifactCanaryGreen,
    assertReleaseCutPreconditions,
    carryVersionToMain,
    createArtifactEvidenceLookup,
    cutRelease,
    getArtifactEvidencePolicy,
    parseCutReleaseArgs,
    publishReleaseCommit,
    resumeRelease,
    selectReleaseCandidate,
} from '@scripts/release/cut-release.mjs';
import {
    parseReleasePreflightArgs,
    runReleasePreflight,
} from '@scripts/release/release-cut-preflight.mjs';

const HEAD_SHA = 'a'.repeat(40);
const PARENT_SHA = 'b'.repeat(40);
const RELEASE_SHA = 'd'.repeat(40);
const TIP_SHA = 'e'.repeat(40);
const UPSTREAM = {
    branch: 'main',
    ref: 'origin/main',
    remote: 'origin',
};

function createGreenRun(sha: string, id: number) {
    return {
        conclusion: 'success',
        event: 'push',
        head_branch: 'main',
        head_sha: sha,
        html_url: `https://github.com/example/ci/runs/${id}`,
        id,
        run_number: id,
        status: 'completed',
    };
}

function createPreconditionOptions(overrides: Record<string, unknown> = {}) {
    const events: string[] = [];

    return {
        assertArtifactCanaryGreenFn: () => {
            events.push('canary');
            return {state: 'satisfied' as const};
        },
        assertCleanWorktreeFn: () => events.push('clean'),
        assertCurrentReleaseIsNotDraftFn: (tag: string) => events.push(`draft:${tag}`),
        assertGitHubCliReadyFn: async () => {
            events.push('github');
        },
        assertNodeBaselineFn: () => events.push('node'),
        assertTagAbsentFn: async (tag: string) => {
            events.push(`tag:${tag}`);
        },
        assertVersionNotBehindAncestorFn: () => {
            events.push('ancestor-version');
        },
        events,
        fetchReleaseMainFn: () => events.push('fetch'),
        getUpstreamFn: () => UPSTREAM,
        isAncestorFn: () => true,
        level: 'patch' as const,
        readGreatestReleaseTagFn: () => ({
            tag: 'v0.1.445',
            version: '0.1.445',
        }),
        readVersionAtFn: () => '0.1.445',
        runCommand: (command: string, args: string[]) => {
            if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
                return PARENT_SHA;
            }
            return '';
        },
        selectReleaseCandidateFn: () => {
            events.push('candidate');
            return {
                run: createGreenRun(HEAD_SHA, 10),
                sha: HEAD_SHA,
            };
        },
        ...overrides,
    };
}

describe('cut-release', () => {
    it('accepts a release level without the rejected separator form', () => {
        expect(parseCutReleaseArgs(['patch'])).toEqual({
            artifactEvidence: undefined,
            level: 'patch',
            requiredCommits: [],
            resume: false,
        });
        expect(parseCutReleaseArgs(['minor'])).toEqual({
            artifactEvidence: undefined,
            level: 'minor',
            requiredCommits: [],
            resume: false,
        });
    });

    it('parses repeatable required commits and artifact evidence policy', () => {
        expect(parseCutReleaseArgs([
            'patch',
            '--require-commit',
            'fix/ref',
            '--require-commit=abc123',
            '--artifact-evidence',
            'advisory',
        ])).toEqual({
            artifactEvidence: 'advisory',
            level: 'patch',
            requiredCommits: [
                'fix/ref',
                'abc123',
            ],
            resume: false,
        });
    });

    it('rejects candidate and artifact options for resume', () => {
        expect(parseCutReleaseArgs(['--resume'])).toEqual({
            artifactEvidence: undefined,
            level: null,
            requiredCommits: [],
            resume: true,
        });
        expect(() => parseCutReleaseArgs([
            '--resume',
            '--require-commit',
            HEAD_SHA,
        ])).toThrow(/does not accept candidate/u);
        expect(() => parseCutReleaseArgs([
            '--artifact-evidence',
            'unknown',
            'patch',
        ])).toThrow(/must be one of/u);
    });

    it('removes the old local verification flag', () => {
        expect(() => parseCutReleaseArgs([
            '--full-verify',
            'patch',
        ])).toThrow(/Unknown release option/u);
    });

    it('pins the newest green commit, then checks canary, current release, and next tag without waiting', async () => {
        const options = createPreconditionOptions();
        const result = await assertReleaseCutPreconditions(options);

        expect(result).toEqual({
            candidateCiRunId: 10,
            candidateCiRunUrl: 'https://github.com/example/ci/runs/10',
            candidateSha: HEAD_SHA,
            currentVersion: '0.1.445',
            nextVersion: '0.1.446',
            upstream: UPSTREAM,
        });
        expect(options.events).toEqual([
            'node',
            'github',
            'fetch',
            'candidate',
            'ancestor-version',
            'canary',
            'draft:v0.1.445',
            'tag:v0.1.446',
        ]);
    });

    it('passes required commits and the selected candidate to the precondition hooks', async () => {
        const requiredCommit = PARENT_SHA;
        let selectedOptions: unknown;
        let canaryCall: unknown;
        const options = createPreconditionOptions({
            assertArtifactCanaryGreenFn: (...args: unknown[]) => {
                canaryCall = args;
            },
            requiredCommits: [requiredCommit],
            selectReleaseCandidateFn: (...args: unknown[]) => {
                selectedOptions = args[1];
                return {
                    run: createGreenRun(HEAD_SHA, 10),
                    sha: HEAD_SHA,
                };
            },
        });

        await assertReleaseCutPreconditions(options);

        expect(selectedOptions).toEqual({requiredCommits: [requiredCommit]});
        expect(canaryCall).toEqual([
            HEAD_SHA,
            UPSTREAM,
            {policy: 'mandatory'},
        ]);
    });

    it('bumps from the newest tag when the candidate predates the last version carry', async () => {
        const options = createPreconditionOptions({
            readGreatestReleaseTagFn: () => ({
                tag: 'v0.1.450',
                version: '0.1.450',
            }),
            readVersionAtFn: () => '0.1.445',
        });

        const result = await assertReleaseCutPreconditions(options);

        expect(result.currentVersion).toBe('0.1.450');
        expect(result.nextVersion).toBe('0.1.451');
        expect(options.events).toContain('draft:v0.1.450');
        expect(options.events).toContain('tag:v0.1.451');
    });

    it('refuses to cut when nothing green landed since the last release', async () => {
        const options = createPreconditionOptions({
            isAncestorFn: (ancestorSha: string) => ancestorSha === PARENT_SHA,
            runCommand: (command: string, args: string[]) => {
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
                    return HEAD_SHA;
                }
                return '';
            },
        });

        await expect(assertReleaseCutPreconditions(options))
            .rejects.toThrow(/not newer than v0\.1\.445.*nothing to cut/u);
    });

    it('refuses a candidate that does not descend from the last release base', async () => {
        const options = createPreconditionOptions({isAncestorFn: (ancestorSha: string, descendantRef: string) => descendantRef === UPSTREAM.ref
                && ancestorSha === PARENT_SHA});

        await expect(assertReleaseCutPreconditions(options))
            .rejects.toThrow(/not newer than v0\.1\.445 \(built from b{40}\)/u);
    });

    it('refuses a red artifact canary for the selected candidate with its URL', async () => {
        const options = createPreconditionOptions({
            assertArtifactCanaryGreenFn: undefined,
            readGreatestReleaseTagFn: () => null,
            runCommand: () => JSON.stringify([{
                conclusion: 'failure',
                createdAt: '2026-09-10T08:54:36Z',
                databaseId: 7,
                displayTitle: 'Build Release Artifacts',
                event: 'schedule',
                headBranch: 'main',
                headSha: HEAD_SHA,
                name: 'Build Release Artifacts',
                status: 'completed',
                url: 'https://github.com/example/canary/runs/7',
                workflowName: 'Build Release Artifacts',
            }]),
        });

        await expect(assertReleaseCutPreconditions(options))
            .rejects.toThrow(new RegExp(`candidate ${HEAD_SHA}.*runs/7`, 'u'));
    });

    it('requires exact candidate artifact evidence and makes missing evidence distinct', () => {
        const stderr: string[] = [];
        const candidateRun = {
            conclusion: 'success',
            createdAt: '2026-09-10T08:54:36Z',
            databaseId: 8,
            headBranch: 'main',
            headSha: HEAD_SHA,
            status: 'completed',
            url: 'https://github.com/example/canary/runs/8',
        };
        const differentCommitRun = {
            ...candidateRun,
            conclusion: 'failure',
            databaseId: 7,
            headSha: PARENT_SHA,
            status: 'completed',
            url: 'https://github.com/example/canary/runs/7',
        };
        const runCommand = () => JSON.stringify([
            differentCommitRun,
            candidateRun,
        ]);

        expect(assertArtifactCanaryGreen(HEAD_SHA, UPSTREAM, runCommand, {stderr: {write: (message: string) => stderr.push(message)}})).toMatchObject({
            run: candidateRun,
            state: 'satisfied',
        });
        expect(stderr.join('')).toContain(`candidate ${HEAD_SHA}`);
        expect(stderr.join('')).toContain('runs/8');

        const missing = assertArtifactCanaryGreen(HEAD_SHA, UPSTREAM, () => JSON.stringify([differentCommitRun]), {
            policy: 'advisory',
            stderr: {write: (message: string) => stderr.push(message)},
        });
        expect(missing).toEqual({
            run: undefined,
            state: 'missing',
        });
        expect(stderr.join('')).toContain(`no release-artifacts.yml run has head_sha ${HEAD_SHA}`);
    });

    it('reports a running candidate canary as a mandatory failure but ignores a running different commit', () => {
        const runningCandidate = {
            conclusion: null,
            databaseId: 9,
            headBranch: 'main',
            headSha: HEAD_SHA,
            status: 'in_progress',
            url: 'https://github.com/example/canary/runs/9',
        };
        const runningDifferentCommit = {
            ...runningCandidate,
            databaseId: 10,
            headSha: PARENT_SHA,
            url: 'https://github.com/example/canary/runs/10',
        };
        const stderr: string[] = [];

        expect(() => assertArtifactCanaryGreen(HEAD_SHA, UPSTREAM, () => JSON.stringify([runningCandidate]), {stderr: {write: (message: string) => stderr.push(message)}})).toThrow(new RegExp(`candidate ${HEAD_SHA}.*runs/9`, 'u'));
        expect(() => assertArtifactCanaryGreen(HEAD_SHA, UPSTREAM, () => JSON.stringify([runningDifferentCommit]), {
            policy: 'advisory',
            stderr: {write: (message: string) => stderr.push(message)},
        })).not.toThrow();
        expect(stderr.join('')).not.toContain('runs/10');
    });

    it('makes patch artifact evidence mandatory by default and allows the advisory override', () => {
        expect(getArtifactEvidencePolicy('patch')).toBe('mandatory');
        expect(getArtifactEvidencePolicy('patch', 'advisory')).toBe('advisory');
        expect(getArtifactEvidencePolicy('minor')).toBe('advisory');
    });

    it('builds the release commit off the candidate, tags it, then carries the version to main', async () => {
        const events: string[] = [];
        let created: unknown;
        let published: unknown;
        let carried: unknown;
        const options = createPreconditionOptions({
            carryVersionToMainFn: async (request: unknown) => {
                events.push('carry');
                carried = request;
                return {
                    carried: true,
                    sha: RELEASE_SHA,
                };
            },
            createReleaseCommitFn: (request: unknown) => {
                events.push('create');
                created = request;
                return RELEASE_SHA;
            },
            fastForwardLocalMainFn: () => events.push('fast-forward'),
            publishReleaseCommitFn: async (request: unknown) => {
                events.push('publish');
                published = request;
                return RELEASE_SHA;
            },
            releaseWorktreeFn: async ({operation}: {operation: () => Promise<unknown>}) => operation(),
            stderr: {write: () => true},
        });

        await cutRelease('patch', options);

        expect(events).toEqual([
            'create',
            'publish',
            'carry',
        ]);
        expect(created).toEqual({
            parentSha: HEAD_SHA,
            subject: 'release: 0.1.446 [skip ci]',
            version: '0.1.446',
        });
        expect(published).toEqual({
            parentSha: HEAD_SHA,
            tag: 'v0.1.446',
            targetSha: RELEASE_SHA,
            upstream: UPSTREAM,
        });
        expect(carried).toEqual({
            releaseParentSha: HEAD_SHA,
            releaseSha: RELEASE_SHA,
            subject: 'release: 0.1.446 [skip ci]',
            tag: 'v0.1.446',
            upstream: UPSTREAM,
            version: '0.1.446',
        });
    });

    it('keeps the old local-main fast-forward as an explicit opt-in', async () => {
        const events: string[] = [];
        const options = createPreconditionOptions({
            carryVersionToMainFn: async () => ({
                carried: true,
                sha: RELEASE_SHA,
            }),
            createReleaseCommitFn: () => RELEASE_SHA,
            fastForwardLocalMainFn: () => events.push('fast-forward'),
            publishReleaseCommitFn: async () => RELEASE_SHA,
            releaseWorktreeFn: async ({operation}: {operation: () => Promise<unknown>}) => operation(),
            stderr: {write: () => true},
            updateLocalMain: true,
        });

        await cutRelease('patch', options);

        expect(events).toEqual(['fast-forward']);
    });
});

describe('selectReleaseCandidate', () => {
    const OLDER_SHA = 'c'.repeat(40);

    it('skips runs whose commit left main or whose gates_ok is not green, newest first', () => {
        const gates = new Map([
            [
                12,
                'success',
            ],
            [
                11,
                'failure',
            ],
            [
                10,
                'success',
            ],
        ]);

        const candidate = selectReleaseCandidate(UPSTREAM, {
            isAncestorFn: (sha: string) => sha !== TIP_SHA,
            listRunsFn: () => [
                createGreenRun(TIP_SHA, 12),
                createGreenRun(HEAD_SHA, 11),
                createGreenRun(OLDER_SHA, 10),
            ],
            readGatesFn: (id: number) => gates.get(id),
            runCommand: () => '',
        });

        expect(candidate.sha).toBe(OLDER_SHA);
        expect(candidate.run.id).toBe(10);
    });

    it('does not silently cut an older green candidate when a required commit is missing from the newest one', () => {
        const requiredSha = 'f'.repeat(40);
        const newest = createGreenRun(HEAD_SHA, 11);
        const older = createGreenRun(OLDER_SHA, 10);
        const ancestorPairs = new Set([
            `${requiredSha}:${OLDER_SHA}`,
            `${OLDER_SHA}:origin/main`,
            `${HEAD_SHA}:origin/main`,
        ]);

        expect(() => selectReleaseCandidate(UPSTREAM, {
            isAncestorFn: (ancestorSha: string, descendantRef: string) => ancestorPairs.has(`${ancestorSha}:${descendantRef}`),
            listRunsFn: () => [
                newest,
                older,
            ],
            readGatesFn: () => 'success',
            requiredCommits: [requiredSha],
            runCommand: () => '',
        })).toThrow(new RegExp(
            `Selected green release candidate ${HEAD_SHA}.*Newest green candidate containing every required commit is ${OLDER_SHA}`,
            'u',
        ));
    });

    it('reports when no green candidate contains every required commit yet', () => {
        const requiredSha = 'f'.repeat(40);

        expect(() => selectReleaseCandidate(UPSTREAM, {
            isAncestorFn: (ancestorSha: string, descendantRef: string) => descendantRef === 'origin/main'
                && ancestorSha === HEAD_SHA,
            listRunsFn: () => [createGreenRun(HEAD_SHA, 11)],
            readGatesFn: () => 'success',
            requiredCommits: [requiredSha],
            runCommand: () => '',
        })).toThrow(/No green candidate in the available CI history contains every required commit yet/u);
    });

    it('names every rejected run when no commit qualifies', () => {
        expect(() => selectReleaseCandidate(UPSTREAM, {
            isAncestorFn: () => true,
            listRunsFn: () => [createGreenRun(HEAD_SHA, 11)],
            readGatesFn: () => 'failure',
            runCommand: () => '',
        })).toThrow(/No commit on origin\/main has a successful ci\.yml push run.*gates_ok 'failure'/u);
    });

    it('prefers the newest green commit with a successful artifact canary over newer untested ones', () => {
        const gatesRead: number[] = [];

        const candidate = selectReleaseCandidate(UPSTREAM, {
            hasArtifactEvidenceFn: (sha: string) => sha === OLDER_SHA,
            isAncestorFn: () => true,
            listRunsFn: () => [
                createGreenRun(TIP_SHA, 12),
                createGreenRun(HEAD_SHA, 11),
                createGreenRun(OLDER_SHA, 10),
            ],
            readGatesFn: (id: number) => {
                gatesRead.push(id);
                return 'success';
            },
            runCommand: () => '',
        });

        expect(candidate.sha).toBe(OLDER_SHA);
        expect(gatesRead).toEqual([10]);
    });

    it('falls back to the newest green commit when no commit has a canary so the canary check can name it', () => {
        const candidate = selectReleaseCandidate(UPSTREAM, {
            hasArtifactEvidenceFn: () => false,
            isAncestorFn: () => true,
            listRunsFn: () => [
                createGreenRun(HEAD_SHA, 11),
                createGreenRun(OLDER_SHA, 10),
            ],
            readGatesFn: (id: number) => (id === 11 ? 'failure' : 'success'),
            runCommand: () => '',
        });

        expect(candidate.sha).toBe(OLDER_SHA);
    });

    it('names the untested green candidate and its dispatch command when only it contains a required commit', () => {
        const requiredSha = 'f'.repeat(40);
        const ancestorPairs = new Set([
            `${requiredSha}:${HEAD_SHA}`,
            `${HEAD_SHA}:origin/main`,
            `${OLDER_SHA}:origin/main`,
        ]);

        expect(() => selectReleaseCandidate(UPSTREAM, {
            hasArtifactEvidenceFn: (sha: string) => sha === OLDER_SHA,
            isAncestorFn: (ancestorSha: string, descendantRef: string) => ancestorPairs.has(`${ancestorSha}:${descendantRef}`),
            listRunsFn: () => [
                createGreenRun(HEAD_SHA, 11),
                createGreenRun(OLDER_SHA, 10),
            ],
            readGatesFn: () => 'success',
            requiredCommits: [requiredSha],
            runCommand: () => '',
        })).toThrow(new RegExp(
            `Selected green release candidate ${OLDER_SHA}.*newest green candidate that does is ${HEAD_SHA}`
            + `.*gh workflow run release-artifacts\\.yml --ref main --field target_ref=${HEAD_SHA}`,
            'u',
        ));
    });
});

describe('createArtifactEvidenceLookup', () => {
    it('lists canary runs once and accepts only a completed successful run for the exact sha', () => {
        let listCalls = 0;
        const hasEvidence = createArtifactEvidenceLookup(() => {
            listCalls += 1;
            return JSON.stringify([
                {
                    conclusion: 'success',
                    createdAt: '2026-09-16T16:22:02Z',
                    databaseId: 2,
                    headBranch: 'main',
                    headSha: HEAD_SHA,
                    status: 'completed',
                    url: 'https://github.com/example/canary/runs/2',
                },
                {
                    conclusion: 'failure',
                    createdAt: '2026-09-16T15:26:29Z',
                    databaseId: 1,
                    headBranch: 'main',
                    headSha: PARENT_SHA,
                    status: 'completed',
                    url: 'https://github.com/example/canary/runs/1',
                },
                {
                    conclusion: '',
                    createdAt: '2026-09-16T19:55:42Z',
                    databaseId: 3,
                    headBranch: 'main',
                    headSha: TIP_SHA,
                    status: 'in_progress',
                    url: 'https://github.com/example/canary/runs/3',
                },
            ]);
        });

        expect(hasEvidence(HEAD_SHA)).toBe(true);
        expect(hasEvidence(PARENT_SHA)).toBe(false);
        expect(hasEvidence(TIP_SHA)).toBe(false);
        expect(hasEvidence(RELEASE_SHA)).toBe(false);
        expect(listCalls).toBe(1);
    });
});

describe('resumeRelease', () => {
    function createResumeOptions(overrides: Record<string, unknown> = {}) {
        const commands: string[] = [];
        const events: string[] = [];
        return {
            assertCleanWorktreeFn: () => undefined,
            assertGitHubCliReadyFn: async () => undefined,
            assertNodeBaselineFn: () => undefined,
            carryVersionToMainFn: async (request: unknown) => {
                events.push('carry');
                commands.push(`carry ${JSON.stringify(request)}`);
                return {
                    carried: true,
                    sha: TIP_SHA,
                };
            },
            commands,
            events,
            fastForwardLocalMainFn: () => events.push('fast-forward'),
            fetchReleaseMainFn: () => events.push('fetch-main'),
            fetchReleaseTagsFn: () => events.push('fetch-tags'),
            findActiveReleaseRunFn: () => null,
            getUpstreamFn: () => UPSTREAM,
            isAncestorFn: () => true,
            publishReleaseCommitFn: async (request: unknown) => {
                events.push('publish');
                commands.push(`publish ${JSON.stringify(request)}`);
                return RELEASE_SHA;
            },
            readGreatestReleaseTagFn: () => ({
                tag: 'v0.1.446',
                version: '0.1.446',
            }),
            readReleaseFn: () => ({
                assets: [],
                isDraft: true,
                publishedAt: null,
                tagName: 'v0.1.446',
            }),
            runCommand: (command: string, args: string[]) => {
                commands.push(`${command} ${args.join(' ')}`);
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/tags/')) {
                    return RELEASE_SHA;
                }
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
                    return PARENT_SHA;
                }
                if (command === 'git' && args[0] === 'diff' && args[1] === '--numstat') {
                    return '1\t1\tpackage.json';
                }
                if (command === 'git' && args[0] === 'diff' && args[1] === '-U0') {
                    return '-  "version": "0.1.445",\n+  "version": "0.1.446",';
                }
                if (command === 'git' && args[0] === 'log') {
                    return 'release: 0.1.446 [skip ci]';
                }
                return '';
            },
            releaseWorktreeFn: async ({operation}: {operation: () => Promise<unknown>}) => operation(),
            stderr: {write: () => true},
            ...overrides,
        };
    }

    it('repairs a draft without deleting it and redispatches the tagged commit, then carries the version', async () => {
        const options = createResumeOptions();

        await resumeRelease(options);

        expect(options.commands).not.toContain('gh release delete v0.1.446 --yes');
        expect(options.events).toEqual([
            'fetch-main',
            'fetch-tags',
            'publish',
            'carry',
        ]);
        expect(options.commands).toContain(`publish ${JSON.stringify({
            parentSha: PARENT_SHA,
            tag: 'v0.1.446',
            targetSha: RELEASE_SHA,
            upstream: UPSTREAM,
        })}`);
        expect(options.commands).toContain(`carry ${JSON.stringify({
            releaseParentSha: PARENT_SHA,
            releaseSha: RELEASE_SHA,
            subject: 'release: 0.1.446 [skip ci]',
            tag: 'v0.1.446',
            upstream: UPSTREAM,
            version: '0.1.446',
        })}`);
    });

    it('hands off to a release run that is still going instead of dispatching again', async () => {
        const options = createResumeOptions({findActiveReleaseRunFn: () => ({
            conclusion: null,
            status: 'in_progress',
            url: 'https://github.com/evb0110/evb-viewer/actions/runs/123',
        })});

        await resumeRelease(options);

        expect(options.events).toEqual([
            'fetch-main',
            'fetch-tags',
            'carry',
        ]);
    });

    it('binds resume mutations to the tagged commit worktree', async () => {
        let worktreeCandidate: string | undefined;
        const options = createResumeOptions({releaseWorktreeFn: async ({
            candidateSha, operation,
        }: {
            candidateSha: string;
            operation: () => Promise<unknown>;
        }) => {
            worktreeCandidate = candidateSha;
            await operation();
        }});

        await resumeRelease(options);

        expect(worktreeCandidate).toBe(RELEASE_SHA);
        expect(options.events).not.toContain('fast-forward');
    });

    it('only carries the version for a public release whose main is behind', async () => {
        const options = createResumeOptions({readReleaseFn: () => ({
            assets: [],
            isDraft: false,
            publishedAt: '2026-09-01T08:30:00.000Z',
            tagName: 'v0.1.446',
        })});

        await resumeRelease(options);

        expect(options.events).not.toContain('publish');
        expect(options.events).toContain('carry');
    });

    it('refuses to resume a public release that main already carries', async () => {
        const options = createResumeOptions({
            carryVersionToMainFn: async () => ({
                carried: false,
                sha: TIP_SHA,
            }),
            readReleaseFn: () => ({
                assets: [],
                isDraft: false,
                publishedAt: '2026-09-01T08:30:00.000Z',
                tagName: 'v0.1.446',
            }),
        });

        await expect(resumeRelease(options)).rejects.toThrow(/already public.*release:status/u);
    });

    it('refuses a tagged commit whose parent is not on main', async () => {
        const options = createResumeOptions({isAncestorFn: () => false});

        await expect(resumeRelease(options)).rejects.toThrow(/parent b{40} of v0\.1\.446 to be on origin\/main/u);
        expect(options.events).not.toContain('publish');
    });
});

describe('carryVersionToMain', () => {
    interface ICarryState {
        pushFailures?: string[];
        tipSha: string;
        tipVersion: string;
    }

    function createCarry(state: ICarryState) {
        const commands: string[] = [];
        const pushFailures = [...state.pushFailures ?? []];
        const runCommand = (command: string, args: string[]) => {
            commands.push(`${command} ${args.join(' ')}`);
            if (command === 'git' && args[0] === 'rev-parse') {
                return state.tipSha;
            }
            if (command === 'git' && args[0] === 'show') {
                return `{\n  "version": "${state.tipVersion}"\n}`;
            }
            return '';
        };
        return {
            commands,
            run: () => carryVersionToMain({
                releaseParentSha: PARENT_SHA,
                releaseSha: RELEASE_SHA,
                subject: 'release: 0.1.446 [skip ci]',
                tag: 'v0.1.446',
                upstream: UPSTREAM,
                version: '0.1.446',
            }, {
                createCommitFn: (input: {parentSha: string}) => {
                    commands.push(`create ${input.parentSha}`);
                    return TIP_SHA.replace(/e/gu, 'f');
                },
                pushBranchFn: (input: {targetSha?: string}) => {
                    commands.push(`push ${input.targetSha}`);
                    const failure = pushFailures.shift();
                    if (failure !== undefined) {
                        throw new Error(failure);
                    }
                    return input.targetSha ?? '';
                },
                runCommand,
                sleepFn: async () => undefined,
                stderr: {write: () => true},
            }),
        };
    }

    it('fast-forwards main with the release commit while main still sits at its parent', async () => {
        const {
            commands,
            run,
        } = createCarry({
            tipSha: PARENT_SHA,
            tipVersion: '0.1.445',
        });

        await expect(run()).resolves.toEqual({
            carried: true,
            sha: RELEASE_SHA,
        });
        expect(commands).toContain(`push ${RELEASE_SHA}`);
        expect(commands.some(command => command.startsWith('create '))).toBe(false);
    });

    it('adds a version-only commit on the moved tip instead of rewriting it', async () => {
        const {
            commands,
            run,
        } = createCarry({
            tipSha: TIP_SHA,
            tipVersion: '0.1.445',
        });

        await expect(run()).resolves.toEqual({
            carried: true,
            sha: 'f'.repeat(40),
        });
        expect(commands).toContain(`create ${TIP_SHA}`);
        expect(commands).toContain(`push ${'f'.repeat(40)}`);
    });

    it('refetches and retries after losing a push race', async () => {
        const {
            commands,
            run,
        } = createCarry({
            pushFailures: ['! [rejected] main -> main (fetch first)'],
            tipSha: TIP_SHA,
            tipVersion: '0.1.445',
        });

        await expect(run()).resolves.toEqual({
            carried: true,
            sha: 'f'.repeat(40),
        });
        expect(commands.filter(command => command.startsWith('push ')).length).toBe(2);
        expect(commands.filter(command => command.startsWith('git fetch')).length).toBe(2);
    });

    it('leaves main alone when it already carries the version and reports the failure otherwise', async () => {
        const carriedAlready = createCarry({
            tipSha: TIP_SHA,
            tipVersion: '0.1.446',
        });
        await expect(carriedAlready.run()).resolves.toEqual({
            carried: false,
            sha: TIP_SHA,
        });
        expect(carriedAlready.commands.some(command => command.startsWith('push '))).toBe(false);

        const rejected = createCarry({
            pushFailures: ['remote: GH006: Protected branch update failed'],
            tipSha: TIP_SHA,
            tipVersion: '0.1.445',
        });
        await expect(rejected.run()).rejects.toThrow(/v0\.1\.446 is tagged and dispatched.*release:resume/u);
    });
});

describe('publishReleaseCommit tag ownership', () => {
    const TAG = 'v0.1.450';
    const OTHER_SHA = 'c'.repeat(40);

    interface ITagState {
        local?: string;
        remote?: string;
    }

    function createPublisher(tagState: ITagState) {
        const commands: string[] = [];
        const runCommand = (command: string, args: string[]) => {
            commands.push(`${command} ${args.join(' ')}`);
            if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
                if (tagState.local === undefined) {
                    throw Object.assign(new Error('missing tag'), {status: 1});
                }
                return tagState.local;
            }
            if (command === 'git' && args[0] === 'ls-remote') {
                return tagState.remote === undefined
                    ? ''
                    : `${tagState.remote}\trefs/tags/${TAG}`;
            }
            return '';
        };

        return {
            commands,
            publish: () => publishReleaseCommit({
                parentSha: PARENT_SHA,
                tag: TAG,
                targetSha: HEAD_SHA,
                upstream: UPSTREAM,
            }, {
                dispatchWorkflow: () => commands.push('dispatch'),
                printHandoff: async () => undefined,
                runCommand,
                scanPublication: () => commands.push('scan'),
            }),
        };
    }

    it('scans, creates and pushes the tag at the release commit, then dispatches', async () => {
        const {
            commands,
            publish,
        } = createPublisher({});

        await expect(publish()).resolves.toBe(HEAD_SHA);

        expect(commands).toEqual([
            'scan',
            `git rev-parse --verify --quiet refs/tags/${TAG}^{commit}`,
            `git ls-remote --tags origin refs/tags/${TAG}`,
            `git tag ${TAG} ${HEAD_SHA}`,
            `git push origin refs/tags/${TAG}`,
            'dispatch',
        ]);
    });

    it('reuses a remote tag that already points at the release commit on resume', async () => {
        const {
            commands,
            publish,
        } = createPublisher({
            local: HEAD_SHA,
            remote: HEAD_SHA,
        });

        await expect(publish()).resolves.toBe(HEAD_SHA);

        expect(commands.filter(command => command.startsWith('git tag') || command.startsWith('git push'))).toEqual([]);
        expect(commands.at(-1)).toBe('dispatch');
    });

    it('pushes an existing local tag when the remote lacks it', async () => {
        const {
            commands,
            publish,
        } = createPublisher({local: HEAD_SHA});

        await expect(publish()).resolves.toBe(HEAD_SHA);

        expect(commands.filter(command => command.startsWith('git tag'))).toEqual([]);
        expect(commands.slice(-2)).toEqual([
            `git push origin refs/tags/${TAG}`,
            'dispatch',
        ]);
    });

    it('refuses a remote tag that points elsewhere and never dispatches', async () => {
        const {
            commands,
            publish,
        } = createPublisher({remote: OTHER_SHA});

        await expect(publish()).rejects.toThrow(
            `Tag ${TAG} on origin points at ${OTHER_SHA}, not release target ${HEAD_SHA}.`,
        );

        expect(commands).not.toContain('dispatch');
        expect(commands.some(command => command.startsWith('git tag') || command.startsWith('git push'))).toBe(false);
    });

    it('refuses a stale local tag before touching the remote', async () => {
        const {
            commands,
            publish,
        } = createPublisher({local: OTHER_SHA});

        await expect(publish()).rejects.toThrow(`Local tag ${TAG} points at ${OTHER_SHA}`);

        expect(commands).toEqual([
            'scan',
            `git rev-parse --verify --quiet refs/tags/${TAG}^{commit}`,
        ]);
    });
});

describe('runReleasePreflight', () => {
    it('accepts the candidate inclusion and artifact evidence options', () => {
        expect(parseReleasePreflightArgs([
            '--require-commit',
            HEAD_SHA,
            '--artifact-evidence=advisory',
        ])).toEqual({
            artifactEvidence: 'advisory',
            requiredCommits: [HEAD_SHA],
        });
    });

    it('runs the patch preconditions and reports the version step', async () => {
        const calls: unknown[] = [];
        const output: string[] = [];

        const result = await runReleasePreflight({
            assertPreconditions: async (options: unknown) => {
                calls.push(options);
                return {
                    candidateCiRunId: 42,
                    candidateCiRunUrl: 'https://github.com/example/ci/runs/42',
                    candidateSha: HEAD_SHA,
                    currentVersion: '1.2.3',
                    nextVersion: '1.2.4',
                    upstream: UPSTREAM,
                };
            },
            write: (message: string) => {
                output.push(message);
            },
        });

        expect(calls).toEqual([{
            artifactEvidence: undefined,
            context: 'Release preflight',
            level: 'patch',
            requiredCommits: [],
        }]);
        expect(output).toEqual([`Release patch preflight passed for candidate ${HEAD_SHA} (ci.yml run 42: https://github.com/example/ci/runs/42): 1.2.3 -> 1.2.4 on origin/main.\n`]);
        expect(result.nextVersion).toBe('1.2.4');
    });
});
