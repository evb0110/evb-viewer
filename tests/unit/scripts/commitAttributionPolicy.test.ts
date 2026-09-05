import { spawnSync } from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {
    devNull,
    tmpdir,
} from 'node:os';
import path, { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {removeTemporaryDirectory} from '@tests/helpers/removeTemporaryDirectory';

interface IViolation {
    matches: string[];
    subject: string;
}

interface IPrePushWork {
    commits: string[];
    nestedTagRefs: string[];
    rejectedRefs: string[];
    tagObjects: Array<{
        content: string;
        oid: string;
        ref: string;
    }>;
}

interface ICommitAttributionModule {
    FORBIDDEN_ATTRIBUTION_RULES: Array<{
        label: string;
        pattern: RegExp;
    }>;
    collectPrePushWork: (input: string, remoteTargets: string[], cwd?: string) => IPrePushWork;
    collectPushedRangeCommits: (beforeOid: string, headOid: string, cwd?: string) => string[];
    findCommitViolations: (commits: string[], cwd?: string) => IViolation[];
    findForbiddenAttribution: (text: string) => string[];
    findPushPolicyViolations: (
        commits: string[],
        cwd?: string,
        work?: Partial<IPrePushWork>,
    ) => IViolation[];
    findStagedArtifactViolations: (cwd?: string) => string[];
    main: (arguments_?: string[], cwd?: string) => void;
    parseDiffTreeRecords: (output: string, requestedCommits: string[]) => Array<{
        commit: string;
        paths: string[];
    }>;
}

const checker = await import(
    pathToFileURL(path.resolve(process.cwd(), 'scripts/check-commit-attribution.mjs')).href
) as ICommitAttributionModule;

const ZERO_OID = '0'.repeat(40);
const UNREACHABLE_OID = 'f'.repeat(40);

function runGit(cwd: string, arguments_: string[]) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
        // These fixtures assert git's own behavior, so they must not inherit the
        // developer's global config. `tag.gpgsign = true`, for one, turns the
        // lightweight `git tag` below into a signed tag and fails the run.
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_SYSTEM: devNull,
        },
    });
    if (result.status !== 0) {
        throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

async function createRepository(prefix: string, extraArguments: string[] = []) {
    const repository = await mkdtemp(join(getAbsoluteOsTemporaryDirectory(), prefix));
    runGit(repository, [
        'init',
        '--initial-branch=main',
        ...extraArguments,
        '.',
    ]);
    runGit(repository, [
        'config',
        'user.name',
        'Test User',
    ]);
    runGit(repository, [
        'config',
        'user.email',
        'test@example.test',
    ]);
    return repository;
}

function getAbsoluteOsTemporaryDirectory() {
    const configuredDirectory = tmpdir();
    if (path.isAbsolute(configuredDirectory)) {
        return configuredDirectory;
    }

    if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot;
        return join(
            systemRoot && path.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows',
            'Temp',
        );
    }

    return '/tmp';
}

async function removeRepository(repository: string) {
    await removeTemporaryDirectory(repository);
}

async function writeFiles(repository: string, files: Record<string, string>) {
    for (const [
        filePath,
        contents,
    ] of Object.entries(files)) {
        const absolutePath = join(repository, filePath);
        await mkdir(path.dirname(absolutePath), {recursive: true});
        await writeFile(absolutePath, contents, 'utf8');
    }
}

async function commit(repository: string, message: string, files: Record<string, string> = {}) {
    await writeFiles(repository, files);
    runGit(repository, [
        'add',
        '--all',
    ]);
    runGit(repository, [
        'commit',
        '--allow-empty',
        '-m',
        message,
    ]);
    return runGit(repository, [
        'rev-parse',
        'HEAD',
    ]);
}

function updateLine(remoteRef: string, localOid: string, remoteOid = ZERO_OID, localRef = remoteRef) {
    return `${localRef} ${localOid} ${remoteRef} ${remoteOid}\n`;
}

