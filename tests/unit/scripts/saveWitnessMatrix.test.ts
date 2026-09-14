import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    runSaveWitnessMatrix,
    SAVE_WITNESS_MATRIX_CYCLES,
    type ISaveWitnessMatrixAdapter,
} from '@scripts/save-witness/saveWitnessMatrix';
import {
    mkdtemp, readFile, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    captureResearchFullContentWitness,
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
                peakMemoryBytes: 4,
                mainProcessTimerGapMs: 5,
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

    it('rejects same-size interior changes and symlink paths with full-content evidence', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-save-witness-'));
        const path = join(root, 'source.pdf');
        await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 7));
        const witness = await captureResearchFullContentWitness(path);
        const changed = Buffer.alloc(2 * 1024 * 1024, 7);
        changed[1_500_000] = 8;
        await writeFile(path, changed);
        await expect(witness.compareNamedPath()).rejects.toBeInstanceOf(ResearchFullContentWitnessError);
        await witness.close();
        const link = join(root, 'link.pdf');
        await symlink(path, link);
        await expect(captureResearchFullContentWitness(link)).rejects.toBeInstanceOf(ResearchFullContentWitnessError);
    });

    it('rejects a pathname replacement after the baseline instead of accepting its bytes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-save-witness-replace-'));
        const path = join(root, 'source.pdf');
        const replacement = join(root, 'replacement.pdf');
        await writeFile(path, Buffer.alloc(1024 * 1024, 1));
        await writeFile(replacement, Buffer.alloc(1024 * 1024, 2));
        const witness = await captureResearchFullContentWitness(path);
        await writeFile(path, await readFile(replacement));
        await expect(witness.compareNamedPath()).rejects.toBeInstanceOf(ResearchFullContentWitnessError);
        await witness.close();
    });

    it('rejects mutation during the streaming baseline and replacement after hashing', async () => {
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
        const witness = await captureResearchFullContentWitness(path, {onComparisonHashed: async () => writeFile(path, Buffer.alloc(2 * 1024 * 1024, 5))});
        await expect(witness.compareNamedPath()).rejects.toBeInstanceOf(ResearchFullContentWitnessError);
        await witness.close();
    });
});
