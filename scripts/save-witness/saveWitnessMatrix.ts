import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { captureResearchFullContentWitness } from '@scripts/save-witness/researchFullContentWitness';
import {
    copyFile,
    mkdir,
    stat,
    writeFile,
    rename,
    open,
    appendFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    relative,
    resolve,
} from 'node:path';
import { generateLargePdfE2eFixture } from '@scripts/generate-large-pdf-e2e-fixture.mjs';

export const SAVE_WITNESS_MATRIX_SCHEMA_VERSION = 2;
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
    readSettledBeforeRejection?: boolean;
    singleReadIsWholeFile?: boolean;
    hardStop?: {
        deadlineMs: number;
        armed: boolean;
        triggered: boolean;
        settledWithinDeadline: boolean;
    };
    failure: string | null;
}

export interface ISaveWitnessMatrixCell {
    fixtureId: TSaveWitnessMatrixFixtureId;
    cycle: number;
    passed: boolean;
    baselineCaptureMs: number | null;
    totalSaveLatencyMs: number | null;
    readVolumeBytes: number | null;
    peakRssGrowthBytes: number | null;
    workerEventLoopGapMs: number | null;
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
    decisionScope: string;
    cells: ISaveWitnessMatrixCell[];
    adversarial: ISaveWitnessMatrixAdversarial[];
}

export interface ISaveWitnessMatrixAdversarial {
    fixtureId: TSaveWitnessMatrixFixtureId;
    passed: boolean;
    replacementOutcome: 'refused' | 'replaced' | 'not-attempted';
    replacementError: string | null;
    hardStopTriggered: boolean;
    publicationApproved: boolean;
    originalPreserved: boolean;
    failure: string | null;
}

export interface ISaveWitnessMatrixAdapter {
    runCycle(fixture: ISaveWitnessMatrixFixture, cycle: number): Promise<{
        baselineCaptureMs: number;
        totalSaveLatencyMs: number;
        readVolumeBytes: number;
        peakRssGrowthBytes: number | null;
        workerEventLoopGapMs: number | null;
    }>;
    runCancellation(fixture: ISaveWitnessMatrixFixture): Promise<ISaveWitnessMatrixCancellation>;
    runAdversarial?(fixture: ISaveWitnessMatrixFixture): Promise<ISaveWitnessMatrixAdversarial>;
}

export class SaveWitnessMatrixMeasuredError extends Error {
    constructor(
        message: string,
        public readonly measurement: Partial<{
            baselineCaptureMs: number;
            totalSaveLatencyMs: number;
            readVolumeBytes: number;
            peakRssGrowthBytes: number | null;
            workerEventLoopGapMs: number | null;
        }>,
    ) {
        super(message);
        this.name = 'SaveWitnessMatrixMeasuredError';
    }
}

const MIB = 1024 * 1024;

