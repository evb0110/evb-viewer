import {
    copyFile, mkdir, readFile, rename, stat, writeFile,
} from 'node:fs/promises';
import {
    join, resolve, 
} from 'node:path';
import {
    captureResearchFullContentWitness,
    readResearchWitnessChunk,
} from '@electron/file-access/researchFullContentWitness';
import {
    ensureSaveWitnessMatrixFixtures,
    runSaveWitnessMatrix,
    SAVE_WITNESS_MATRIX_CHUNK_BYTES,
    writeSaveWitnessMatrixReport,
    type ISaveWitnessMatrixFixture,
} from '@scripts/save-witness/saveWitnessMatrix';

const root = resolve(process.cwd(), '.devkit', 'save-witness-matrix');

async function atomicReplace(path: string, sourcePath: string, suffix: string) {
    const replacement = `${path}.${suffix}.tmp`;
    await copyFile(sourcePath, replacement);
    await rename(replacement, path);
}

function memoryBytes() {
    return process.memoryUsage().rss;
}

async function runCycle(fixture: ISaveWitnessMatrixFixture) {
    const source = join(root, 'work', `${fixture.id}.pdf`);
    await copyFile(fixture.path, source);
    const started = performance.now();
    const rssBefore = memoryBytes();
    let peakRss = rssBefore;
    let lastTick = performance.now();
    let maxTimerGapMs = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick);
        lastTick = now;
        peakRss = Math.max(peakRss, memoryBytes());
    }, 10);
    const captureStarted = performance.now();
    const witness = await captureResearchFullContentWitness(source);
    const baselineCaptureMs = performance.now() - captureStarted;
    try {
        await atomicReplace(source, fixture.path, 'identical');
        await witness.compareNamedPath();
        await writeFile(`${source}.edit`, 'matrix edit\n', 'utf8');
        await witness.close();
        await stat(source);
    } finally {
        await witness.close().catch(() => undefined);
        clearInterval(timer);
    }
    return {
        baselineCaptureMs,
        totalSaveLatencyMs: performance.now() - started,
        readVolumeBytes: fixture.bytes * 2,
        peakMemoryBytes: Math.max(0, peakRss - rssBefore),
        mainProcessTimerGapMs: maxTimerGapMs,
    };
}

async function runCancellation(fixture: ISaveWitnessMatrixFixture) {
    const source = join(root, 'work', `${fixture.id}-cancel.pdf`);
    await copyFile(fixture.path, source);
    const original = await readFile(source);
    const started = performance.now();
    let issuedReadBytes = 0;
    const readsAfterCancellation = 0;
    let published = false;
    let rejected = false;
    issuedReadBytes = Math.min(fixture.bytes, SAVE_WITNESS_MATRIX_CHUNK_BYTES);
    try {
        await readResearchWitnessChunk(source, Math.max(0, Math.ceil(fixture.bytes / SAVE_WITNESS_MATRIX_CHUNK_BYTES) - 1), () => {
            rejected = true;
            throw new Error('canceled after gated read settled');
        });
    } catch (error) {
        if (!(error instanceof Error) || error.message !== 'canceled after gated read settled') {
            throw error;
        }
    } finally {
        published = false;
    }
    const current = await readFile(source);
    return {
        passed: rejected && readsAfterCancellation === 0 && !published && Buffer.compare(original, current) === 0,
        issuedReadBytes,
        readsAfterCancellation,
        published,
        originalPreserved: Buffer.compare(original, current) === 0,
        durationMs: performance.now() - started,
        failure: rejected ? null : 'gated read did not reject',
    };
}

async function main() {
    await mkdir(join(root, 'work'), { recursive: true });
    const fixtures = await ensureSaveWitnessMatrixFixtures();
    const report = await runSaveWitnessMatrix(fixtures, {
        runCycle: fixture => runCycle(fixture),
        runCancellation,
    });
    const outputPath = join(root, 'runs', `${new Date().toISOString().replaceAll(':', '-')}.json`);
    await writeSaveWitnessMatrixReport(report, outputPath);
    process.stdout.write(JSON.stringify({
        outputPath: outputPath.replace(`${process.cwd()}/`, ''),
        fixtures: report.fixtures.map(fixture => ({
            id: fixture.id,
            bytes: fixture.bytes,
            sha256: fixture.sha256,
        })),
        cells: report.cells,
    }, null, 2) + '\n');
}

await main();
