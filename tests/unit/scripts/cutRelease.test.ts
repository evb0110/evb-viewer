import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertReleaseCutPreconditions,
    cutRelease,
    parseCutReleaseArgs,
    publishReleaseCommit,
    resumeRelease,
} from '@scripts/release/cut-release.mjs';
import {runReleasePreflight} from '@scripts/release/release-cut-preflight.mjs';

const HEAD_SHA = 'a'.repeat(40);
const PARENT_SHA = 'b'.repeat(40);
const UPSTREAM = {
    branch: 'main',
    ref: 'origin/main',
    remote: 'origin',
};

function createPreconditionOptions(overrides: Record<string, unknown> = {}) {
    const events: string[] = [];

    return {
        assertArtifactCanaryGreenFn: () => events.push('canary'),
        assertCleanWorktreeFn: () => events.push('clean'),
        assertCurrentReleaseIsNotDraftFn: (tag: string) => events.push(`draft:${tag}`),
        assertGitHubCliReadyFn: async () => {
            events.push('github');
        },
        assertMainTipFn: () => {
            events.push('tip');
            return {
                headSha: HEAD_SHA,
                upstreamSha: HEAD_SHA,
            };
        },
        assertNodeBaselineFn: () => events.push('node'),
        assertTagAbsentFn: async (tag: string) => {
            events.push(`tag:${tag}`);
        },
        assertVersionNotBehindAncestorFn: () => {
            events.push('ancestor-version');
        },
        events,
        findCiRunFn: () => ({
            conclusion: 'success',
            html_url: 'https://github.com/example/ci/runs/10',
            status: 'completed',
        }),
        getUpstreamFn: () => UPSTREAM,
        level: 'patch' as const,
        readVersionFn: () => '0.1.445',
        runCommand: () => '',
        waitForCiFn: async (sha: string) => {
            events.push(`wait:${sha}`);
        },
        ...overrides,
    };
}

