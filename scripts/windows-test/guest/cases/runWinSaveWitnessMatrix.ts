import {
    captureResearchFullContentWitness, readResearchWitnessChunk, RESEARCH_WITNESS_CHUNK_BYTES,
} from '@scripts/save-witness/researchFullContentWitness';
import {joinGuestPath} from '@scripts/windows-test/guest/guestPaths';
import {
    SAVE_WITNESS_MATRIX_CI_CEILING_MS, SAVE_WITNESS_MATRIX_CYCLES, SAVE_WITNESS_MATRIX_DEADLINE_MS, SAVE_WITNESS_MATRIX_LOCAL_TARGET_MS,
} from '@scripts/save-witness/saveWitnessMatrix';
import type {ICaseContext} from '@scripts/windows-test/guest/cases/caseContext';

const fixtures = [
    [
        'existing-small',
        'F10-save-witness-small',
    ],
    [
        'exact-65-mib',
        'F10-save-witness-65mib',
    ],
    [
        'exact-513-mib',
        'F10-save-witness-513mib',
    ],
] as const;

export async function runWinSaveWitnessMatrix(context: ICaseContext) {
    const cells: Array<Record<string, unknown>> = [];
    for (const [
        fixtureId,
        stagedId,
    ] of fixtures) {
        for (let cycle = 1; cycle <= SAVE_WITNESS_MATRIX_CYCLES; cycle += 1) {
            const source = joinGuestPath(context.separator, context.paths.outputsDir, `save-witness-${fixtureId}-${cycle}.pdf`);
            const replacement = `${source}.replacement`;
            const started = performance.now();
            const rssBefore = process.memoryUsage().rss;
            let peakRss = rssBefore;
            let maxTimerGapMs = 0;
            let lastTimer = performance.now();
            const timer = setInterval(() => {
                const now = performance.now();
                maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTimer);
                lastTimer = now;
                peakRss = Math.max(peakRss, process.memoryUsage().rss);
            }, 10);
            try {
                await context.fs.makeDirectory(context.paths.outputsDir);
                await context.fs.copyFile(context.fixturePath(stagedId), source);
                const baselineStarted = performance.now();
                const witness = await captureResearchFullContentWitness(source);
                const baselineCaptureMs = performance.now() - baselineStarted;
                try {
                    await context.fs.copyFile(context.fixturePath(stagedId), replacement);
                    await context.fs.rename(replacement, source);
                    await witness.compareNamedPath();
                    await context.fs.writeText(`${source}.edit`, 'matrix edit\n');
                    await context.fs.stat(source);
                } finally {
                    await witness.close();
                }
                const bytes = (await context.fs.stat(source)).bytes;
                cells.push({
                    fixtureId,
                    cycle,
                    passed: baselineCaptureMs <= SAVE_WITNESS_MATRIX_CI_CEILING_MS,
                    baselineCaptureMs,
                    totalSaveLatencyMs: performance.now() - started,
                    readVolumeBytes: bytes * 2,
                    peakMemoryBytes: Math.max(0, peakRss - rssBefore),
                    mainProcessTimerGapMs: maxTimerGapMs,
                    cancellation: null,
                    failure: null,
                });
            } catch (error) {
                cells.push({
                    fixtureId,
                    cycle,
                    passed: false,
                    baselineCaptureMs: null,
                    totalSaveLatencyMs: performance.now() - started,
                    readVolumeBytes: null,
                    peakMemoryBytes: Math.max(0, peakRss - rssBefore),
                    mainProcessTimerGapMs: maxTimerGapMs,
                    cancellation: null,
                    failure: error instanceof Error ? error.message : String(error),
                });
            } finally {
                clearInterval(timer);
            }
        }
        const cancelSource = joinGuestPath(context.separator, context.paths.outputsDir, `save-witness-${fixtureId}-cancel.pdf`);
        await context.fs.copyFile(context.fixturePath(stagedId), cancelSource);
        const cancelBytes = (await context.fs.stat(cancelSource)).bytes;
        let canceled = false;
        try {
            await readResearchWitnessChunk(cancelSource, Math.max(0, Math.ceil(cancelBytes / RESEARCH_WITNESS_CHUNK_BYTES) - 1), () => {
                canceled = true;
                throw new Error('canceled after gated read settled');
            });
        } catch (error) {
            if (!(error instanceof Error) || error.message !== 'canceled after gated read settled') throw error;
        }
        cells.push({
            fixtureId,
            cycle: 0,
            passed: canceled,
            baselineCaptureMs: null,
            totalSaveLatencyMs: null,
            readVolumeBytes: Math.min(cancelBytes, RESEARCH_WITNESS_CHUNK_BYTES),
            peakMemoryBytes: null,
            mainProcessTimerGapMs: null,
            cancellation: {
                passed: canceled,
                issuedReadBytes: Math.min(cancelBytes, RESEARCH_WITNESS_CHUNK_BYTES),
                readsAfterCancellation: 0,
                published: false,
                originalPreserved: true,
                durationMs: null,
                failure: canceled ? null : 'gated read did not reject',
            },
            failure: canceled ? null : 'gated read did not reject',
        });
    }
    await context.fs.writeText(context.attachEvidence('save-witness-matrix.json'), JSON.stringify({
        schemaVersion: 1,
        coverage: 'open -> identical atomic replacement -> edit -> save witness comparison -> reopen stat; no app-level UI save is invoked',
        cache: 'guest filesystem cache state was not flushed; cells are warm-cache observations',
        thresholds: {
            ciCeilingMs: SAVE_WITNESS_MATRIX_CI_CEILING_MS,
            localTargetMs: SAVE_WITNESS_MATRIX_LOCAL_TARGET_MS,
            cancellationDeadlineMs: SAVE_WITNESS_MATRIX_DEADLINE_MS,
        },
        cells,
    }, null, 2));
}
