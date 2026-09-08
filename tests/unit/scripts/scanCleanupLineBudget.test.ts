import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {
    execFileSync,
    spawnSync,
} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

interface ILineBudgetModule {
    collectScanCleanupLineCounts: (root: string) => {
        homes: Record<string, {
            byFile: Record<string, number>;
            total: number
        }>;
        productionTotal: number;
        tests: {
            byFile: Record<string, number>;
            total: number
        };
    };
    countCodeLines: (source: string) => number;
    splitRustTestCodeLines: (source: string) => {
        productionLines: number[];
        testCodeLines: number[]
    };
    parseNulDelimitedGitPaths: (output: Uint8Array) => string[];
    classifyBaselineTreeEntry: (output: Uint8Array) => 'absent' | 'present';
    isExplicitNonRepositoryResult: (result: {
        status: number | null;
        stdout: string;
        stderr: string
    }) => boolean;
    validateScanCleanupBaseline: (value: unknown, label?: string) => unknown;
    compareScanCleanupBaselines: (current: {
        homes: Record<string, {
            lines: number;
            path: string
        }>;
        productionTotal: number;
    }, previous: {
        homes: Record<string, {
            lines: number;
            path: string
        }>;
        productionTotal: number;
    } | null, options?: {
            allowHomeIncrease?: boolean;
            baseCommit?: string
        }) => {
        bootstrap: boolean;
        failures: string[]
        homeIncreased?: boolean
    };
    evaluateScanCleanupLineBudget: (counts: {
        homes: Record<string, {total: number}>;
        productionTotal: number;
    }, baseline: {
            homes: Record<string, {lines: number}>;
            productionTotal: number;
        }, options?: {allowBaselineIncrease?: boolean}) => {
        failures: string[];
        passed: boolean
    };
}

const module = await import(pathToFileURL(join(process.cwd(), 'scripts/scan-cleanup-line-budget.mjs')).href) as ILineBudgetModule;
const temporaryDirectories: string[] = [];
const symlinkCapability = await (async () => {
    const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-symlink-probe-'));
    try {
        await symlink(join(root, 'missing-target'), join(root, 'probe.ts'));
        return true;
    } catch (error) {
        const code = (error as {code?: string}).code;
        if (code === 'EACCES' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM') {
            return false;
        }
        throw error;
    } finally {
        await rm(root, {
            force: true,
            recursive: true,
        });
    }
})();
const homePaths = {
    app: 'app/modules/scan-cleanup',
    electron: 'electron/features/scan-cleanup',
    contracts: 'packages/contracts/scan-cleanup',
    core: 'scan-cleanup-core',
    adapters: 'scan-cleanup-adapters',
    native: 'native/scan-cleanup',
};

function baseline(lines: Partial<Record<keyof typeof homePaths, number>> = {}, productionTotal = 20) {
    return {
        version: 1,
        productionTotal,
        homes: Object.fromEntries(Object.entries(homePaths).map(([
            name,
            path,
        ]) => [
            name,
            {
                lines: lines[name as keyof typeof homePaths] ?? 0,
                path,
            },
        ])),
    };
}

function baselineIdentity(value: ReturnType<typeof baseline>) {
    return createHash('sha256').update(JSON.stringify({
        version: value.version,
        productionTotal: value.productionTotal,
        homes: value.homes,
    })).digest('hex');
}

function approvedBaseline(current: ReturnType<typeof baseline>, previous: ReturnType<typeof baseline>, baseCommit = '0123456789012345678901234567890123456789') {
    return {
        ...current,
        consolidationApproval: {
            version: 1 as const,
            reason: 'consolidation: rebalance test homes',
            baseCommit,
            previousIdentity: baselineIdentity(previous),
            currentIdentity: baselineIdentity(current),
        },
    };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        force: true,
        maxRetries: 3,
        retryDelay: 10,
        recursive: true,
    })));
});