describe('cut-release', () => {
    it('accepts a release level without the rejected separator form', () => {
        expect(parseCutReleaseArgs(['patch'])).toEqual({
            level: 'patch',
            resume: false,
        });
        expect(parseCutReleaseArgs(['minor'])).toEqual({
            level: 'minor',
            resume: false,
        });
    });

    it('removes the old local verification flag', () => {
        expect(() => parseCutReleaseArgs([
            '--full-verify',
            'patch',
        ])).toThrow(/Unknown release option/u);
    });

    it('checks the fetched main tip, CI, canary, current release, and next tag before bumping', async () => {
        const options = createPreconditionOptions();
        const result = await assertReleaseCutPreconditions(options);

        expect(result).toEqual({
            currentVersion: '0.1.445',
            headSha: HEAD_SHA,
            nextVersion: '0.1.446',
            upstream: UPSTREAM,
        });
        expect(options.events).toEqual([
            'node',
            'github',
            'clean',
            'tip',
            'ancestor-version',
            `wait:${HEAD_SHA}`,
            'canary',
            'draft:v0.1.445',
            'tag:v0.1.446',
        ]);
    });

    it('refuses a red artifact canary on main with its URL', async () => {
        const options = createPreconditionOptions({
            assertArtifactCanaryGreenFn: undefined,
            runCommand: () => JSON.stringify([{
                conclusion: 'failure',
                createdAt: '2026-09-10T08:54:36Z',
                databaseId: 7,
                displayTitle: 'Build Release Artifacts',
                event: 'schedule',
                headBranch: 'main',
                headSha: PARENT_SHA,
                name: 'Build Release Artifacts',
                status: 'completed',
                url: 'https://github.com/example/canary/runs/7',
                workflowName: 'Build Release Artifacts',
            }]),
        });

        await expect(assertReleaseCutPreconditions(options))
            .rejects.toThrow(/release:artifacts.*https:\/\/github\.com\/example\/canary\/runs\/7/u);
    });

    it('waits for the push run when HEAD has none yet', async () => {
        const options = createPreconditionOptions({findCiRunFn: () => null});

        await assertReleaseCutPreconditions(options);

        expect(options.events).toContain(`wait:${HEAD_SHA}`);
    });

    it('refuses a failed HEAD CI run with its URL', async () => {
        const options = createPreconditionOptions({findCiRunFn: () => ({
            conclusion: 'failure',
            html_url: 'https://github.com/example/ci/runs/99',
            status: 'completed',
        })});

        await expect(assertReleaseCutPreconditions(options))
            .rejects.toThrow(/https:\/\/github\.com\/example\/ci\/runs\/99/u);
    });

    it('commits only the bumped package version with skip-ci attribution', async () => {
        let version = '0.1.445';
        const commands: string[] = [];
        const stagedFiles: string[][] = [];
        const changedFileAssertions: unknown[] = [];
        let published: unknown;
        const options = createPreconditionOptions({
            assertChangedFilesMatchFn: (...args: unknown[]) => changedFileAssertions.push(args),
            readVersionFn: () => version,
            runCommand: (command: string, args: string[]) => {
                commands.push(`${command} ${args.join(' ')}`);
                return '';
            },
            stageFilesFn: (files: string[]) => stagedFiles.push(files),
            writeVersionFn: (nextVersion: string) => {
                version = nextVersion;
            },
            publishReleaseCommitFn: async (request: unknown) => {
                published = request;
            },
        });

        await cutRelease('patch', options);

        expect(version).toBe('0.1.446');
        expect(stagedFiles).toEqual([['package.json']]);
        expect(changedFileAssertions).toHaveLength(1);
        expect(commands).toContain(
            'git commit -m release: 0.1.446 [skip ci] -- package.json',
        );
        expect(commands.some(command => command.includes('release:verify'))).toBe(false);
        expect(published).toEqual({
            tag: 'v0.1.446',
            upstream: UPSTREAM,
        });
    });

    it('repairs a draft without deleting it and redispatches the current release SHA', async () => {
        const commands: string[] = [];
        let publishedOptions: Parameters<typeof publishReleaseCommit>[1];
        let publishedRequest: Parameters<typeof publishReleaseCommit>[0] | undefined;
        const options = {
            assertCleanWorktreeFn: () => undefined,
            assertGitHubCliReadyFn: async () => undefined,
            assertNodeBaselineFn: () => undefined,
            fetchReleaseMainFn: () => undefined,
            getUpstreamFn: () => UPSTREAM,
            readReleaseFn: () => ({
                assets: [],
                isDraft: true,
                publishedAt: null,
                tagName: 'v0.1.446',
            }),
            readVersionFn: () => '0.1.446',
            runCommand: (command: string, args: string[]) => {
                commands.push(`${command} ${args.join(' ')}`);
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
                    return HEAD_SHA;
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
            publishReleaseCommitFn: async (
                request: Parameters<typeof publishReleaseCommit>[0],
                publishOptions: Parameters<typeof publishReleaseCommit>[1],
            ) => {
                publishedRequest = request;
                publishedOptions = publishOptions;
                return HEAD_SHA;
            },
        };

        await resumeRelease(options);

        expect(commands).not.toContain('gh release delete v0.1.446 --yes');
        expect(publishedRequest).toEqual({
            tag: 'v0.1.446',
            targetSha: HEAD_SHA,
            upstream: UPSTREAM,
        });
        expect(publishedOptions?.push).toBe(false);
    });

    it('refuses to resume a public release', async () => {
        const options = {
            assertCleanWorktreeFn: () => undefined,
            assertGitHubCliReadyFn: async () => undefined,
            assertNodeBaselineFn: () => undefined,
            fetchReleaseMainFn: () => undefined,
            getUpstreamFn: () => UPSTREAM,
            readReleaseFn: () => ({
                assets: [],
                isDraft: false,
                publishedAt: '2026-09-01T08:30:00.000Z',
                tagName: 'v0.1.446',
            }),
            readVersionFn: () => '0.1.446',
            runCommand: (command: string, args: string[]) => {
                if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
                    return HEAD_SHA;
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
        };

        await expect(resumeRelease(options)).rejects.toThrow(/already public.*release:status/u);
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
                tag: TAG,
                targetSha: HEAD_SHA,
                upstream: UPSTREAM,
            }, {
                dispatchWorkflow: () => commands.push('dispatch'),
                printHandoff: async () => undefined,
                push: false,
                runCommand,
            }),
        };
    }

    it('creates and pushes the tag at the release commit before dispatching', async () => {
        const {
            commands,
            publish,
        } = createPublisher({});

        await expect(publish()).resolves.toBe(HEAD_SHA);

        expect(commands).toEqual([
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

        expect(commands).toEqual([`git rev-parse --verify --quiet refs/tags/${TAG}^{commit}`]);
    });
});

describe('runReleasePreflight', () => {
    it('runs the patch preconditions and reports the version step', async () => {
        const calls: unknown[] = [];
        const output: string[] = [];

        const result = await runReleasePreflight({
            assertPreconditions: async (options: unknown) => {
                calls.push(options);
                return {
                    currentVersion: '1.2.3',
                    headSha: HEAD_SHA,
                    nextVersion: '1.2.4',
                    upstream: UPSTREAM,
                };
            },
            write: (message: string) => {
                output.push(message);
            },
        });

        expect(calls).toEqual([{
            context: 'Release preflight',
            level: 'patch',
        }]);
        expect(output).toEqual(['Release patch preflight passed: 1.2.3 -> 1.2.4 on origin/main.\n']);
        expect(result.nextVersion).toBe('1.2.4');
    });
});