function violationSubjects(violations: IViolation[]) {
    return violations.map(({subject}) => subject);
}

function runMain(arguments_: string[], cwd?: string) {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
        checker.main(arguments_, cwd);
        return process.exitCode;
    } finally {
        process.exitCode = originalExitCode;
    }
}

function repositoryState(repository: string) {
    return [
        runGit(repository, [
            'rev-parse',
            '--is-inside-work-tree',
        ]),
        runGit(repository, [
            'rev-parse',
            '--is-bare-repository',
        ]),
        runGit(repository, [
            'rev-parse',
            'HEAD',
        ]),
        runGit(repository, [
            'status',
            '--porcelain=v1',
            '--branch',
        ]),
    ];
}

function isWithinDirectory(directory: string, candidate: string) {
    const relativePath = path.relative(directory, candidate);
    return relativePath === ''
        || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

describe('commit attribution policy', () => {
    // Each blocked marker reports exactly one label: the rules are semantically
    // distinct, so the generated co-author trailer is reported once, by the
    // identity rule that covers the address wherever it appears.
    it.each([
        [
            'Co-Authored-By: Claude <noreply@anthropic.com>',
            ['Anthropic no-reply identity'],
        ],
        [
            'co-authored-by: claude <noreply@anthropic.com>',
            ['Anthropic no-reply identity'],
        ],
        [
            'Co-authored-by: Person <noreply@anthropic.com>',
            ['Anthropic no-reply identity'],
        ],
        [
            'Generated with Claude Code',
            ['Claude generated-by marker'],
        ],
        [
            'Generated with [Claude Code](https://example.test)',
            ['Claude generated-by marker'],
        ],
    ])('blocks %s', (message, expectedLabels) => {
        expect(checker.findForbiddenAttribution(message)).toEqual(expectedLabels);
    });

    it('reports both distinct markers when a message carries both', () => {
        expect(checker.findForbiddenAttribution(
            'Generated with Claude Code\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
        )).toEqual([
            'Anthropic no-reply identity',
            'Claude generated-by marker',
        ]);
    });

    it('labels every rule distinctly so no marker is reported twice', () => {
        const labels = checker.FORBIDDEN_ATTRIBUTION_RULES.map(({label}) => label);

        expect(new Set(labels).size).toBe(labels.length);
    });

    // The rules must name markers generated commits actually carry, not the word
    // "Claude": a contributor called Claude is a person, prose about the product
    // is ordinary documentation, and a trailer no tool emits would only produce
    // false positives.
    it.each([
        ['Co-Authored-By: Claude Dupont <claude.dupont@example.test>'],
        ['Co-Authored-By: Claude <claude.dupont@example.test>'],
        ['Co-Authored-By: Claudia Example <claudia@example.test>'],
        ['Document how Claude integrations are configured'],
        ['Add a Claude session viewer to the agent panel'],
        ['Note that this release was generated with the release script'],
    ])('allows %s', (message) => {
        expect(checker.findForbiddenAttribution(message)).toEqual([]);
    });

    it('validates commit message files before a commit is created', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const directory = await mkdtemp(join(tmpdir(), 'evb-attribution-message-'));
        try {
            const messageFile = join(directory, 'COMMIT_EDITMSG');
            await writeFile(messageFile, 'Generated with Claude Code\n');

            expect(runMain([
                '--message-file',
                messageFile,
            ])).toBe(1);
        } finally {
            await removeRepository(directory);
        }
    });

    it('checks every commit in a range, not only the tip', async () => {
        const repository = await createRepository('evb-attribution-repo-');
        try {
            const base = await commit(repository, 'Clean base');
            const prohibited = await commit(repository, 'Generated with Claude Code');
            const head = await commit(repository, 'Clean tip');

            const commits = checker.collectPushedRangeCommits(base, head, repository);

            expect(commits).toHaveLength(2);
            expect(checker.findCommitViolations(commits, repository)).toEqual([{
                matches: ['Claude generated-by marker'],
                subject: prohibited,
            }]);
        } finally {
            await removeRepository(repository);
        }
    });

    it('keeps primary and linked worktrees intact when creating VCS fixtures', async () => {
        const originalCwd = process.cwd();
        const originalTmpdir = process.env.TMPDIR;
        const fixtureDirectory = await mkdtemp(join(getAbsoluteOsTemporaryDirectory(), 'evb-attribution-worktrees-'));
        const primary = join(fixtureDirectory, 'primary');
        const linked = join(fixtureDirectory, 'linked');
        let primaryFixture: string | undefined;
        let linkedFixture: string | undefined;

        try {
            await mkdir(primary);
            runGit(fixtureDirectory, [
                'init',
                '--initial-branch=main',
                primary,
            ]);
            runGit(primary, [
                'config',
                'user.name',
                'Test User',
            ]);
            runGit(primary, [
                'config',
                'user.email',
                'test@example.test',
            ]);
            await writeFiles(primary, {'README.md': 'fixture host\n'});
            runGit(primary, [
                'add',
                '--all',
            ]);
            runGit(primary, [
                'commit',
                '--message',
                'Create fixture host',
            ]);
            runGit(primary, [
                'worktree',
                'add',
                linked,
                'HEAD',
            ]);

            const primaryState = repositoryState(primary);
            const linkedState = repositoryState(linked);
            process.env.TMPDIR = '.';

            process.chdir(primary);
            primaryFixture = await createRepository('evb-attribution-primary-');
            process.chdir(linked);
            linkedFixture = await createRepository('evb-attribution-linked-');

            expect(path.isAbsolute(primaryFixture)).toBe(true);
            expect(path.isAbsolute(linkedFixture)).toBe(true);
            expect(isWithinDirectory(primary, primaryFixture)).toBe(false);
            expect(isWithinDirectory(linked, linkedFixture)).toBe(false);
            expect(repositoryState(primary)).toEqual(primaryState);
            expect(repositoryState(linked)).toEqual(linkedState);

        } finally {
            if (originalTmpdir === undefined) {
                delete process.env.TMPDIR;
            } else {
                process.env.TMPDIR = originalTmpdir;
            }
            process.chdir(originalCwd);
            if (primaryFixture) {
                await removeRepository(primaryFixture);
            }
            if (linkedFixture) {
                await removeRepository(linkedFixture);
            }
            await removeTemporaryDirectory(fixtureDirectory);
        }
    });

    // Every check above is reachable only through a hook. A hook that lost its
    // invocation, or kept it in the wrong mode, disables the gate silently: the
    // commit or push simply succeeds. Assert the exact wiring per hook.
    it.each([
        [
            'pre-commit',
            '--staged',
        ],
        [
            'pre-push',
            '--pre-push',
        ],
        [
            'commit-msg',
            '--message-file',
        ],
    ])('wires the %s hook to the attribution check with %s', async (hook, mode) => {
        const script = await readFile(path.join(process.cwd(), '.husky', hook), 'utf8');
        const invocations = script
            .split(/\r?\n/u)
            .map(line => line.trim())
            .filter(line => line.includes('check-commit-attribution.mjs'));

        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toMatch(
            new RegExp(`^node scripts/check-commit-attribution\\.mjs ${mode}(\\s|$)`, 'u'),
        );
    });
});

