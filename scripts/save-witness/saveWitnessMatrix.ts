import { createHash } from 'node:crypto';
import {
    copyFile, mkdir, readFile, stat, writeFile, 
} from 'node:fs/promises';
import {
    dirname,
    join,
    relative,
    resolve,
} from 'node:path';
import { generateLargePdfE2eFixture } from '@scripts/generate-large-pdf-e2e-fixture.mjs';

export const SAVE_WITNESS_MATRIX_SCHEMA_VERSION = 1;
export const SAVE_WITNESS_MATRIX_CYCLES = 3;
export const SAVE_WITNESS_MATRIX_CI_CEILING_MS = 12_000;
export const SAVE_WITNESS_MATRIX_LOCAL_TARGET_MS = 8_000;
export const SAVE_WITNESS_MATRIX_DEADLINE_MS = 120_000;
export const SAVE_WITNESS_MATRIX_CHUNK_BYTES = 1024 * 1024;

export type TSaveWitnessMatrixFixtureId = 'existing-small' | 'exact-65-mib' | 'exact-513-mib';

export interface ISaveWitnessMatrixFixture {
    id: TSaveWitnessMatrixFixtureId;
    path: string;
    bytes: number;
    sha256: string;
    validPdf: boolean;
}

export interface ISaveWitnessMatrixCancellation {
    passed: boolean;
    issuedReadBytes: number;
    readsAfterCancellation: number;
    published: boolean;
    originalPreserved: boolean;
    durationMs: number;
    failure: string | null;
}

export interface ISaveWitnessMatrixCell {
    fixtureId: TSaveWitnessMatrixFixtureId;
    cycle: number;
    passed: boolean;
    baselineCaptureMs: number | null;
    totalSaveLatencyMs: number | null;
    readVolumeBytes: number | null;
    peakMemoryBytes: number | null;
    mainProcessTimerGapMs: number | null;
    cancellation: ISaveWitnessMatrixCancellation | null;
    failure: string | null;
}

export interface ISaveWitnessMatrixReport {
    schemaVersion: number;
    generatedAt: string;
    platform: NodeJS.Platform;
    fixtures: ISaveWitnessMatrixFixture[];
    thresholds: {
        ciCeilingMs: number;
        localTargetMs: number;
        cancellationDeadlineMs: number;
    };
    coverage: string;
    cache: {
        mode: 'warm';
        coldObservation: string;
    };
    productionSavePathCost: string;
    cells: ISaveWitnessMatrixCell[];
}

export interface ISaveWitnessMatrixAdapter {
    runCycle(fixture: ISaveWitnessMatrixFixture, cycle: number): Promise<{
        baselineCaptureMs: number;
        totalSaveLatencyMs: number;
        readVolumeBytes: number;
        peakMemoryBytes: number | null;
        mainProcessTimerGapMs: number | null;
    }>;
    runCancellation(fixture: ISaveWitnessMatrixFixture): Promise<ISaveWitnessMatrixCancellation>;
}

export class SaveWitnessMatrixMeasuredError extends Error {
    constructor(
        message: string,
        public readonly measurement: Partial<{
            baselineCaptureMs: number;
            totalSaveLatencyMs: number;
            readVolumeBytes: number;
            peakMemoryBytes: number | null;
            mainProcessTimerGapMs: number | null;
        }>,
    ) {
        super(message);
        this.name = 'SaveWitnessMatrixMeasuredError';
    }
}

const MIB = 1024 * 1024;

function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function verifyPdf(filePath: string, expectedBytes: number) {
    const bytes = await readFile(filePath);
    const text = bytes.subarray(0, 5).toString('ascii');
    const tail = bytes.subarray(Math.max(0, bytes.length - 64)).toString('ascii');
    return {
        bytes: bytes.length === expectedBytes ? bytes.length : bytes.length,
        sha256: sha256(bytes),
        validPdf: text === '%PDF-' && tail.includes('%%EOF'),
    };
}