export async function identifySaveWitnessPdf(filePath: string) {
    const handle = await open(filePath, 'r');
    let validPdf = false;
    try {
        const {size} = await handle.stat();
        const header = Buffer.alloc(5);
        const tail = Buffer.alloc(Math.min(64, size));
        await handle.read(header, 0, header.length, 0);
        await handle.read(tail, 0, tail.length, Math.max(0, size - tail.length));
        validPdf = header.toString('ascii') === '%PDF-' && tail.toString('ascii').includes('%%EOF');
    } finally { await handle.close(); }
    return {
        ...await hashSaveWitnessFile(filePath),
        validPdf,
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
        // Size alone cannot identify fixtures made by the old timestamped generator.
        await generateLargePdfE2eFixture({
            outputPath,
            pageCount: 431,
            targetBytes: bytes,
        });
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
        const identity = await identifySaveWitnessPdf(path);
        if (identity.bytes !== bytes || !identity.validPdf) {
            throw new Error(`save-witness fixture ${id} failed exact-size or PDF validation`);
        }
        fixtures.push({
            id,
            path,
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
    const adversarial: ISaveWitnessMatrixAdversarial[] = [];
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
                    totalSaveLatencyMs: measurement.totalSaveLatencyMs ?? Date.now() - started,
                    readVolumeBytes: measurement.readVolumeBytes ?? null,
                    peakRssGrowthBytes: measurement.peakRssGrowthBytes ?? null,
                    workerEventLoopGapMs: measurement.workerEventLoopGapMs ?? null,
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
                peakRssGrowthBytes: null,
                workerEventLoopGapMs: null,
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
                peakRssGrowthBytes: null,
                workerEventLoopGapMs: null,
                cancellation: null,
                failure: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (adapter.runAdversarial) {
        for (const fixture of fixtures) adversarial.push(await adapter.runAdversarial(fixture));
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
        coverage: 'baseline capture and close -> identical external replacement -> stage edit -> current-path full comparison with held save handle -> publication authorization -> close and reopen. Witness seam only; no original-file writer is invoked.',
        cache: {
            mode: 'warm',
            coldObservation: 'Not measured: this harness has no portable cache-drop operation without elevated privileges.',
        },
        productionSavePathCost: 'Not included. Production save adds its own PDF serialization, publication, sidecar and recovery work. readVolumeBytes counts settled baseline and comparison reads; kernel copyFile I/O and separate fixture/original verification are excluded.',
        decisionScope: 'Research witness checks and measured warm-cache cost only. This is not a production publication qualification. Timed-out probes lose publication authority; their unique work directories are retained while issued OS I/O settles and closes. No cleanup or reuse occurs in those directories.',
        cells,
        adversarial,
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
        decision: report.cells.every(cell => cell.passed) && report.adversarial.length === report.fixtures.length
            && report.adversarial.every(cell => cell.passed) ? 'affirmative' : 'negative',
    };
    await writeFile(outputPath, JSON.stringify(reportForDisk, null, 2) + '\n', 'utf8');
}

export async function hashSaveWitnessFile(filePath: string, signal?: AbortSignal) {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream: AsyncIterable<Buffer> = createReadStream(filePath, {
        highWaterMark: SAVE_WITNESS_MATRIX_CHUNK_BYTES,
        ...(signal ? {signal} : {}),
    });
    for await (const chunk of stream) {
        bytes += chunk.length;
        hash.update(chunk);
    }
    return {
        bytes,
        sha256: hash.digest('hex'),
    };
}

// An expired operation loses publication authority immediately. An issued OS
// read may settle later; its owner still closes its handle in finally.
export async function withSaveWitnessDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    onDeadline: () => void = () => undefined,
) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            const error = new Error('save-witness probe exceeded the 120000ms hard stop');
            controller.abort(error);
            onDeadline();
            reject(error);
        }, SAVE_WITNESS_MATRIX_DEADLINE_MS);
    });
    try {
        return await Promise.race([
            operation(controller.signal),
            deadline,
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export function createResearchSaveWitnessMatrixAdapter(
    root: string,
    replace: (from: string, to: string) => Promise<void> = rename,
): ISaveWitnessMatrixAdapter {
    return {
        runCycle: async (fixture, cycle) => {
            await mkdir(root, {recursive: true});
            const source = join(root, `${fixture.id}-${cycle}.pdf`);
            await copyFile(fixture.path, source);
            const started = performance.now();
            let baselineCaptureMs: number | undefined;
            let readVolumeBytes = 0;
            const rssBefore = process.memoryUsage().rss;
            let peakRss = rssBefore;
            let lastTick = started;
            let workerEventLoopGapMs = 0;
            const sample = () => {
                const now = performance.now();
                workerEventLoopGapMs = Math.max(workerEventLoopGapMs, now - lastTick);
                lastTick = now;
                peakRss = Math.max(peakRss, process.memoryUsage().rss);
            };
            const timer = setInterval(sample, 10);
            const measurement = () => ({
                ...(baselineCaptureMs === undefined ? {} : {baselineCaptureMs}),
                totalSaveLatencyMs: performance.now() - started,
                readVolumeBytes,
                peakRssGrowthBytes: Math.max(0, peakRss - rssBefore),
                workerEventLoopGapMs,
            });
            try {
                await withSaveWitnessDeadline(async signal => {
                    const onRead = (bytes: number) => { readVolumeBytes += bytes; };
                    const baselineStarted = performance.now();
                    const baseline = await captureResearchFullContentWitness(source, {
                        signal,
                        onRead,
                    });
                    baselineCaptureMs = performance.now() - baselineStarted;
                    signal.throwIfAborted();
                    await copyFile(fixture.path, `${source}.replacement`);
                    signal.throwIfAborted();
                    await replace(`${source}.replacement`, source);
                    signal.throwIfAborted();
                    // The edit is staged independently of the original, as in a save transaction.
                    await copyFile(source, `${source}.edit`);
                    signal.throwIfAborted();
                    await appendFile(`${source}.edit`, '\n% matrix edit\n');
                    const save = await baseline.beginSave({
                        signal,
                        onRead,
                    });
                    try {
                        await save.assertPublicationAllowed();
                        signal.throwIfAborted();
                        // Publication authority is checked synchronously after the final await.
                        // No original-file writer is invoked by this research seam.
                    } finally {
                        await save.close();
                    }
                    signal.throwIfAborted();
                    const reopened = await open(source, 'r');
                    try { await reopened.stat(); } finally { await reopened.close(); }
                });
                sample();
                return {
                    ...measurement(),
                    baselineCaptureMs: baselineCaptureMs!,
                };
            } catch (error) {
                sample();
                throw new SaveWitnessMatrixMeasuredError(error instanceof Error ? error.message : String(error), measurement());
            } finally {
                clearInterval(timer);
            }
        },
        runCancellation: async fixture => {
            const source = join(root, `${fixture.id}-cancel.pdf`);
            const started = performance.now();
            const controller = new AbortController();
            let issuedReadBytes = 0;
            let issuedReads = 0;
            let readsAfterCancellation = 0;
            let readSettled = false;
            let readSettledBeforeRejection = false;
            let rejected = false;
            let hardStopTriggered = false;
            let published = false;
            let originalPreserved = false;
            let failure: string | null = null;
            try {
                await withSaveWitnessDeadline(async deadlineSignal => {
                    await mkdir(root, {recursive: true});
                    deadlineSignal.throwIfAborted();
                    await copyFile(fixture.path, source);
                    deadlineSignal.throwIfAborted();
                    const baseline = await captureResearchFullContentWitness(source, {signal: deadlineSignal});
                    const signal = AbortSignal.any([
                        controller.signal,
                        deadlineSignal,
                    ]);
                    try {
                        const save = await baseline.beginSave({
                            signal,
                            onReadIssued: () => {
                                if (controller.signal.aborted) readsAfterCancellation += 1;
                                issuedReads += 1;
                                controller.abort(new Error('matrix cancellation during issued read'));
                            },
                            onRead: bytes => { issuedReadBytes += bytes; readSettled = true; },
                        });
                        try {
                            await save.assertPublicationAllowed();
                            signal.throwIfAborted();
                            // This is the synchronous handoff to a writer, never reached on abort.
                            published = true;
                        } finally { await save.close(); }
                    } catch (error) {
                        rejected = controller.signal.aborted && error === controller.signal.reason;
                        readSettledBeforeRejection = readSettled;
                        if (!rejected) throw error;
                    }
                    deadlineSignal.throwIfAborted();
                    const after = await hashSaveWitnessFile(source, deadlineSignal);
                    deadlineSignal.throwIfAborted();
                    originalPreserved = after.sha256 === baseline.baselineSha256 && after.bytes === baseline.baselineBytes;
                }, () => { hardStopTriggered = true; });
            } catch (error) { failure = error instanceof Error ? error.message : String(error); }
            const durationMs = performance.now() - started;
            const passed = rejected && readSettledBeforeRejection && issuedReads === 1
                && readsAfterCancellation === 0 && !published && originalPreserved
                && !hardStopTriggered && durationMs < SAVE_WITNESS_MATRIX_DEADLINE_MS;
            return {
                passed,
                issuedReadBytes,
                readsAfterCancellation,
                published,
                originalPreserved,
                durationMs,
                readSettledBeforeRejection,
                singleReadIsWholeFile: issuedReads === 1 && issuedReadBytes === fixture.bytes,
                hardStop: {
                    deadlineMs: SAVE_WITNESS_MATRIX_DEADLINE_MS,
                    armed: true,
                    triggered: hardStopTriggered,
                    settledWithinDeadline: durationMs < SAVE_WITNESS_MATRIX_DEADLINE_MS,
                },
                failure: passed ? null : failure ?? 'cancellation contract failed',
            };
        },
        runAdversarial: async fixture => {
            const source = join(root, `${fixture.id}-held-save.pdf`);
            let replacementOutcome: ISaveWitnessMatrixAdversarial['replacementOutcome'] = 'not-attempted';
            let replacementError: string | null = null;
            let publicationApproved = false;
            let rejection: string | null = null;
            const controller = new AbortController();
            let originalPreserved = false;
            let hardStopTriggered = false;
            try {
                await withSaveWitnessDeadline(async deadlineSignal => {
                    await copyFile(fixture.path, source);
                    deadlineSignal.throwIfAborted();
                    await copyFile(fixture.path, `${source}.replacement`);
                    const baseline = await captureResearchFullContentWitness(source, {signal: deadlineSignal});
                    const save = await baseline.beginSave({signal: AbortSignal.any([
                        controller.signal,
                        deadlineSignal,
                    ])});
                    try {
                        try {
                            await replace(`${source}.replacement`, source);
                            replacementOutcome = 'replaced';
                        } catch (error) {
                            replacementOutcome = 'refused';
                            replacementError = error instanceof Error ? error.message : String(error);
                            // The external replacement failure aborts this adversarial transaction.
                            controller.abort(error);
                        }
                        try {
                            await save.assertPublicationAllowed();
                            deadlineSignal.throwIfAborted();
                            publicationApproved = true;
                        } catch (error) { rejection = error instanceof Error ? error.message : String(error); }
                    } finally { await save.close(); }
                    deadlineSignal.throwIfAborted();
                    const current = await hashSaveWitnessFile(source, deadlineSignal);
                    deadlineSignal.throwIfAborted();
                    originalPreserved = current.sha256 === baseline.baselineSha256 && current.bytes === baseline.baselineBytes;
                }, () => { hardStopTriggered = true; });
            } catch (error) { rejection = error instanceof Error ? error.message : String(error); }
            const passed = !hardStopTriggered && replacementOutcome !== 'not-attempted' && !publicationApproved && rejection !== null && originalPreserved;
            return {
                fixtureId: fixture.id,
                passed,
                replacementOutcome,
                replacementError,
                hardStopTriggered,
                publicationApproved,
                originalPreserved,
                failure: passed ? null : rejection ?? 'publication approved after held-handle replacement',
            };
        },
    };
}