describe('forbidden artifact detection in history', () => {
    it('detects a non-ASCII path that the default quoted output would hide', async () => {
        const repository = await createRepository('evb-artifact-unicode-');
        try {
            const introducing = await commit(repository, 'Add localized harness notes', {
                'docs/тест/AGENTS.md': '# local rules\n',
                'docs/тест/overview.md': '# overview\n',
            });

            // Reproduces the evasion: git quotes the path unless asked for NUL
            // separated output, so basename matching sees `AGENTS.md"`.
            expect(runGit(repository, [
                'show',
                '--name-only',
                '--format=',
                introducing,
            ])).toContain('\\321');

            expect(checker.findPushPolicyViolations([introducing], repository)).toEqual([{
                matches: ['agent instruction file AGENTS.md at docs/тест/AGENTS.md'],
                subject: introducing,
            }]);
        } finally {
            await removeRepository(repository);
        }
    });

    it('detects an artifact under a directory whose name contains a newline', async () => {
        const repository = await createRepository('evb-artifact-newline-');
        try {
            const introducing = await commit(repository, 'Add oddly named harness notes', {'notes\nlocal/CLAUDE.md': '# local rules\n'});

            expect(checker.findPushPolicyViolations([introducing], repository)).toEqual([{
                matches: ['agent instruction file CLAUDE.md at notes\nlocal/CLAUDE.md'],
                subject: introducing,
            }]);
        } finally {
            await removeRepository(repository);
        }
    });

    it('groups paths per commit even when a batch spans several commits', () => {
        const records = checker.parseDiffTreeRecords(
            [
                'aaaa',
                'app/one.ts',
                'bbbb',
                'AGENTS.md',
                'docs/two.md',
            ].join('\0'),
            [
                'aaaa',
                'bbbb',
            ],
        );

        expect(records).toEqual([
            {
                commit: 'aaaa',
                paths: ['app/one.ts'],
            },
            {
                commit: 'bbbb',
                paths: [
                    'AGENTS.md',
                    'docs/two.md',
                ],
            },
        ]);
    });

    it('flags the root commit of an orphan history', async () => {
        const repository = await createRepository('evb-artifact-root-');
        try {
            const root = await commit(repository, 'Initial harness setup', {'.claude/settings.json': '{}\n'});

            expect(violationSubjects(checker.findPushPolicyViolations([root], repository)))
                .toEqual([root]);
        } finally {
            await removeRepository(repository);
        }
    });

    it('flags an artifact introduced by the merge commit itself', async () => {
        const repository = await createRepository('evb-artifact-merge-');
        try {
            await commit(repository, 'Clean base', {'app/index.ts': 'export const app = true;\n'});
            runGit(repository, [
                'checkout',
                '-q',
                '-b',
                'side',
            ]);
            const side = await commit(repository, 'Clean side work', {'app/side.ts': 'export const side = 1;\n'});
            runGit(repository, [
                'checkout',
                '-q',
                'main',
            ]);
            runGit(repository, [
                'merge',
                '--no-ff',
                '--no-commit',
                side,
            ]);
            const merge = await commit(repository, 'Merge side work');
            await writeFiles(repository, {'AGENTS.md': '# local rules\n'});
            runGit(repository, [
                'add',
                '--all',
            ]);
            runGit(repository, [
                'commit',
                '--amend',
                '--no-edit',
            ]);
            const evilMerge = runGit(repository, [
                'rev-parse',
                'HEAD',
            ]);

            expect(merge).not.toBe(evilMerge);
            expect(checker.findPushPolicyViolations([
                side,
                evilMerge,
            ], repository)).toEqual([{
                matches: ['agent instruction file AGENTS.md at AGENTS.md'],
                subject: evilMerge,
            }]);
        } finally {
            await removeRepository(repository);
        }
    });

    it('allows a purge commit that only deletes the artifacts', async () => {
        const repository = await createRepository('evb-artifact-purge-');
        try {
            await commit(repository, 'Legacy history with harness notes', {
                'AGENTS.md': '# local rules\n',
                'app/index.ts': 'export const app = true;\n',
            });
            runGit(repository, [
                'rm',
                '--quiet',
                'AGENTS.md',
            ]);
            const purge = await commit(repository, 'Remove local harness notes');

            expect(checker.findPushPolicyViolations([purge], repository)).toEqual([]);
        } finally {
            await removeRepository(repository);
        }
    });

    it('rejects staged artifacts before the commit exists', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const repository = await createRepository('evb-artifact-staged-');
        try {
            await commit(repository, 'Clean base', {'app/index.ts': 'export const app = true;\n'});
            await writeFiles(repository, {
                'docs/agents-overview.md': '# Agents\n',
                'landing/CLAUDE.md': '# local rules\n',
            });
            runGit(repository, [
                'add',
                '--all',
            ]);

            expect(checker.findStagedArtifactViolations(repository))
                .toEqual(['agent instruction file CLAUDE.md at landing/CLAUDE.md']);
            expect(runMain(['--staged'], repository)).toBe(1);

            runGit(repository, [
                'restore',
                '--staged',
                'landing/CLAUDE.md',
            ]);
            expect(checker.findStagedArtifactViolations(repository)).toEqual([]);
            expect(runMain(['--staged'], repository)).toBeUndefined();
        } finally {
            await removeRepository(repository);
        }
    });

    // `.devkit/` is ignored working material, so entering the index at all takes a
    // forced add. The gate has to reject it deterministically anyway, and must not
    // catch similarly named product paths.
    it('rejects a forced add of local working material', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const repository = await createRepository('evb-artifact-devkit-');
        try {
            await commit(repository, 'Clean base', {'app/index.ts': 'export const app = true;\n'});
            await writeFiles(repository, {
                '.devkit/plans/ledger.md': '# ledger\n',
                'docs/devkit-notes.md': '# notes\n',
            });
            runGit(repository, [
                'add',
                '--force',
                '--all',
            ]);

            expect(checker.findStagedArtifactViolations(repository))
                .toEqual(['local working directory .devkit/ at .devkit/plans/ledger.md']);
            expect(runMain(['--staged'], repository)).toBe(1);
        } finally {
            await removeRepository(repository);
        }
    });

    // The first commit of a repository has no HEAD to diff against; `git diff
    // --cached` compares with the empty tree there, so the gate still applies.
    it('rejects staged artifacts in a repository with no commits yet', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const repository = await createRepository('evb-artifact-unborn-');
        try {
            await writeFiles(repository, {
                'AGENTS.md': '# local rules\n',
                'app/index.ts': 'export const app = true;\n',
            });
            runGit(repository, [
                'add',
                '--force',
                '--all',
            ]);

            expect(checker.findStagedArtifactViolations(repository))
                .toEqual(['agent instruction file AGENTS.md at AGENTS.md']);
            expect(runMain(['--staged'], repository)).toBe(1);
        } finally {
            await removeRepository(repository);
        }
    });
});

