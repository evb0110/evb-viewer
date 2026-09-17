import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    stat,
    symlink,
    utimes,
    writeFile,
} from 'fs/promises';
import {tmpdir} from 'os';
import {
    basename,
    dirname,
    join,
} from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    acknowledgeScanCleanupCompletedOutputs,
    createScanCleanupGeneratedOutputPath,
    getScanCleanupCompletedOutputJournalPath,
    getPendingScanCleanupCompletedOutputs,
    getScanCleanupOutputBaseDirs,
    getScanCleanupOutputRoot,
    isScanCleanupGeneratedOutputPath,
    pruneScanCleanupGeneratedOutputs,
    recordScanCleanupCompletedOutput,
    SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES,
    SCAN_CLEANUP_OUTPUT_MAX_AGE_MS,
    touchScanCleanupGeneratedOutput,
} from '@electron/features/scan-cleanup/public/generatedOutputs';
import {
    clearWorkingCopyOriginalPaths,
    isWorkingCopyOriginalPathRegistered,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';

const electronPaths = vi.hoisted(() => ({
    temp: '',
    userData: '',
}));

vi.mock('electron', async importOriginal => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        app: {
            ...(actual.app as Record<string, unknown>),
            getPath: (name: string) => (name === 'userData' ? electronPaths.userData : electronPaths.temp),
        },
    };
});

const tempDirs: string[] = [];
const RUN_ID = '01234567-89ab-cdef-0123-456789abcdef';
const OTHER_RUN_ID = 'fedcba98-7654-3210-fedc-ba9876543210';
const DAY_MS = 24 * 60 * 60 * 1_000;

async function createManagedTempDir(prefix: string) {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(path);
    return path;
}

async function writeGeneratedOutput(baseDir: string, runId: string, createdAtMs: number) {
    const outputDirectory = join(getScanCleanupOutputRoot(baseDir), runId);
    await mkdir(outputDirectory, {recursive: true});
    const outputPath = join(outputDirectory, 'scan — cleaned.pdf');
    await writeFile(outputPath, 'generated');
    const createdAtSeconds = createdAtMs / 1_000;
    await utimes(outputDirectory, createdAtSeconds, createdAtSeconds);
    return outputPath;
}

beforeEach(async () => {
    clearWorkingCopyOriginalPaths();
    electronPaths.userData = await createManagedTempDir('scan-cleanup-app-data-');
    electronPaths.temp = await createManagedTempDir('scan-cleanup-os-temp-');
});

afterEach(async () => {
    clearWorkingCopyOriginalPaths();
    const {rm} = await import('fs/promises');
    await Promise.all(tempDirs.splice(0).map(path => rm(path, {
        recursive: true,
        force: true,
    })));
});

