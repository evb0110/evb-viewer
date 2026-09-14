import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    runSaveWitnessMatrix,
    SAVE_WITNESS_MATRIX_CYCLES,
    SAVE_WITNESS_MATRIX_DEADLINE_MS,
    withSaveWitnessDeadline,
    type ISaveWitnessMatrixAdapter,
} from '@scripts/save-witness/saveWitnessMatrix';
import {
    mkdtemp, rename, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    captureResearchFullContentWitness,
    RESEARCH_WITNESS_CHUNK_BYTES,
    ResearchFullContentWitnessError,
} from '@scripts/save-witness/researchFullContentWitness';

const fixtures = [
    {
        id: 'existing-small' as const,
        path: 'small.pdf',
        bytes: 10,
        sha256: 'a'.repeat(64),
        validPdf: true,
    },
    {
        id: 'exact-65-mib' as const,
        path: '65.pdf',
        bytes: 65 * 1024 * 1024,
        sha256: 'b'.repeat(64),
        validPdf: true,
    },
    {
        id: 'exact-513-mib' as const,
        path: '513.pdf',
        bytes: 513 * 1024 * 1024,
        sha256: 'c'.repeat(64),
        validPdf: true,
    },
];

describe('save-witness matrix', () => {
    it('records all three cycles and one cancellation cell for every fixture', async () => {
        const adapter: ISaveWitnessMatrixAdapter = {
            runCycle: async () => ({
                baselineCaptureMs: 1,
                totalSaveLatencyMs: 2,
                readVolumeBytes: 3,
                peakRssGrowthBytes: 4,
                workerEventLoopGapMs: 5,
            }),
            runCancellation: async () => ({
                passed: true,
                issuedReadBytes: 1024 * 1024,
                readsAfterCancellation: 0,
                published: false,
                originalPreserved: true,
                durationMs: 6,
                failure: null,
            }),
        };
        const report = await runSaveWitnessMatrix(fixtures, adapter);
        expect(report.cells).toHaveLength(fixtures.length * (SAVE_WITNESS_MATRIX_CYCLES + 1));
        expect(report.cells.filter(cell => cell.cycle === 0)).toHaveLength(fixtures.length);
        expect(report.thresholds).toEqual({
            ciCeilingMs: 12_000,
            localTargetMs: 8_000,
            cancellationDeadlineMs: 120_000,
        });
    });

    it('keeps a failed cycle in the report with null unavailable measurements', async () => {
        const report = await runSaveWitnessMatrix(fixtures.slice(0, 1), {
            runCycle: async () => {
                throw new Error('identical replacement rejected');
            },
            runCancellation: async () => ({
                passed: false,
                issuedReadBytes: 0,
                readsAfterCancellation: 0,
                published: false,
                originalPreserved: true,
                durationMs: 1,
                failure: 'cancellation not attempted',
            }),
        });
        expect(report.cells[0]).toMatchObject({
            passed: false,
            baselineCaptureMs: null,
            failure: 'identical replacement rejected',
        });
    });

    it('closes the baseline before returning and rejects symlink paths', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-save-witness-'));
        const path = join(root, 'source.pdf');
        await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 7));
        const witness = await captureResearchFullContentWitness(path);
        expect(witness).not.toHaveProperty('close');
        await expect(rename(path, `${path}.moved`)).resolves.toBeUndefined();
        await expect(rename(`${path}.moved`, path)).resolves.toBeUndefined();
        const link = join(root, 'link.pdf');
        await symlink(path, link);
        await expect(captureResearchFullContentWitness(link)).rejects.toBeInstanceOf(ResearchFullContentWitnessError);
    });

    it('rejects a pathname replacement while the save handle is held', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-save-witness-replace-'));
        const path = join(root, 'source.pdf');
        const replacement = join(root, 'replacement.pdf');
        await writeFile(path, Buffer.alloc(1024 * 1024, 1));
        await writeFile(replacement, Buffer.alloc(1024 * 1024, 2));
        const baseline = await captureResearchFullContentWitness(path);
        const save = await baseline.beginSave();
        try {
            await rename(replacement, path);
            await expect(save.assertPublicationAllowed()).rejects.toBeInstanceOf(ResearchFullContentWitnessError);
        } finally {
            await save.close();
        }
    });

    it('rejects same-size mutation during baseline and comparison', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-save-witness-race-'));
        const path = join(root, 'source.pdf');
        await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 3));
        await expect(captureResearchFullContentWitness(path, {onBaselineChunk: async chunk => {
            if (chunk === 0) {
                const changed = Buffer.alloc(2 * 1024 * 1024, 3);
                changed[1_500_000] = 4;
                await writeFile(path, changed);
            }
        }})).rejects.toBeInstanceOf(ResearchFullContentWitnessError);

        await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 3));
        const baseline = await captureResearchFullContentWitness(path, {onComparisonHashed: async () => writeFile(path, Buffer.alloc(2 * 1024 * 1024, 5))});
        await expect(baseline.beginSave()).rejects.toBeInstanceOf(ResearchFullContentWitnessError);
    });

    it('reports real bytes by phase and allows an async read callback to gate progress', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-save-witness-reads-'));
        const path = join(root, 'source.pdf');
        const bytes = 2 * 1024 * 1024 + 17;
        await writeFile(path, Buffer.alloc(bytes, 9));
        const reads: Array<[number, string]> = [];
        let releaseFirstRead!: () => void;
        let firstReadStarted!: () => void;
        const firstRead = new Promise<void>(resolve => { firstReadStarted = resolve; });
        const gate = new Promise<void>(resolve => { releaseFirstRead = resolve; });
        const baselinePromise = captureResearchFullContentWitness(path, {onRead: async (readBytes, phase) => {
            reads.push([
                readBytes,
                phase,
            ]);
            if (phase === 'baseline' && reads.length === 1) {
                firstReadStarted();
                await gate;
            }
        }});
        await firstRead;
        let settled = false;
        void baselinePromise.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        releaseFirstRead();
        const baseline = await baselinePromise;
        const save = await baseline.beginSave({onRead: async (readBytes, phase) => reads.push([
            readBytes,
            phase,
        ])});
        await save.assertPublicationAllowed();
        await save.close();
        expect(reads.filter(([
            , phase,
        ]) => phase === 'baseline').reduce((total, [readBytes]) => total + readBytes, 0)).toBe(bytes);
        expect(reads.filter(([
            , phase,
        ]) => phase === 'comparison').reduce((total, [readBytes]) => total + readBytes, 0)).toBe(bytes);
    });

    it('aborts after the issued read settles without issuing another read', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-save-witness-abort-'));
        const path = join(root, 'source.pdf');
        await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 6));
        const baseline = await captureResearchFullContentWitness(path);
        const controller = new AbortController();
        let issuedReads = 0;
        let settledReads = 0;
        await expect(baseline.beginSave({
            signal: controller.signal,
            onReadIssued: phase => {
                expect(phase).toBe('comparison');
                issuedReads += 1;
                controller.abort();
            },
            onRead: bytes => {
                expect(bytes).toBe(RESEARCH_WITNESS_CHUNK_BYTES);
                settledReads += 1;
            },
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(issuedReads).toBe(1);
        expect(settledReads).toBe(1);
    });

    it('enforces the hard deadline even when the operation settles later', async () => {
        vi.useFakeTimers();
        try {
            let release!: () => void;
            let signal!: AbortSignal;
            let publicationApproved = false;
            const held = withSaveWitnessDeadline(async currentSignal => {
                signal = currentSignal;
                await new Promise<void>(resolve => { release = resolve; });
                currentSignal.throwIfAborted();
                publicationApproved = true;
                return 'approved';
            });
            await vi.advanceTimersByTimeAsync(SAVE_WITNESS_MATRIX_DEADLINE_MS - 1);
            expect(signal.aborted).toBe(false);
            const rejected = expect(held).rejects.toThrow('save-witness probe exceeded the 120000ms hard stop');
            await vi.advanceTimersByTimeAsync(1);
            await rejected;
            expect(signal.aborted).toBe(true);
            release();
            await vi.runOnlyPendingTimersAsync();
            await Promise.resolve();
            await Promise.resolve();
            expect(signal.aborted).toBe(true);
            expect(publicationApproved).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