describe('pre-push publication scope', () => {
    async function createRemoteAndWorkspace() {
        const remote = await createRepository('evb-push-remote-', ['--bare']);
        const workspace = await createRepository('evb-push-work-');
        runGit(workspace, [
            'remote',
            'add',
            'origin',
            remote,
        ]);
        return {
            remote,
            workspace,
        };
    }

    it('scans history the remote no longer advertises, ignoring stale tracking refs', async () => {
        const {
            remote,
            workspace,
        } = await createRemoteAndWorkspace();
        try {
            const root = await commit(workspace, 'Legacy harness setup', {'.codex/config.toml': 'x = 1\n'});
            const tip = await commit(workspace, 'Legacy work', {'app/index.ts': 'export const app = true;\n'});
            runGit(workspace, [
                'push',
                '--quiet',
                'origin',
                'main:refs/heads/legacy',
            ]);
            runGit(workspace, [
                'fetch',
                '--quiet',
                'origin',
            ]);
            // Purge the branch on the remote without letting the client prune
            // its tracking ref, exactly as a force history rewrite leaves it.
            runGit(remote, [
                'update-ref',
                '-d',
                'refs/heads/legacy',
            ]);

            // The stale tracking ref still names the purged history.
            expect(runGit(workspace, [
                'rev-parse',
                'refs/remotes/origin/legacy',
            ])).toBe(tip);

            const work = checker.collectPrePushWork(
                updateLine('refs/heads/resurrected', tip),
                [remote],
                workspace,
            );

            expect(work.commits).toEqual([
                root,
                tip,
            ]);
            expect(checker.findPushPolicyViolations(work.commits, workspace, work)).toEqual([{
                matches: ['agent harness directory .codex/ at .codex/config.toml'],
                subject: root,
            }]);
        } finally {
            await removeRepository(remote);
            await removeRepository(workspace);
        }
    });

    it('skips commits the remote already advertises', async () => {
        const {
            remote,
            workspace,
        } = await createRemoteAndWorkspace();
        try {
            const base = await commit(workspace, 'Clean base', {'app/index.ts': 'export const app = true;\n'});
            runGit(workspace, [
                'push',
                '--quiet',
                'origin',
                'main',
            ]);
            const head = await commit(workspace, 'Clean follow-up', {'app/next.ts': 'export const next = 1;\n'});

            const work = checker.collectPrePushWork(
                updateLine('refs/heads/main', head, base),
                [remote],
                workspace,
            );

            expect(work.commits).toEqual([head]);
            expect(checker.findPushPolicyViolations(work.commits, workspace, work)).toEqual([]);
        } finally {
            await removeRepository(remote);
            await removeRepository(workspace);
        }
    });

    // `--not A --not B` toggles the sense of every later revision instead of
    // repeating the exclusion, so the second advertised head came back as a
    // positive tip and dragged its already-public history into the scan.
    it('excludes every advertised head when the remote advertises disjoint histories', async () => {
        const {
            remote,
            workspace,
        } = await createRemoteAndWorkspace();
        try {
            await commit(workspace, 'Clean base', {'app/index.ts': 'export const app = true;\n'});
            runGit(workspace, [
                'checkout',
                '-q',
                '--orphan',
                'detached-history',
            ]);
            runGit(workspace, [
                'rm',
                '-rq',
                '--cached',
                '.',
            ]);
            // Published on an unrelated root, so it shares no ancestry with the
            // branch being pushed and can only be excluded by name.
            const publicOrphan = await commit(workspace, 'Published orphan work', {'app/orphan.ts': 'export const orphan = 1;\n'});
            runGit(workspace, [
                'push',
                '--quiet',
                'origin',
                'main',
                'detached-history',
            ]);
            runGit(workspace, [
                'checkout',
                '-q',
                'main',
            ]);
            const head = await commit(workspace, 'Clean follow-up', {'app/next.ts': 'export const next = 1;\n'});

            const advertised = checker.collectPrePushWork(
                updateLine('refs/heads/feature', head),
                [remote],
                workspace,
            );

            expect(advertised.commits).toEqual([head]);
            expect(advertised.commits).not.toContain(publicOrphan);
        } finally {
            await removeRepository(remote);
            await removeRepository(workspace);
        }
    });

    it('fails closed when the remote advertisement cannot be read', async () => {
        const workspace = await createRepository('evb-push-noremote-');
        try {
            const head = await commit(workspace, 'Clean base');

            expect(() => checker.collectPrePushWork(
                updateLine('refs/heads/main', head),
                [join(workspace, 'missing-remote.git')],
                workspace,
            )).toThrow(/remote ref advertisement/u);
        } finally {
            await removeRepository(workspace);
        }
    });

    it('rejects destinations outside refs/heads and refs/tags', async () => {
        const {
            remote,
            workspace,
        } = await createRemoteAndWorkspace();
        try {
            const head = await commit(workspace, 'Clean base');

            const work = checker.collectPrePushWork(
                updateLine('refs/notes/commits', head),
                [remote],
                workspace,
            );

            expect(work.commits).toEqual([]);
            expect(checker.findPushPolicyViolations(work.commits, workspace, work)).toEqual([{
                matches: ['destination outside refs/heads/* and refs/tags/*'],
                subject: 'refs/notes/commits',
            }]);
        } finally {
            await removeRepository(remote);
            await removeRepository(workspace);
        }
    });

    it('allows deleting a ref without consulting the remote', async () => {
        const workspace = await createRepository('evb-push-delete-');
        try {
            const head = await commit(workspace, 'Clean base');

            const work = checker.collectPrePushWork(
                `(delete) ${ZERO_OID} refs/heads/gone ${head}\n`,
                [join(workspace, 'missing-remote.git')],
                workspace,
            );

            expect(work).toEqual({
                commits: [],
                nestedTagRefs: [],
                rejectedRefs: [],
                tagObjects: [],
            });
            expect(checker.findPushPolicyViolations(work.commits, workspace, work)).toEqual([]);
        } finally {
            await removeRepository(workspace);
        }
    });

    // A tag of a tag is legal in Git but this project never publishes one, and
    // the inner objects would go unscanned. Reject it rather than walking a
    // chain that only an evasion would produce.
    it('rejects a tag that points at another tag instead of scanning past it', async () => {
        const {
            remote,
            workspace,
        } = await createRemoteAndWorkspace();
        try {
            await commit(workspace, 'Clean base');
            runGit(workspace, [
                'push',
                '--quiet',
                'origin',
                'main',
            ]);
            runGit(workspace, [
                'tag',
                '--annotate',
                'inner',
                '-m',
                'Inner tag\n\nGenerated with Claude Code',
            ]);
            runGit(workspace, [
                'tag',
                '--annotate',
                'outer',
                'inner',
                '-m',
                'Outer tag',
            ]);
            const outerOid = runGit(workspace, [
                'rev-parse',
                'refs/tags/outer',
            ]);

            const work = checker.collectPrePushWork(
                updateLine('refs/tags/outer', outerOid),
                [remote],
                workspace,
            );

            expect(work.nestedTagRefs).toEqual(['refs/tags/outer']);
            expect(checker.findPushPolicyViolations(work.commits, workspace, work)).toEqual([{
                matches: ['tag object points at another tag; this project publishes tags of commits only'],
                subject: 'refs/tags/outer',
            }]);
        } finally {
            await removeRepository(remote);
            await removeRepository(workspace);
        }
    });

    it('publishes no tag object text for a lightweight tag', async () => {
        const {
            remote,
            workspace,
        } = await createRemoteAndWorkspace();
        try {
            const head = await commit(workspace, 'Clean base');
            runGit(workspace, [
                'push',
                '--quiet',
                'origin',
                'main',
            ]);
            runGit(workspace, [
                'tag',
                'v1.0.0',
            ]);

            const work = checker.collectPrePushWork(
                updateLine('refs/tags/v1.0.0', head),
                [remote],
                workspace,
            );

            expect(work.tagObjects).toEqual([]);
            expect(work.nestedTagRefs).toEqual([]);
            expect(checker.findPushPolicyViolations(work.commits, workspace, work)).toEqual([]);
        } finally {
            await removeRepository(remote);
            await removeRepository(workspace);
        }
    });

    it('scans an updated annotated tag and the commits it newly publishes', async () => {
        const {
            remote,
            workspace,
        } = await createRemoteAndWorkspace();
        try {
            await commit(workspace, 'Clean base');
            runGit(workspace, [
                'tag',
                '--annotate',
                'v1.0.0',
                '-m',
                'Release 1.0.0',
            ]);
            runGit(workspace, [
                'push',
                '--quiet',
                'origin',
                'main',
                'refs/tags/v1.0.0',
            ]);
            const publishedTagOid = runGit(workspace, [
                'rev-parse',
                'refs/tags/v1.0.0',
            ]);
            const retagged = await commit(workspace, 'Add harness notes', {'AGENTS.md': '# local rules\n'});
            runGit(workspace, [
                'tag',
                '--annotate',
                '--force',
                'v1.0.0',
                '-m',
                'Release 1.0.0\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
            ]);
            const movedTagOid = runGit(workspace, [
                'rev-parse',
                'refs/tags/v1.0.0',
            ]);

            const work = checker.collectPrePushWork(
                updateLine('refs/tags/v1.0.0', movedTagOid, publishedTagOid),
                [remote],
                workspace,
            );

            expect(work.commits).toEqual([retagged]);
            expect(checker.findPushPolicyViolations(work.commits, workspace, work)).toEqual([
                {
                    matches: ['agent instruction file AGENTS.md at AGENTS.md'],
                    subject: retagged,
                },
                {
                    matches: ['Anthropic no-reply identity'],
                    subject: `refs/tags/v1.0.0 (tag object ${movedTagOid})`,
                },
            ]);
        } finally {
            await removeRepository(remote);
            await removeRepository(workspace);
        }
    });
});