describe('scan cleanup generated output pruning', () => {
    it('journals a completed output until the renderer acknowledges opening it', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-journal-test-'));
        tempDirs.push(outputBaseDir);
        const outputPath = await createScanCleanupGeneratedOutputPath('/books/Journal.pdf', false, outputBaseDir);
        await writeFile(outputPath, 'generated');

        await recordScanCleanupCompletedOutput(outputPath, {
            baseDir: outputBaseDir,
            completedAtMs: 123,
        });
        await expect(getPendingScanCleanupCompletedOutputs({baseDir: outputBaseDir})).resolves.toEqual([outputPath]);

        await acknowledgeScanCleanupCompletedOutputs([outputPath], {baseDir: outputBaseDir});
        await expect(getPendingScanCleanupCompletedOutputs({baseDir: outputBaseDir})).resolves.toEqual([]);
    });

    it('discards a truncated completed-output journal instead of blocking recovery', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-journal-corrupt-test-'));
        tempDirs.push(outputBaseDir);
        const journalPath = getScanCleanupCompletedOutputJournalPath(outputBaseDir);
        await mkdir(dirname(journalPath), {recursive: true});
        await writeFile(journalPath, '{', 'utf8');

        await expect(getPendingScanCleanupCompletedOutputs({baseDir: outputBaseDir})).resolves.toEqual([]);
        await expect(access(journalPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('skips malformed journal entries while preserving valid completed outputs', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-journal-entry-test-'));
        tempDirs.push(outputBaseDir);
        const outputPath = await writeGeneratedOutput(outputBaseDir, RUN_ID, Date.now());
        const journalPath = getScanCleanupCompletedOutputJournalPath(outputBaseDir);
        await mkdir(dirname(journalPath), {recursive: true});
        await writeFile(journalPath, JSON.stringify([
            {
                version: 1,
                outputPdfPath: outputPath,
                completedAtMs: 123,
            },
            {
                version: 1,
                outputPdfPath: '/outside.pdf',
                completedAtMs: 'invalid',
            },
            'torn-entry',
        ]), 'utf8');

        await expect(getPendingScanCleanupCompletedOutputs({baseDir: outputBaseDir})).resolves.toEqual([outputPath]);
        await expect(readFile(journalPath, 'utf8')).resolves.toContain(outputPath);
    });

    it('creates a managed, human-readable output path without a save dialog', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-path-test-'));
        tempDirs.push(outputBaseDir);
        const path = await createScanCleanupGeneratedOutputPath('/books/My scan.pdf', false, outputBaseDir);
        expect(path).toMatch(/scan-cleanup[/\\]output[/\\][^/\\]+[/\\]My scan — cleaned\.pdf$/u);
        await expect(stat(join(path, '..'))).resolves.toBeDefined();
        await writeFile(path, 'generated');
        expect(isScanCleanupGeneratedOutputPath(path, [outputBaseDir])).toBe(true);

        const partialPath = await createScanCleanupGeneratedOutputPath('/books/My scan.pdf', true, outputBaseDir);
        expect(partialPath).toMatch(/My scan — cleaned selection\.pdf$/u);
    });

    it('byte-caps long Unicode names with a deterministic collision hash and writable suffix', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-long-name-test-'));
        tempDirs.push(outputBaseDir);
        const commonPrefix = '漢'.repeat(200);
        const sourceA = `/books/${commonPrefix}甲.pdf`;
        const sourceB = `/books/${commonPrefix}乙.pdf`;
        const [
            pathA,
            pathB,
            repeatedPathA,
        ] = await Promise.all([
            createScanCleanupGeneratedOutputPath(sourceA, false, outputBaseDir),
            createScanCleanupGeneratedOutputPath(sourceB, false, outputBaseDir),
            createScanCleanupGeneratedOutputPath(sourceA, false, outputBaseDir),
        ]);
        const leafA = basename(pathA);
        const leafB = basename(pathB);

        expect(Buffer.byteLength(leafA, 'utf8')).toBeLessThanOrEqual(SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES);
        expect(Buffer.byteLength(leafB, 'utf8')).toBeLessThanOrEqual(SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES);
        expect(leafA).toMatch(/…-[a-f\d]{12} — cleaned\.pdf$/u);
        expect(leafB).toMatch(/…-[a-f\d]{12} — cleaned\.pdf$/u);
        expect(leafA).not.toBe(leafB);
        expect(basename(repeatedPathA)).toBe(leafA);

        await Promise.all([
            writeFile(pathA, 'generated A'),
            writeFile(pathB, 'generated B'),
            writeFile(repeatedPathA, 'generated A again'),
        ]);
        await expect(Promise.all([
            stat(pathA),
            stat(pathB),
            stat(repeatedPathA),
        ])).resolves.toHaveLength(3);
    });

    it('classifies only descendants of the managed output root', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-classifier-test-'));
        tempDirs.push(outputBaseDir);
        const root = getScanCleanupOutputRoot(outputBaseDir);
        const outsidePath = join(outputBaseDir, 'outside.pdf');
        await writeFile(outsidePath, 'outside');
        expect(isScanCleanupGeneratedOutputPath(outsidePath, [outputBaseDir])).toBe(false);
        const managedPath = join(
            root,
            '01234567-89ab-cdef-0123-456789abcdef',
            'scan — cleaned.pdf',
        );
        await mkdir(join(managedPath, '..'), {recursive: true});
        await writeFile(managedPath, 'generated');

        expect(isScanCleanupGeneratedOutputPath(
            managedPath,
            [outputBaseDir],
        )).toBe(true);
        expect(isScanCleanupGeneratedOutputPath(
            await realpath(managedPath),
            [outputBaseDir],
        )).toBe(true);
        expect(isScanCleanupGeneratedOutputPath(root, [outputBaseDir])).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(
            join(outputBaseDir, 'scan-cleanup', 'output-sibling', 'scan.pdf'),
            [outputBaseDir],
        )).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(
            outsidePath,
            [outputBaseDir],
        )).toBe(false);
        const nonUuidPath = join(root, 'not-a-run-id', 'scan.pdf');
        const nestedPath = join(
            root,
            '01234567-89ab-cdef-0123-456789abcdef',
            'nested',
            'scan.pdf',
        );
        const nonPdfPath = join(
            root,
            '01234567-89ab-cdef-0123-456789abcdef',
            'scan.png',
        );
        await mkdir(join(nonUuidPath, '..'), {recursive: true});
        await mkdir(join(nestedPath, '..'), {recursive: true});
        await Promise.all([
            writeFile(nonUuidPath, 'generated'),
            writeFile(nestedPath, 'generated'),
            writeFile(nonPdfPath, 'generated'),
        ]);
        expect(isScanCleanupGeneratedOutputPath(nonUuidPath, [outputBaseDir])).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(nestedPath, [outputBaseDir])).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(nonPdfPath, [outputBaseDir])).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(join(root, 'missing.pdf'), [outputBaseDir])).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('rejects symlink escapes from the managed root', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-symlink-test-'));
        tempDirs.push(outputBaseDir);
        const root = getScanCleanupOutputRoot(outputBaseDir);
        const outsidePath = join(outputBaseDir, 'outside.pdf');
        const runDirectory = join(root, '01234567-89ab-cdef-0123-456789abcdef');
        await mkdir(runDirectory, {recursive: true});
        await writeFile(outsidePath, 'outside');
        const linkedPdf = join(runDirectory, 'scan.pdf');
        await symlink(outsidePath, linkedPdf);

        expect(isScanCleanupGeneratedOutputPath(linkedPdf, [outputBaseDir])).toBe(false);
    });

    it('removes only stale output entries that are not open', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-test-'));
        tempDirs.push(outputBaseDir);
        const root = getScanCleanupOutputRoot(outputBaseDir);
        const stale = join(root, 'stale');
        const open = join(root, 'open');
        const fresh = join(root, 'fresh');
        await Promise.all([
            stale,
            open,
            fresh,
        ].map(path => mkdir(path, {recursive: true})));
        const stalePdf = join(stale, 'stale — cleaned.pdf');
        const openPdf = join(open, 'open — cleaned.pdf');
        const freshPdf = join(fresh, 'fresh — cleaned.pdf');
        await Promise.all([
            writeFile(stalePdf, 'stale'),
            writeFile(openPdf, 'open'),
            writeFile(freshPdf, 'fresh'),
        ]);
        const nowMs = Date.now();
        const oldSeconds = (nowMs - SCAN_CLEANUP_OUTPUT_MAX_AGE_MS - 1_000) / 1_000;
        await Promise.all([
            utimes(stale, oldSeconds, oldSeconds),
            utimes(open, oldSeconds, oldSeconds),
        ]);

        await expect(pruneScanCleanupGeneratedOutputs({
            baseDirs: [outputBaseDir],
            isOutputLive: path => path === openPdf,
            nowMs,
        })).resolves.toBe(1);
        await expect(stat(stale)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(stat(open)).resolves.toBeDefined();
        await expect(stat(fresh)).resolves.toBeDefined();
    });

    it('protects a completed output from pruning until the renderer acknowledges it', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-pending-prune-test-'));
        tempDirs.push(outputBaseDir);
        const outputPath = await writeGeneratedOutput(
            outputBaseDir,
            RUN_ID,
            Date.now() - SCAN_CLEANUP_OUTPUT_MAX_AGE_MS - 1_000,
        );
        await recordScanCleanupCompletedOutput(outputPath, {baseDir: outputBaseDir});

        await expect(pruneScanCleanupGeneratedOutputs({
            baseDirs: [outputBaseDir],
            isOutputLive: () => false,
            nowMs: Date.now(),
        })).resolves.toBe(0);
        await expect(stat(outputPath)).resolves.toBeDefined();

        await acknowledgeScanCleanupCompletedOutputs([outputPath], {baseDir: outputBaseDir});
        await expect(pruneScanCleanupGeneratedOutputs({
            baseDirs: [outputBaseDir],
            isOutputLive: () => false,
            nowMs: Date.now(),
        })).resolves.toBe(1);
        await expect(stat(outputPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('aggregates main-owned output liveness across two WebContents', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-owners-test-'));
        tempDirs.push(outputBaseDir);
        const root = getScanCleanupOutputRoot(outputBaseDir);
        const first = join(root, 'first');
        const second = join(root, 'second');
        const orphan = join(root, 'orphan');
        await Promise.all([
            first,
            second,
            orphan,
        ].map(path => mkdir(path, {recursive: true})));
        const firstPdf = join(first, 'first — cleaned.pdf');
        const secondPdf = join(second, 'second — cleaned.pdf');
        await Promise.all([
            writeFile(firstPdf, 'first'),
            writeFile(secondPdf, 'second'),
            writeFile(join(orphan, 'orphan — cleaned.pdf'), 'orphan'),
        ]);
        const nowMs = Date.now();
        const oldSeconds = (nowMs - SCAN_CLEANUP_OUTPUT_MAX_AGE_MS - 1_000) / 1_000;
        await Promise.all([
            utimes(first, oldSeconds, oldSeconds),
            utimes(second, oldSeconds, oldSeconds),
            utimes(orphan, oldSeconds, oldSeconds),
        ]);
        await Promise.all([
            setWorkingCopyOriginalPath('/working/first.pdf', firstPdf, 101, {deferOriginalFileExpectation: true}),
            setWorkingCopyOriginalPath('/working/second.pdf', secondPdf, 202, {deferOriginalFileExpectation: true}),
        ]);

        await expect(pruneScanCleanupGeneratedOutputs({
            baseDirs: [outputBaseDir],
            isOutputLive: isWorkingCopyOriginalPathRegistered,
            nowMs,
        })).resolves.toBe(1);
        await expect(stat(first)).resolves.toBeDefined();
        await expect(stat(second)).resolves.toBeDefined();
        await expect(stat(orphan)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('rechecks main liveness before deleting when an output opens during pruning', async () => {
        const outputBaseDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-open-race-test-'));
        tempDirs.push(outputBaseDir);
        const root = getScanCleanupOutputRoot(outputBaseDir);
        const candidate = join(root, 'candidate');
        await mkdir(candidate, {recursive: true});
        const candidatePdf = join(candidate, 'candidate — cleaned.pdf');
        await writeFile(candidatePdf, 'candidate');
        const nowMs = Date.now();
        const oldSeconds = (nowMs - SCAN_CLEANUP_OUTPUT_MAX_AGE_MS - 1_000) / 1_000;
        await utimes(candidate, oldSeconds, oldSeconds);
        let initialCheck = true;
        let registration: Promise<void> | null = null;

        await expect(pruneScanCleanupGeneratedOutputs({
            baseDirs: [outputBaseDir],
            isOutputLive: outputPath => {
                const liveAtCheckStart = isWorkingCopyOriginalPathRegistered(outputPath);
                if (initialCheck) {
                    initialCheck = false;
                    registration = setWorkingCopyOriginalPath(
                        '/working/newly-opened.pdf',
                        outputPath,
                        303,
                        {deferOriginalFileExpectation: true},
                    );
                }
                return liveAtCheckStart;
            },
            nowMs,
        })).resolves.toBe(0);
        if (registration !== null) {
            await Promise.resolve(registration);
        }
        await expect(stat(candidate)).resolves.toBeDefined();
    });

    it('keeps an output reopened inside the retention window and still removes its untouched sibling', async () => {
        const outputBaseDir = await createManagedTempDir('scan-cleanup-output-access-test-');
        const baseDirs = [outputBaseDir];
        const createdAtMs = Date.now() - 9 * DAY_MS;
        const reopenedPath = await writeGeneratedOutput(outputBaseDir, RUN_ID, createdAtMs);
        const abandonedPath = await writeGeneratedOutput(outputBaseDir, OTHER_RUN_ID, createdAtMs);

        await expect(touchScanCleanupGeneratedOutput(reopenedPath, {
            baseDirs,
            nowMs: createdAtMs + 6 * DAY_MS,
        })).resolves.toBe(true);

        await expect(pruneScanCleanupGeneratedOutputs({
            baseDirs,
            isOutputLive: () => false,
            nowMs: createdAtMs + 9 * DAY_MS,
        })).resolves.toBe(1);
        await expect(stat(reopenedPath)).resolves.toBeDefined();
        await expect(stat(abandonedPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('writes new outputs under app data and keeps sweeping the legacy temp root', async () => {
        const [
            appDataBaseDir,
            legacyTempBaseDir,
        ] = getScanCleanupOutputBaseDirs();
        expect(appDataBaseDir).toBe(electronPaths.userData);
        expect(legacyTempBaseDir).toBe(join(electronPaths.temp, 'evb-viewer'));

        const createdPath = await createScanCleanupGeneratedOutputPath('/books/My scan.pdf');
        await writeFile(createdPath, 'generated');
        expect(dirname(dirname(createdPath))).toBe(getScanCleanupOutputRoot(appDataBaseDir!));
        expect(createdPath.startsWith(electronPaths.temp)).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(createdPath)).toBe(true);

        const staleLegacyPath = await writeGeneratedOutput(
            legacyTempBaseDir!,
            RUN_ID,
            Date.now() - 9 * DAY_MS,
        );
        expect(isScanCleanupGeneratedOutputPath(staleLegacyPath)).toBe(true);

        await expect(pruneScanCleanupGeneratedOutputs({isOutputLive: () => false})).resolves.toBe(1);
        await expect(stat(staleLegacyPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(stat(createdPath)).resolves.toBeDefined();
    });

    it('ignores retention refreshes for paths outside the managed output roots', async () => {
        const outputBaseDir = await createManagedTempDir('scan-cleanup-output-touch-guard-test-');
        const outsidePath = join(outputBaseDir, 'outside.pdf');
        await writeFile(outsidePath, 'outside');
        const metadataBefore = await stat(outputBaseDir);

        await expect(touchScanCleanupGeneratedOutput(outsidePath, {
            baseDirs: [outputBaseDir],
            nowMs: Date.now() + DAY_MS,
        })).resolves.toBe(false);
        await expect(stat(outputBaseDir)).resolves.toMatchObject({mtimeMs: metadataBefore.mtimeMs});
    });
});