describe('scan-cleanup line budget', () => {
    it('counts code while excluding blanks and comments, including inline comments', () => {
        expect(module.countCodeLines('// comment\n\nconst url = "https://example.test"; // code\n/* block\ncomment */\n<!-- Vue comment -->\nconst value = 1;')).toBe(2);
    });

    it('uses the six named homes and separates matching tests', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-lines-'));
        temporaryDirectories.push(root);
        await Promise.all([
            mkdir(join(root, 'app/modules/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'electron/features/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'packages/contracts/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-core'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-adapters'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/src'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/tests'), {recursive: true}),
            mkdir(join(root, 'app/modules/scan-cleanup/.nuxt'), {recursive: true}),
            mkdir(join(root, 'tests/unit/scan-cleanup'), {recursive: true}),
        ]);
        const generatedLines = Array.from({length: 66}, (_, index) => `declare const generated${index}: string;`).join('\n');
        await Promise.all([
            writeFile(join(root, 'app/modules/scan-cleanup/app.ts'), '// eslint-disable-next-line max-lines\nconst app = 1;\n'),
            writeFile(join(root, 'electron/features/scan-cleanup/electron.vue'), '<template>ok</template>\n'),
            writeFile(join(root, 'packages/contracts/scan-cleanup/contract.ts'), '// only comment\n'),
            writeFile(join(root, 'scan-cleanup-core/core.ts'), 'const core = 1;\n'),
            writeFile(join(root, 'scan-cleanup-adapters/adapter.ts'), 'const adapter = 1;\n'),
            writeFile(join(root, 'native/scan-cleanup/src/lib.rs'), 'fn main() {}\n'),
            writeFile(join(root, 'native/scan-cleanup/src/example_tests.rs'), '#[test]\nfn separate() {}\n'),
            writeFile(join(root, 'native/scan-cleanup/tests/lib.rs'), 'fn test() {}\n'),
            writeFile(join(root, 'native/scan-cleanup/auto-imports.d.ts'), generatedLines),
            writeFile(join(root, 'native/scan-cleanup/tests/generated.d.ts'), generatedLines),
            writeFile(join(root, 'app/modules/scan-cleanup/generated.d.ts'), generatedLines),
            writeFile(join(root, 'app/modules/scan-cleanup/.nuxt/generated.ts'), generatedLines),
            writeFile(join(root, 'tests/unit/scan-cleanup/example.test.ts'), 'it("works", () => {});\n'),
            writeFile(join(root, 'scan-cleanup-core/ignored.js'), 'const ignored = 1;\n'),
        ]);
        const counts = module.collectScanCleanupLineCounts(root);
        expect(Object.keys(counts.homes)).toEqual([
            'app',
            'electron',
            'contracts',
            'core',
            'adapters',
            'native',
        ]);
        expect(counts.productionTotal).toBe(5);
        expect(counts.tests.total).toBe(4);
        expect(Object.keys(counts.tests.byFile)).toHaveLength(3);
    });

    it('uses Git-tracked sources and excludes ignored artifacts', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-git-lines-'));
        temporaryDirectories.push(root);
        await Promise.all([
            mkdir(join(root, 'app/modules/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'electron/features/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'packages/contracts/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-core'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-adapters'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/src'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/tests'), {recursive: true}),
            writeFile(join(root, '.gitignore'), '**/generated.d.ts\n**/generated.vue\n**/generated.rs\n**/auto-imports.d.ts\n'),
        ]);
        await Promise.all([
            writeFile(join(root, 'app/modules/scan-cleanup/suppressed.ts'), '// eslint-disable max-lines\nconst suppressed = 1;\n'),
            writeFile(join(root, 'app/modules/scan-cleanup/tracked.ts'), 'const tracked = 1;\n'),
            writeFile(join(root, 'electron/features/scan-cleanup/generated.vue'), '<template>ignored</template>\n'.repeat(30)),
            writeFile(join(root, 'app/modules/scan-cleanup/generated.d.ts'), 'declare const ignored: string;\n'.repeat(30)),
            writeFile(join(root, 'native/scan-cleanup/src/generated.rs'), 'fn ignored() {}\n'.repeat(30)),
            writeFile(join(root, 'native/scan-cleanup/auto-imports.d.ts'), 'declare const ignored: string;\n'.repeat(66)),
            writeFile(join(root, 'native/scan-cleanup/src/lib.rs'), 'fn tracked() {}\n'),
            writeFile(join(root, 'native/scan-cleanup/tests/lib.rs'), 'fn test() {}\n'),
        ]);
        execFileSync('git', [
            'init',
            '-q',
        ], {cwd: root});
        execFileSync('git', [
            'add',
            '--all',
        ], {cwd: root});
        const counts = module.collectScanCleanupLineCounts(root);
        expect(counts.productionTotal).toBe(3);
        expect(counts.tests.total).toBe(1);
        expect(Object.keys(counts.homes.app!.byFile)).toContain('app/modules/scan-cleanup/tracked.ts');

    });

    it('parses Git NUL output without treating tabs or newlines as delimiters', () => {
        const output = Buffer.from('app/modules/scan-cleanup/tab\tname.ts\0app/modules/scan-cleanup/line\nname.rs\0quoted"name.vue\0');
        expect(module.parseNulDelimitedGitPaths(output)).toEqual([
            'app/modules/scan-cleanup/tab\tname.ts',
            'app/modules/scan-cleanup/line\nname.rs',
            'quoted"name.vue',
        ]);
        expect(() => module.parseNulDelimitedGitPaths(Buffer.from('unfinished.ts'))).toThrow('unterminated NUL record');
    });

    it('bootstraps only when the exact baseline tree entry is absent', () => {
        expect(module.classifyBaselineTreeEntry(Buffer.from(''))).toBe('absent');
        expect(module.classifyBaselineTreeEntry(Buffer.from('scan-cleanup-line-budget-baseline.json\0'))).toBe('present');
        expect(() => module.classifyBaselineTreeEntry(Buffer.from('other.json\0'))).toThrow('unexpected path');
    });

    it('accepts fallback only for the exact expected non-repository result', () => {
        const stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
        expect(module.isExplicitNonRepositoryResult({
            status: 128,
            stdout: '',
            stderr,
        })).toBe(true);
        expect(module.isExplicitNonRepositoryResult({
            status: 127,
            stdout: '',
            stderr,
        })).toBe(false);
        expect(module.isExplicitNonRepositoryResult({
            status: 128,
            stdout: '',
            stderr: `wrapper: ${stderr}`,
        })).toBe(false);
        expect(module.isExplicitNonRepositoryResult({
            status: 128,
            stdout: 'false\n',
            stderr,
        })).toBe(false);
    });

    it('fails closed when a confirmed Git worktree cannot enumerate its index', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-git-index-'));
        temporaryDirectories.push(root);
        await mkdir(join(root, 'app/modules/scan-cleanup'), {recursive: true});
        execFileSync('git', [
            'init',
            '-q',
        ], {cwd: root});
        await writeFile(join(root, '.git/index'), 'corrupt index');
        expect(() => module.collectScanCleanupLineCounts(root)).toThrow('Cannot enumerate tracked scan-cleanup sources');
    });

    it('fails closed when Git metadata markers are broken instead of falling back', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-git-head-'));
        temporaryDirectories.push(root);
        await Promise.all([
            mkdir(join(root, 'app/modules/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup'), {recursive: true}),
        ]);
        await writeFile(join(root, 'native/scan-cleanup/ignored.rs'), 'fn ignored() {}\n');
        execFileSync('git', [
            'init',
            '-q',
        ], {cwd: root});
        await rm(join(root, '.git/HEAD'));
        expect(() => module.collectScanCleanupLineCounts(root)).toThrow('Git metadata marker exists');

        const malformedFileRoot = await mkdtemp(join(tmpdir(), 'scan-cleanup-git-file-'));
        temporaryDirectories.push(malformedFileRoot);
        await mkdir(join(malformedFileRoot, 'app/modules/scan-cleanup'), {recursive: true});
        await writeFile(join(malformedFileRoot, '.git'), 'not a gitdir marker\n');
        expect(() => module.collectScanCleanupLineCounts(malformedFileRoot)).toThrow('Cannot determine whether scan-cleanup root is a Git worktree');

        const linkedWorktreeRoot = await mkdtemp(join(tmpdir(), 'scan-cleanup-git-linked-file-'));
        temporaryDirectories.push(linkedWorktreeRoot);
        await mkdir(join(linkedWorktreeRoot, 'app/modules/scan-cleanup'), {recursive: true});
        await writeFile(join(linkedWorktreeRoot, '.git'), 'gitdir: /missing/worktree/metadata\n');
        expect(() => module.collectScanCleanupLineCounts(linkedWorktreeRoot)).toThrow('Cannot determine whether scan-cleanup root is a Git worktree');
    });

    it('fails closed when a tracked source disappears after Git enumeration', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-git-missing-'));
        temporaryDirectories.push(root);
        const source = join(root, 'app/modules/scan-cleanup/missing.ts');
        await mkdir(join(root, 'app/modules/scan-cleanup'), {recursive: true});
        await writeFile(source, 'const missing = 1;\n');
        execFileSync('git', [
            'init',
            '-q',
        ], {cwd: root});
        execFileSync('git', [
            'add',
            '--all',
        ], {cwd: root});
        await rm(source);
        expect(() => module.collectScanCleanupLineCounts(root)).toThrow('source disappeared');
    });

    it.runIf(symlinkCapability)('rejects a dangling tracked source symlink', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-git-symlink-'));
        temporaryDirectories.push(root);
        await Promise.all([
            mkdir(join(root, 'app/modules/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'electron/features/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'packages/contracts/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-core'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-adapters'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/src'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/tests'), {recursive: true}),
        ]);
        await symlink(join(root, 'outside-does-not-exist.ts'), join(root, 'native/scan-cleanup/src/escape.ts'));
        execFileSync('git', [
            'init',
            '-q',
        ], {cwd: root});
        execFileSync('git', [
            'add',
            '--all',
        ], {cwd: root});
        expect(() => module.collectScanCleanupLineCounts(root)).toThrow('tracked source symlink');
    });

    it.runIf(symlinkCapability)('rejects a tracked source symlink escaping the repository', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-git-external-symlink-'));
        const outside = await mkdtemp(join(tmpdir(), 'scan-cleanup-outside-'));
        temporaryDirectories.push(root, outside);
        await Promise.all([
            mkdir(join(root, 'app/modules/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'electron/features/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'packages/contracts/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-core'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-adapters'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/src'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/tests'), {recursive: true}),
            writeFile(join(outside, 'escape.ts'), 'const outside = 1;\n'),
        ]);
        await symlink(join(outside, 'escape.ts'), join(root, 'native/scan-cleanup/src/escape.ts'));
        execFileSync('git', [
            'init',
            '-q',
        ], {cwd: root});
        execFileSync('git', [
            'add',
            '--all',
        ], {cwd: root});
        expect(() => module.collectScanCleanupLineCounts(root)).toThrow('tracked source symlink');
    });

    it('splits an inline Rust cfg test item with nested syntax from production', () => {
        const source = [
            'fn production() { let brace = "}"; }',
            '#[derive(Debug)]',
            '#[cfg(test)]',
            'mod tests {',
            '    /* outer /* nested */ comment */',
            '    fn nested() {',
            '        let raw = r#"{ // braces are data }"#;',
            '        let rawWithoutHashes = r"}";',
            '        let character = \'}\';',
            '    }',
            '}',
            'fn after() {}',
        ].join('\n');
        const split = module.splitRustTestCodeLines(source);
        expect(split.productionLines).toEqual([
            0,
            1,
            11,
        ]);
        expect(split.testCodeLines).toEqual([
            2,
            3,
            5,
            6,
            7,
            8,
            9,
            10,
        ]);
    });

    it('counts Rust code lines without comment-only lines and preserves literals', () => {
        const source = [
            'fn f<\'a>() {',
            '    // comment-only production line',
            '    let x = 1; /* trailing comment */',
            '    /* outer /* nested */ comment-only */',
            '    let character = \'{\';',
            '    let normal = "// not a comment { }";',
            '    let raw = br#"/* not a comment { } */"#;',
            '}',
            '#[cfg(test)] mod tests {',
            '    // comment-only test line',
            '    let test_value = 2; // trailing comment',
            '}',
        ].join('\n');
        const split = module.splitRustTestCodeLines(source);
        expect(split.productionLines).toEqual([
            0,
            2,
            4,
            5,
            6,
            7,
        ]);
        expect(split.testCodeLines).toEqual([
            8,
            10,
            11,
        ]);
    });

    it('ends cfg(test) semicolon items without capturing following production code', () => {
        const source = [
            '#[cfg(test)]',
            'use foo::{bar, baz};',
            '#[cfg(test)]',
            'const TEST_VALUE: &str = "}";',
            '#[cfg(test)]',
            'static TEST_STATIC: &[u8] = b"{";',
            'fn production() {}',
        ].join('\n');
        const split = module.splitRustTestCodeLines(source);
        expect(split.testCodeLines).toEqual([
            0,
            1,
            2,
            3,
            4,
            5,
        ]);
        expect(split.productionLines).toEqual([6]);
    });

    it('separates render production imports from its test-only re-export', async () => {
        const source = await readFile(join(process.cwd(), 'native/scan-cleanup/src/engine/render.rs'), 'utf8');
        const split = module.splitRustTestCodeLines(source);
        const lines = source.split('\n');
        for (const statement of [
            'pub use crate::domain::geometry::{AppliedMargins, PageHalf};',
            'use crate::engine::prepare::{build_analysis_level, AnalysisLevel};',
        ]) {
            const index = lines.indexOf(statement);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(split.productionLines).toContain(index);
            expect(split.testCodeLines).not.toContain(index);
        }
        const testImport = lines.indexOf('pub(crate) use render_tests::analyze_page_with_document_prior_cached;');
        expect(testImport).toBeGreaterThan(0);
        expect(lines[testImport - 1]).toBe('#[cfg(test)]');
        expect(split.testCodeLines).toContain(testImport - 1);
        expect(split.testCodeLines).toContain(testImport);
        expect(split.productionLines).not.toContain(testImport);
    });

    it('validates the complete baseline shape before comparison', () => {
        expect(() => module.validateScanCleanupBaseline(baseline())).not.toThrow();
        const missingHome = baseline();
        delete missingHome.homes.native;
        expect(() => module.validateScanCleanupBaseline(missingHome)).toThrow('exactly the six named');
        const missingTotal = baseline() as {productionTotal?: number};
        delete missingTotal.productionTotal;
        expect(() => module.validateScanCleanupBaseline(missingTotal)).toThrow('productionTotal');
        expect(() => module.validateScanCleanupBaseline(baseline({app: -1}))).toThrow('nonnegative');
        expect(() => module.validateScanCleanupBaseline({
            ...baseline(),
            version: 2,
        })).toThrow('unsupported');
        const wrongPath = baseline();
        wrongPath.homes.app!.path = 'wrong/home';
        expect(() => module.validateScanCleanupBaseline(wrongPath)).toThrow('unexpected path');
    });

    it('rejects raised home and total baselines, allows only an offsetting consolidation, and bootstraps', () => {
        const previous = baseline({
            app: 10,
            native: 10,
        });
        expect(module.compareScanCleanupBaselines({
            ...baseline({
                app: 11,
                native: 9,
            }),
            productionTotal: 20,
        }, previous).failures.join(' ')).toContain('app baseline increased by 1');
        expect(module.compareScanCleanupBaselines({
            ...baseline({
                app: 11,
                native: 9,
            }),
            productionTotal: 20,
        }, previous, {allowHomeIncrease: true}).failures).toEqual([]);
        expect(module.compareScanCleanupBaselines({
            ...baseline({
                app: 11,
                native: 10,
            }, 21),
            productionTotal: 21,
        }, previous, {allowHomeIncrease: true}).failures.join(' ')).toContain('production total baseline increased');
        expect(module.compareScanCleanupBaselines({
            ...baseline({app: 10}),
            productionTotal: 10,
        }, null)).toEqual({
            bootstrap: true,
            failures: [],
        });
    });

    it('accepts only the exact persisted consolidation transition in CI mode', () => {
        const previous = baseline({
            app: 10,
            native: 10,
        });
        const current = baseline({
            app: 11,
            native: 9,
        });
        const approved = approvedBaseline(current, previous);
        expect(module.compareScanCleanupBaselines(approved, approved, {baseCommit: 'fedcba98765432100123456789abcdef01234567'}).failures).toEqual([]);
        expect(module.compareScanCleanupBaselines(approved, previous, {baseCommit: approved.consolidationApproval.baseCommit}).failures).toEqual([]);
        expect(module.compareScanCleanupBaselines({
            ...approved,
            homes: {
                ...approved.homes,
                app: {
                    lines: 12,
                    path: homePaths.app,
                },
            },
        }, previous, {baseCommit: approved.consolidationApproval.baseCommit}).failures.join(' ')).toContain('current baseline');
        expect(module.compareScanCleanupBaselines(approved, {
            ...previous,
            homes: {
                ...previous.homes,
                native: {
                    lines: 11,
                    path: homePaths.native,
                },
            },
        }, {baseCommit: approved.consolidationApproval.baseCommit}).failures.join(' ')).toContain('base baseline');
        expect(module.compareScanCleanupBaselines(current, previous).failures.join(' ')).toContain('app baseline increased');
        expect(module.compareScanCleanupBaselines({
            ...approved,
            productionTotal: 21,
        }, previous, {baseCommit: approved.consolidationApproval.baseCommit}).failures.join(' ')).toContain('production total baseline increased');
        expect(module.compareScanCleanupBaselines(approved, previous, {baseCommit: 'fedcba98765432100123456789abcdef01234567'}).failures.join(' ')).toContain('supplied base ref');
    });

    it('reports the growing home and rejects production growth without an override', () => {
        const result = module.evaluateScanCleanupLineBudget({
            homes: {app: {total: 12}},
            productionTotal: 12,
        }, {
            homes: {app: {lines: 10}},
            productionTotal: 10,
        });
        expect(result.passed).toBe(false);
        expect(result.failures.join(' ')).toContain('app grew by 2');
    });

    it('allows a controlled increase only when the caller explicitly enables it', () => {
        const counts = {
            homes: {app: {total: 12}},
            productionTotal: 12,
        };
        const baseline = {
            homes: {app: {lines: 10}},
            productionTotal: 10,
        };
        expect(module.evaluateScanCleanupLineBudget(counts, baseline).passed).toBe(false);
        expect(module.evaluateScanCleanupLineBudget({
            homes: {
                app: {total: 12},
                native: {total: 8},
            },
            productionTotal: 20,
        }, {
            homes: {
                app: {lines: 10},
                native: {lines: 10},
            },
            productionTotal: 20,
        }, {allowBaselineIncrease: true}).passed).toBe(true);
        expect(module.evaluateScanCleanupLineBudget(counts, baseline, {allowBaselineIncrease: true}).passed).toBe(false);
    });

    it('does not hide a per-home increase behind an offsetting decrease elsewhere', () => {
        const result = module.evaluateScanCleanupLineBudget({
            homes: {
                app: {total: 12},
                native: {total: 8},
            },
            productionTotal: 20,
        }, {
            homes: {
                app: {lines: 10},
                native: {lines: 10},
            },
            productionTotal: 20,
        });
        expect(result.passed).toBe(false);
        expect(result.failures.join(' ')).toContain('app grew by 2');
    });

    it('runs the single command and rejects an override without baseline update', () => {
        const result = spawnSync(process.execPath, [
            'scripts/validation-gates.mjs',
            'scan-cleanup-lines',
            '--allow-baseline-increase=consolidation:test',
        ], {encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain('only valid with --update-baseline');
    });

    it('fails closed for an unavailable explicit base ref and accepts bootstrap only within budget', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-bootstrap-'));
        temporaryDirectories.push(root);
        await mkdir(join(root, homePaths.app), {recursive: true});
        const hooksPath = join(root, 'empty-hooks');
        await mkdir(hooksPath);
        const sourcePath = join(root, homePaths.app, 'app.ts');
        await writeFile(sourcePath, 'const app = 1;\n');
        execFileSync('git', [
            'init',
            '-q',
        ], {cwd: root});
        execFileSync('git', [
            'add',
            '--all',
        ], {cwd: root});
        execFileSync('git', [
            '-c',
            'user.name=Line budget test',
            '-c',
            'user.email=line-budget@example.test',
            '-c',
            'commit.gpgsign=false',
            '-c',
            `core.hooksPath=${hooksPath}`,
            'commit',
            '-qm',
            'Create source fixture without a baseline',
        ], {cwd: root});
        await writeFile(join(root, 'scan-cleanup-line-budget-baseline.json'), JSON.stringify(baseline({app: 1}, 1)));
        const command = join(process.cwd(), 'scripts/validation-gates.mjs');
        const invalid = spawnSync(process.execPath, [
            command,
            'scan-cleanup-lines',
            '--base-ref=not-a-real-commit',
        ], {
            cwd: root,
            encoding: 'utf8',
        });
        expect(invalid.status).toBe(1);
        expect(`${invalid.stdout}${invalid.stderr}`).toContain('Cannot verify scan-cleanup baseline base ref');
        const bootstrap = spawnSync(process.execPath, [
            command,
            'scan-cleanup-lines',
            '--base-ref=HEAD',
        ], {
            cwd: root,
            encoding: 'utf8',
        });
        expect(bootstrap.status, `${bootstrap.stdout}${bootstrap.stderr}`).toBe(0);
        expect(bootstrap.stdout).toContain('bootstrap, no baseline at ref');
        await writeFile(sourcePath, 'const app = 1;\nconst growth = 2;\n');
        const overBudget = spawnSync(process.execPath, [
            command,
            'scan-cleanup-lines',
            '--base-ref=HEAD',
        ], {
            cwd: root,
            encoding: 'utf8',
        });
        expect(overBudget.status).toBe(1);
        expect(overBudget.stdout).toContain('bootstrap, no baseline at ref');
        expect(overBudget.stderr).toContain('Scan-cleanup line budget exceeded');
        expect(overBudget.stderr).toContain('production total grew by 1 code lines');
    });
});