describe('pushed range resolution for CI', () => {
    it.each([
        [
            'an unreachable before SHA left by a force history rewrite',
            UNREACHABLE_OID,
        ],
        [
            'a zero before SHA',
            ZERO_OID,
        ],
        [
            'an empty before SHA',
            '',
        ],
    ])('falls back to the complete head history for %s', async (_label, beforeOid) => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const repository = await createRepository('evb-pushed-range-rewrite-');
        try {
            const root = await commit(repository, 'Rewritten root', {'AGENTS.md': '# local rules\n'});
            const head = await commit(repository, 'Rewritten tip', {'app/index.ts': 'export const app = true;\n'});

            expect(checker.collectPushedRangeCommits(beforeOid, head, repository)).toEqual([
                root,
                head,
            ]);
            expect(runMain([
                '--pushed-range',
                beforeOid,
                head,
            ], repository)).toBe(1);
        } finally {
            await removeRepository(repository);
        }
    });

    it('falls back to the complete head history when the before SHA is an unrelated root', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const repository = await createRepository('evb-pushed-range-unrelated-');
        try {
            await commit(repository, 'Old root', {'app/old.ts': 'export const old = true;\n'});
            const unrelated = runGit(repository, [
                'rev-parse',
                'HEAD',
            ]);
            runGit(repository, [
                'checkout',
                '-q',
                '--orphan',
                'rewritten',
            ]);
            runGit(repository, [
                'rm',
                '-rq',
                '--cached',
                '.',
            ]);
            const root = await commit(repository, 'Rewritten root', {'.claude/settings.json': '{}\n'});
            const head = await commit(repository, 'Rewritten tip', {'app/index.ts': 'export const app = true;\n'});

            expect(checker.collectPushedRangeCommits(unrelated, head, repository)).toEqual([
                root,
                head,
            ]);
            expect(runMain([
                '--pushed-range',
                unrelated,
                head,
            ], repository)).toBe(1);
        } finally {
            await removeRepository(repository);
        }
    });

    // The state a purged branch is in: the before SHA is unreachable, so the whole
    // reachable history is scanned, and it passes because no commit in it adds a
    // local-only artifact. That is why the wide fallback is a usable safeguard
    // rather than a permanent failure.
    it('passes a full-history fallback scan whose whole history is clean', async () => {
        const repository = await createRepository('evb-pushed-range-clean-');
        try {
            await commit(repository, 'Clean root', {'app/index.ts': 'export const app = true;\n'});
            const head = await commit(repository, 'Extend the agent feature', {
                'docs/agents-overview.md': '# Agents\n',
                'electron/features/agent/agentSession.ts': 'export const session = 1;\n',
            });

            expect(runMain([
                '--pushed-range',
                UNREACHABLE_OID,
                head,
            ], repository)).toBeUndefined();
        } finally {
            await removeRepository(repository);
        }
    });
});
