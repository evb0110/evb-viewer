import {constants} from 'node:fs';
import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyExactPdfFixture,
    EXACT_PDF_FIXTURE_MANIFEST,
    resolveExactPdfFixtureExpectation,
    validateExactPdfFixtureIdentity,
} from '@scripts/ci/stageExactPdfFixture';
import {
    assertQuarantinePolicy,
    assertQuarantineReport,
} from '@scripts/ci/runElectronQuarantine';

describe('issue 136 CI coverage contracts', () => {
    it('falls back to a bounded stream when Linux clone staging is unsupported', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-issue-136-clone-'));
        const source = join(root, 'source.pdf');
        const target = join(root, 'target.pdf');
        const cloneModes: number[] = [];

        try {
            await writeFile(source, 'fixture bytes');
            const result = await copyExactPdfFixture(source, target, {copyFileImpl: async (from, to, mode) => {
                cloneModes.push(mode ?? 0);
                if (mode === constants.COPYFILE_FICLONE_FORCE) {
                    await writeFile(to, 'partial clone');
                    throw Object.assign(new Error('clone unsupported'), {code: 'ENOTSUP'});
                }
                await writeFile(to, await readFile(from));
            }});

            expect(result.mode).toBe('stream');
            expect(cloneModes).toContain(constants.COPYFILE_FICLONE_FORCE);
            await expect(readFile(target, 'utf8')).resolves.toBe('fixture bytes');
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('does not turn an unsupported clone into a green clone-only result', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-issue-136-clone-fail-'));
        const source = join(root, 'source.pdf');
        const target = join(root, 'target.pdf');

        try {
            await writeFile(source, 'fixture bytes');
            await expect(copyExactPdfFixture(source, target, {
                mode: 'clone',
                copyFileImpl: async () => {
                    throw Object.assign(new Error('clone unsupported'), {code: 'ENOTSUP'});
                },
            })).rejects.toThrow(/clone staging failed|unsupported/u);
            await expect(readFile(target)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('bounds the streaming fallback while it reads the source', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-issue-136-stream-limit-'));
        const source = join(root, 'source.pdf');
        const target = join(root, 'target.pdf');

        try {
            await writeFile(source, 'fixture bytes that exceed the limit');
            await expect(copyExactPdfFixture(source, target, {
                maxBytes: 8,
                mode: 'stream',
            })).rejects.toThrow(/resource limit/u);
            await expect(readFile(target)).rejects.toMatchObject({code: 'ENOENT'});
            const entries = await readdir(root);
            expect(entries.filter(entry => entry.endsWith('.tmp'))).toHaveLength(0);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('cancels a clone in flight and removes its partial staging output', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-issue-136-clone-cancel-'));
        const source = join(root, 'source.pdf');
        const target = join(root, 'target.pdf');
        const controller = new AbortController();
        let releaseClone: (() => void) | undefined;
        let markCloneStarted: (() => void) | undefined;
        const cloneStarted = new Promise<void>(resolve => {
            markCloneStarted = resolve;
        });
        const cloneRelease = new Promise<void>(resolve => {
            releaseClone = resolve;
        });

        try {
            await writeFile(source, 'fixture bytes');
            const staging = copyExactPdfFixture(source, target, {
                copyFileImpl: async (_sourcePath, temporaryPath) => {
                    await writeFile(temporaryPath, 'partial clone');
                    markCloneStarted?.();
                    await cloneRelease;
                },
                mode: 'clone',
                signal: controller.signal,
            });
            await cloneStarted;
            controller.abort(new Error('fixture staging cancelled'));
            await expect(staging).rejects.toThrow('fixture staging cancelled');
            releaseClone?.();
            await expect(readFile(target)).rejects.toMatchObject({code: 'ENOENT'});
            const entries = await readdir(root);
            expect(entries.filter(entry => entry.endsWith('.tmp'))).toHaveLength(0);
        } finally {
            releaseClone?.();
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('cancels a pending fsync and removes its partial staging output', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-issue-136-fsync-cancel-'));
        const source = join(root, 'source.pdf');
        const target = join(root, 'target.pdf');
        const controller = new AbortController();
        let releaseSync: (() => void) | undefined;
        let markSyncStarted: (() => void) | undefined;
        const syncStarted = new Promise<void>(resolve => {
            markSyncStarted = resolve;
        });
        const syncRelease = new Promise<void>(resolve => {
            releaseSync = resolve;
        });

        try {
            await writeFile(source, 'fixture bytes');
            const staging = copyExactPdfFixture(source, target, {
                mode: 'stream',
                signal: controller.signal,
                streamCopyImpl: async (_sourcePath, temporaryPath) => {
                    await writeFile(temporaryPath, 'fixture bytes');
                },
                syncFileImpl: async () => {
                    markSyncStarted?.();
                    await syncRelease;
                },
            });
            await syncStarted;
            controller.abort(new Error('fixture fsync cancelled'));
            await expect(staging).rejects.toThrow('fixture fsync cancelled');
            releaseSync?.();
            await expect(readFile(target)).rejects.toMatchObject({code: 'ENOENT'});
            const entries = await readdir(root);
            expect(entries.filter(entry => entry.endsWith('.tmp'))).toHaveLength(0);
        } finally {
            releaseSync?.();
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('requires the complete exact fixture identity, not only size and pages', () => {
        const expected = {
            bytes: 722_176_299,
            pages: 882,
            sha256: '4f5c6a438f19a0b19faff37882be6f0bc9199fbf6ba5d0694ab25d4d32ce897b',
        };
        const expectedWithProfile = {
            ...expected,
            profile: 'auditedZaliznyak882',
        };
        expect(() => validateExactPdfFixtureIdentity(expected, expected)).not.toThrow();
        expect(() => validateExactPdfFixtureIdentity(expected, expectedWithProfile)).not.toThrow();
        expect(() => validateExactPdfFixtureIdentity({
            ...expected,
            sha256: '0'.repeat(64),
        }, expected)).toThrow(/identity mismatch/u);
    });

    it('pins both public Zaliznyak fixture identities in the manifest', () => {
        expect(EXACT_PDF_FIXTURE_MANIFEST.localZaliznyak882).toEqual({
            bytes: 722_178_517,
            pages: 882,
            profile: 'localZaliznyak882',
            sha256: '1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6',
        });
        expect(EXACT_PDF_FIXTURE_MANIFEST.xlargeZaliznyak2646).toEqual({
            bytes: 2_168_527_413,
            pages: 2_646,
            profile: 'xlargeZaliznyak2646',
            sha256: '5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea',
        });
    });

    it('admits every pinned exact identity only through an explicit runner profile', () => {
        for (const profile of Object.keys(EXACT_PDF_FIXTURE_MANIFEST)) {
            expect(resolveExactPdfFixtureExpectation({EVB_EXACT_FIXTURE_PROFILE: profile})).toEqual(EXACT_PDF_FIXTURE_MANIFEST[
                profile as keyof typeof EXACT_PDF_FIXTURE_MANIFEST
            ]);
        }
    });

    it('reports fixture absence as a fail-closed opt-in boundary', () => {
        expect(() => resolveExactPdfFixtureExpectation({})).toThrow(
            /exact fixture opt-in boundary.*EVB_EXACT_FIXTURE_PROFILE/iu,
        );
    });

    it('rejects arbitrary exact-fixture identity overrides', () => {
        expect(() => resolveExactPdfFixtureExpectation({
            EVB_EXACT_FIXTURE_PROFILE: 'auditedZaliznyak882',
            EVB_EXACT_FIXTURE_BYTES: '1',
            EVB_EXACT_FIXTURE_PAGES: '1',
            EVB_EXACT_FIXTURE_SHA256: '0'.repeat(64),
        })).toThrow(/identity override/u);
    });

    it('fails quarantine admission for zero, failed, or skipped tests', () => {
        expect(() => assertQuarantineReport({
            numTotalTests: 0,
            numPassedTests: 0,
            numFailedTests: 0,
            numPendingTests: 0,
            testResults: [],
        })).toThrow(/empty quarantine assertions/u);
        expect(() => assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 0,
            numFailedTests: 1,
            numPendingTests: 0,
            testResults: [{assertionResults: [{status: 'failed'}]}],
        })).toThrow(/failed tests/u);
        expect(() => assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 0,
            numFailedTests: 0,
            numPendingTests: 1,
            testResults: [{assertionResults: [{status: 'pending'}]}],
        })).toThrow(/skipped or pending/u);
        expect(() => assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
            numPendingTests: 0,
            testResults: [],
        })).toThrow(/empty quarantine assertions/u);
        expect(() => assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
            numPendingTests: 0,
            testResults: [{assertionResults: []}],
        })).toThrow(/empty quarantine assertions/u);
        expect(() => assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
            numPendingTests: 0,
        })).toThrow(/assertion/u);
        expect(() => assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
            testResults: [{assertionResults: [{status: 'failed'}]}],
        })).toThrow(/counter mismatch/u);
        expect(() => assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
            numPendingTests: 0,
            testResults: [{assertionResults: [{status: 'pending'}]}],
        })).toThrow(/counter mismatch/u);
        expect(assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
            numPendingTests: 0,
            testResults: [{assertionResults: [{status: 'passed'}]}],
        })).toEqual({
            failed: 0,
            passed: 1,
            pending: 0,
            todo: 0,
            total: 1,
        });
        expect(() => assertQuarantineReport({
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
            numPendingTests: 0,
            testResults: [{}],
        })).toThrow(/assertionResults/u);
        expect(() => assertQuarantineReport({
            numTotalTests: -1,
            numPassedTests: 0,
            numFailedTests: 0,
        })).toThrow(/invalid quarantine counter/u);
        expect(() => assertQuarantineReport({
            success: false,
            numTotalTests: 1,
            numPassedTests: 1,
            numFailedTests: 0,
        })).toThrow(/marked the run as failed/u);
    });

    it('admits only live, issue-owned quarantine entries with concrete assertion suites', () => {
        const policy = {tests: [{
            assertionReport: 'tests/e2e/electron/quarantine/example.e2e.test.ts',
            expiresOn: '2026-09-30',
            issue: 'https://github.com/evb0110/evb-viewer/issues/136',
            path: 'tests/e2e/electron/quarantine/example.e2e.test.ts',
            targetProject: 'e2e-core',
        }]};
        const report = {
            numFailedTests: 0,
            numPassedTests: 1,
            numPendingTests: 0,
            numTotalTests: 1,
            testResults: [{
                assertionResults: [{status: 'passed'}],
                name: '/workspace/tests/e2e/electron/quarantine/example.e2e.test.ts',
            }],
        };

        expect(assertQuarantinePolicy(policy, report, new Date('2026-08-30T00:00:00Z')))
            .toEqual({
                declared: 1,
                reported: 1,
            });
        expect(() => assertQuarantinePolicy({tests: [{
            ...policy.tests[0],
            issue: '',
        }]}, report, new Date('2026-08-30T00:00:00Z'))).toThrow(/issue/u);
        expect(() => assertQuarantinePolicy(policy, report, new Date('2026-10-01T00:00:00Z')))
            .toThrow(/expired/u);
        expect(() => assertQuarantinePolicy({tests: [{
            ...policy.tests[0],
            expiresOn: '2026-02-31',
        }]}, report, new Date('2026-01-01T00:00:00Z'))).toThrow(/expiry date/u);
        expect(() => assertQuarantinePolicy(policy, {
            ...report,
            testResults: [
                report.testResults[0],
                report.testResults[0],
            ],
        }, new Date('2026-08-30T00:00:00Z'))).toThrow(/more than once/u);
        expect(() => assertQuarantinePolicy(policy, {
            ...report,
            testResults: [{
                assertionResults: [{status: 'passed'}],
                name: '/workspace/tests/e2e/electron/quarantine/unreferenced.e2e.test.ts',
            }],
        }, new Date('2026-08-30T00:00:00Z'))).toThrow(/unreferenced|missing assertion report/iu);
    });
});
