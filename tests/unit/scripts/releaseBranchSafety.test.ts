import {
    execFileSync,
    spawnSync,
} from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    delimiter,
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

const releaseScript = resolve(process.cwd(), 'scripts/release/cut-release.mjs');
const temporaryRoots: string[] = [];

interface IReleaseModule {
    cutRelease: (
        level: 'patch',
        options: Record<string, unknown>,
    ) => Promise<void>;
    printReleaseWorkflowHandoff: (
        options: {
            dispatchStartedAt: string;
            tag: string;
            targetSha: string;
        },
        dependencies: {
            nowFn: () => number;
            readHandoffTimeoutMs: () => number;
            sleepFn: (duration: number) => Promise<void>;
            stdout: { write: (message: string) => void };
            waitForRun: (options: Record<string, unknown>) => Promise<{
                conclusion: string | null;
                status: string;
                url: string;
            }>;
        },
    ) => Promise<void>;
}

const {
    cutRelease,
    printReleaseWorkflowHandoff,
} = await import(
    pathToFileURL(releaseScript).href,
) as IReleaseModule;

function writeExecutable(filePath: string, source: string): void {
    writeFileSync(filePath, source);
    chmodSync(filePath, 0o755);
}

function writeCommandShim(bin: string, command: string, source: string): void {
    writeExecutable(join(bin, command), source);
    writeFileSync(
        join(bin, `${command}.cmd`),
        `@echo off\r\nnode "%~dp0${command}" %*\r\n`,
    );
}