export async function ensureSaveWitnessMatrixFixtures(root = resolve(process.cwd(), '.devkit', 'save-witness-matrix', 'fixtures')) {
    await mkdir(root, { recursive: true });
    const smallSource = resolve(process.cwd(), 'tests', 'fixtures', 'electron', 'interop', 'stock-pdfjs-save-of-synthetic.pdf');
    const smallPath = join(root, 'existing-small.pdf');
    await copyFile(smallSource, smallPath);
    const large = [
        [
            'exact-65-mib',
            65 * MIB,
        ],
        [
            'exact-513-mib',
            513 * MIB,
        ],
    ] as const;
    for (const [
        id,
        bytes,
    ] of large) {
        const outputPath = join(root, `${id}.pdf`);
        const existing = await stat(outputPath).catch(() => null);
        if (existing?.size !== bytes) {
            await generateLargePdfE2eFixture({
                outputPath,
                pageCount: 431,
                targetBytes: bytes,
            });
        }
    }
    const specs: Array<[TSaveWitnessMatrixFixtureId, string, number]> = [
        [
            'existing-small',
            smallPath,
            (await stat(smallPath)).size,
        ],
        [
            'exact-65-mib',
            join(root, 'exact-65-mib.pdf'),
            65 * MIB,
        ],
        [
            'exact-513-mib',
            join(root, 'exact-513-mib.pdf'),
            513 * MIB,
        ],
    ];
    const fixtures: ISaveWitnessMatrixFixture[] = [];
    for (const [
        id,
        path,
        bytes,
    ] of specs) {
        const identity = await verifyPdf(path, bytes);
        if (identity.bytes !== bytes || !identity.validPdf) {
            throw new Error(`save-witness fixture ${id} failed exact-size or PDF validation`);
        }
        fixtures.push({
            id,
            path,
            bytes,
            ...identity, 
        });
    }
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
        schemaVersion: SAVE_WITNESS_MATRIX_SCHEMA_VERSION,
        fixtures,
    }, null, 2) + '\n', 'utf8');
    return fixtures;
}

export async function runSaveWitnessMatrix(
    fixtures: readonly ISaveWitnessMatrixFixture[],
    adapter: ISaveWitnessMatrixAdapter,
): Promise<ISaveWitnessMatrixReport> {
    const cells: ISaveWitnessMatrixCell[] = [];
    for (const fixture of fixtures) {
        for (let cycle = 1; cycle <= SAVE_WITNESS_MATRIX_CYCLES; cycle += 1) {
            const started = Date.now();
            try {
                const measured = await adapter.runCycle(fixture, cycle);
                cells.push({
                    fixtureId: fixture.id,
                    cycle,
                    passed: measured.baselineCaptureMs <= SAVE_WITNESS_MATRIX_CI_CEILING_MS
                        && measured.totalSaveLatencyMs <= SAVE_WITNESS_MATRIX_CI_CEILING_MS,
                    ...measured,
                    cancellation: null,
                    failure: null,
                });
            } catch (error) {
                const measurement = error instanceof SaveWitnessMatrixMeasuredError
                    ? error.measurement
                    : {};
                cells.push({
                    fixtureId: fixture.id,
                    cycle,
                    passed: false,
                    baselineCaptureMs: measurement.baselineCaptureMs ?? null,
                    totalSaveLatencyMs: Date.now() - started,
                    readVolumeBytes: measurement.readVolumeBytes ?? null,
                    peakMemoryBytes: measurement.peakMemoryBytes ?? null,
                    mainProcessTimerGapMs: measurement.mainProcessTimerGapMs ?? null,
                    cancellation: null,
                    failure: error instanceof Error ? error.message : String(error),
                });
            }
        }
        try {
            const cancellation = await adapter.runCancellation(fixture);
            cells.push({
                fixtureId: fixture.id,
                cycle: 0,
                passed: cancellation.passed,
                baselineCaptureMs: null,
                totalSaveLatencyMs: null,
                readVolumeBytes: cancellation.issuedReadBytes,
                peakMemoryBytes: null,
                mainProcessTimerGapMs: null,
                cancellation,
                failure: cancellation.failure,
            });
        } catch (error) {
            cells.push({
                fixtureId: fixture.id,
                cycle: 0,
                passed: false,
                baselineCaptureMs: null,
                totalSaveLatencyMs: null,
                readVolumeBytes: null,
                peakMemoryBytes: null,
                mainProcessTimerGapMs: null,
                cancellation: null,
                failure: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return {
        schemaVersion: SAVE_WITNESS_MATRIX_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        fixtures: [...fixtures],
        thresholds: {
            ciCeilingMs: SAVE_WITNESS_MATRIX_CI_CEILING_MS,
            localTargetMs: SAVE_WITNESS_MATRIX_LOCAL_TARGET_MS,
            cancellationDeadlineMs: SAVE_WITNESS_MATRIX_DEADLINE_MS,
        },
        coverage: 'open -> identical atomic replacement -> edit -> save-witness comparison -> reopen stat; no app-level save is invoked',
        cache: {
            mode: 'warm',
            coldObservation: 'Not measured: this harness has no portable cache-drop operation without elevated privileges.',
        },
        productionSavePathCost: 'Not included. Production save adds its own PDF serialization, publication, sidecar and recovery work.',
        cells,
    };
}

export async function writeSaveWitnessMatrixReport(report: ISaveWitnessMatrixReport, outputPath: string) {
    await mkdir(dirname(outputPath), { recursive: true });
    const reportForDisk = {
        ...report,
        fixtures: report.fixtures.map(fixture => ({
            ...fixture,
            path: relative(dirname(outputPath), fixture.path),
        })),
        decision: report.cells.every(cell => cell.passed) ? 'affirmative' : 'negative',
    };
    await writeFile(outputPath, JSON.stringify(reportForDisk, null, 2) + '\n', 'utf8');
}