function createReleaseFixture(branch: string, upstream = 'origin/main') {
    const root = mkdtempSync(join(tmpdir(), 'evb-release-branch-safety-'));
    temporaryRoots.push(root);
    const bin = join(root, 'bin');
    const commandLog = join(root, 'commands.log');
    const cliRunner = join(root, 'run-release-cli.cjs');
    const packageJson = join(root, 'package.json');
    const nodeMajor = process.versions.node.split('.')[0];

    writeFileSync(packageJson, `${JSON.stringify({
        engines: {node: `${nodeMajor}.x`},
        version: '9.9.9',
    }, null, 2)}\n`);
    writeFileSync(cliRunner, `const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { pathToFileURL } = require('node:url');

if (process.platform === 'win32') {
    const realExecFileSync = childProcess.execFileSync;
    childProcess.execFileSync = (command, arguments_ = [], options = {}) => {
        if ([ 'gh', 'git', 'pnpm' ].includes(command)) {
            const commandLine = [ command + '.cmd', ...arguments_ ].join(' ');
            return realExecFileSync(process.env.ComSpec || 'cmd.exe', [
                '/d',
                '/s',
                '/c',
                commandLine,
            ], options);
        }

        return realExecFileSync(command, arguments_, options);
    };
    syncBuiltinESMExports();
}

process.argv = [
    process.execPath,
    process.env.EVB_RELEASE_TEST_SCRIPT,
    ...process.argv.slice(2),
];
import(pathToFileURL(process.env.EVB_RELEASE_TEST_SCRIPT).href).catch((error) => {
    process.stderr.write(String(error) + '\\n');
    process.exitCode = 1;
});
`);
    mkdirSync(bin);
    writeCommandShim(bin, 'git', `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const arguments_ = process.argv.slice(2).join(' ');
appendFileSync(process.env.EVB_RELEASE_TEST_LOG, 'git ' + arguments_ + '\\n');
if (arguments_ === 'rev-parse --abbrev-ref HEAD') {
    process.stdout.write(${JSON.stringify(`${branch}\n`)});
    process.exit(0);
}
if (arguments_ === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
    process.stdout.write(${JSON.stringify(`${upstream}\n`)});
    process.exit(0);
}
process.exit(88);
`);
    for (const command of [
        'gh',
        'pnpm',
    ]) {
        writeCommandShim(bin, command, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const arguments_ = process.argv.slice(2).join(' ');
appendFileSync(process.env.EVB_RELEASE_TEST_LOG, ${JSON.stringify(`${command} `)} + arguments_ + '\\n');
process.exit(88);
`);
    }

    return {
        bin,
        cliRunner,
        commandLog,
        packageJson,
        root,
    };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, {
            force: true,
            recursive: true,
        });
    }
});

describe('release branch safety', () => {
    it('provides equivalent POSIX and Windows command shims', () => {
        const fixture = createReleaseFixture('main');

        for (const command of [
            'gh',
            'git',
            'pnpm',
        ]) {
            expect(readFileSync(join(fixture.bin, `${command}.cmd`), 'utf8')).toBe(
                `@echo off\r\nnode "%~dp0${command}" %*\r\n`,
            );
        }
    });

    it('does not require a clean named main branch before read-only verification', () => {
        const fixture = createReleaseFixture('feature/release');
        const dirtyPath = join(fixture.root, 'caller-dirty.txt');
        writeFileSync(dirtyPath, 'keep me');
        const result = spawnSync(process.execPath, [
            fixture.cliRunner,
            'patch',
        ], {
            cwd: fixture.root,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${join(fixture.root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
                EVB_RELEASE_TEST_SCRIPT: releaseScript,
                EVB_RELEASE_TEST_LOG: fixture.commandLog,
            },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('requires an authenticated GitHub CLI session');
        expect(result.stderr).not.toContain('requires the current branch to be main');
        expect(readFileSync(fixture.commandLog, 'utf8')).toBe('gh auth status\n');
        expect(readFileSync(dirtyPath, 'utf8')).toBe('keep me');
        expect(JSON.parse(readFileSync(fixture.packageJson, 'utf8')).version).toBe('9.9.9');
    });

    it('does not inspect the caller upstream when resuming from another checkout', () => {
        const fixture = createReleaseFixture('main', 'fork/main');
        const result = spawnSync(process.execPath, [
            fixture.cliRunner,
            '--resume',
        ], {
            cwd: fixture.root,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${join(fixture.root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
                EVB_RELEASE_TEST_SCRIPT: releaseScript,
                EVB_RELEASE_TEST_LOG: fixture.commandLog,
            },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Command failed: git fetch --no-tags origin');
        expect(result.stderr).not.toContain('requires main to track origin/main');
        expect(readFileSync(fixture.commandLog, 'utf8')).toContain('git fetch --no-tags origin');
        expect(readFileSync(fixture.commandLog, 'utf8')).not.toContain('rev-parse --abbrev-ref');
        expect(JSON.parse(readFileSync(fixture.packageJson, 'utf8')).version).toBe('9.9.9');
    });

    it('runs release mutations in a disposable detached worktree and leaves a dirty caller untouched', async () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-release-worktree-'));
        temporaryRoots.push(root);
        const runGit = (args: string[]) => execFileSync('git', args, {
            cwd: root,
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        }).trim();
        runGit([
            'init',
            '--quiet',
            '--initial-branch=feature/release',
        ]);
        runGit([
            'config',
            'user.email',
            'release-test@example.test',
        ]);
        runGit([
            'config',
            'user.name',
            'Release Test',
        ]);
        writeFileSync(join(root, '.gitignore'), '.devkit/\n');
        writeFileSync(join(root, 'package.json'), JSON.stringify({version: '1.2.3'}, null, 2));
        runGit([
            'add',
            '.gitignore',
            'package.json',
        ]);
        runGit([
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '-m',
            'candidate',
        ]);
        const candidateSha = runGit([
            'rev-parse',
            'HEAD',
        ]);
        const dirtyPath = join(root, 'caller-dirty.txt');
        writeFileSync(dirtyPath, 'preserve this file');

        const originalCwd = process.cwd();
        const mutationCwds: string[] = [];
        const runCommand = (command: string, args: string[], options: object = {}) => {
            const output = execFileSync(command, args, {
                cwd: process.cwd(),
                encoding: 'utf8',
                stdio: [
                    'ignore',
                    'pipe',
                    'pipe',
                ],
                ...options,
            });
            return output == null ? '' : String(output).trim();
        };

        try {
            process.chdir(root);
            await cutRelease('patch', {
                assertArtifactCanaryGreenFn: () => ({state: 'satisfied'}),
                assertCurrentReleaseIsNotDraftFn: () => undefined,
                assertExtendedCiGreenFn: () => ({state: 'satisfied'}),
                assertGitHubCliReadyFn: async () => undefined,
                assertNodeBaselineFn: () => undefined,
                assertTagAbsentFn: async () => undefined,
                assertVersionNotBehindAncestorFn: () => undefined,
                carryVersionToMainFn: async () => {
                    mutationCwds.push(process.cwd());
                    return {
                        carried: true,
                        sha: 'd'.repeat(40),
                    };
                },
                createReleaseCommitFn: () => {
                    mutationCwds.push(process.cwd());
                    return 'd'.repeat(40);
                },
                fetchReleaseMainFn: () => undefined,
                getUpstreamFn: () => ({
                    branch: 'main',
                    ref: 'origin/main',
                    remote: 'origin',
                }),
                isAncestorFn: () => true,
                level: 'patch',
                publishReleaseCommitFn: async () => {
                    mutationCwds.push(process.cwd());
                    return 'd'.repeat(40);
                },
                readGreatestReleaseTagFn: () => null,
                readVersionAtFn: () => '1.2.3',
                runCommand,
                selectReleaseCandidateFn: () => ({
                    run: {
                        conclusion: 'success',
                        event: 'push',
                        head_branch: 'main',
                        head_sha: candidateSha,
                        html_url: 'https://github.com/example/ci/runs/1',
                        id: 1,
                        status: 'completed',
                    },
                    sha: candidateSha,
                }),
                stderr: {write: () => true},
            });
        } finally {
            process.chdir(originalCwd);
        }

        expect(mutationCwds).toHaveLength(3);
        expect(mutationCwds.every(cwd => /[\\/]\.devkit[\\/]release[\\/]candidate-/u.test(cwd))).toBe(true);
        expect(readFileSync(dirtyPath, 'utf8')).toBe('preserve this file');
        expect(runGit([
            'branch',
            '--show-current',
        ])).toBe('feature/release');
        expect(runGit([
            'status',
            '--short',
        ])).toContain('?? caller-dirty.txt');
        expect(readdirSync(join(root, '.devkit', 'release'))).toEqual([]);
    });

    it.each([
        'pending',
        'queued',
        'requested',
        'waiting',
    ])('fails handoff when a %s workflow later concludes as skipped', async (initialStatus) => {
        const output: string[] = [];
        let now = 0;
        let pollCount = 0;

        await expect(printReleaseWorkflowHandoff({
            dispatchStartedAt: '2026-08-22T00:00:00.000Z',
            tag: 'v9.9.9',
            targetSha: 'abc123',
        }, {
            nowFn: () => now,
            readHandoffTimeoutMs: () => 60_000,
            sleepFn: async (duration: number) => {
                now += duration;
            },
            stdout: { write: (message: string) => output.push(message) },
            waitForRun: async () => {
                pollCount += 1;

                return pollCount === 1
                    ? {
                        conclusion: null,
                        status: initialStatus,
                        url: 'https://github.com/evb0110/evb-viewer/actions/runs/123',
                    }
                    : {
                        conclusion: 'skipped',
                        status: 'completed',
                        url: 'https://github.com/evb0110/evb-viewer/actions/runs/123',
                    };
            },
        })).rejects.toThrow('concluded as skipped');
        expect(pollCount).toBe(2);
        expect(output).toEqual([]);
    });

    it.each([
        'action_required',
        'cancelled',
        'failure',
        'skipped',
        'stale',
        'startup_failure',
        'timed_out',
    ])('fails handoff when the release workflow concludes as %s', async (conclusion) => {
        const output: string[] = [];

        await expect(printReleaseWorkflowHandoff({
            dispatchStartedAt: '2026-08-22T00:00:00.000Z',
            tag: 'v9.9.9',
            targetSha: 'abc123',
        }, {
            nowFn: () => 0,
            readHandoffTimeoutMs: () => 60_000,
            sleepFn: async () => undefined,
            stdout: { write: (message: string) => output.push(message) },
            waitForRun: async () => ({
                conclusion,
                status: 'completed',
                url: 'https://github.com/evb0110/evb-viewer/actions/runs/123',
            }),
        })).rejects.toThrow(`concluded as ${conclusion}`);
        expect(output).toEqual([]);
    });

    it.each([
        {
            conclusion: null,
            status: 'in_progress',
        },
        {
            conclusion: 'success',
            status: 'completed',
        },
    ])('prints handoff for an admitted $status workflow', async ({
        conclusion,
        status,
    }) => {
        const output: string[] = [];
        const waitForRunCalls: Array<Record<string, unknown>> = [];

        await printReleaseWorkflowHandoff({
            dispatchStartedAt: '2026-08-22T00:00:00.000Z',
            tag: 'v9.9.9',
            targetSha: 'abc123',
        }, {
            nowFn: () => 0,
            readHandoffTimeoutMs: () => 60_000,
            sleepFn: async () => undefined,
            stdout: { write: (message: string) => output.push(message) },
            waitForRun: async (options) => {
                waitForRunCalls.push(options);

                return {
                    conclusion,
                    status,
                    url: 'https://github.com/evb0110/evb-viewer/actions/runs/123',
                };
            },
        });

        expect(output.join('')).toContain('Release v9.9.9 queued for commit abc123.');
        // The run is dispatched on main, so its head SHA is never the release commit.
        expect(waitForRunCalls).toEqual([{
            createdAfter: '2026-08-22T00:00:00.000Z',
            displayTitles: [
                'Release v9.9.9',
                'Release (v9.9.9)',
            ],
            label: 'Release workflow for v9.9.9',
            workflow: 'Release',
        }]);
    });
});
