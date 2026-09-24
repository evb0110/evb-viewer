import {createHash} from 'node:crypto';
import {
    copyFile,
    mkdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import type {TPerformanceMode} from '@contracts/hostResourceProfile';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {startConfiguredElectronE2ESession as startConfiguredSession} from '@tests/e2e/electron/helpers/startConfiguredElectronE2ESession';
import {
    openAnnotationsTab,
    openPdfInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForNoOpenNoteWindows} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    callWorkspaceCommand,
    waitForSaveFrontierReady,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {readPdfAnnotationSummary} from '@tests/e2e/electron/helpers/fixtures';

const execFileAsync = promisify(execFile);
const benchmarkFixture = process.env.EVB_SAVE_PIPELINE_BENCHMARK_FIXTURE;
const benchmarkOutput = process.env.EVB_SAVE_PIPELINE_BENCHMARK_OUTPUT;
const benchmarkTier = process.env.EVB_SAVE_PIPELINE_BENCHMARK_TIER;
const benchmarkDescribe = benchmarkFixture && benchmarkOutput ? describe : describe.skip;
const SAVE_TIMEOUT_MS = 120_000;

function parsePositiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values: number[], fraction: number) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function installNativeProjectionProbe(page: Page) {
    await page.evaluate(() => {
        document.documentElement.dataset.evbNativeProjectionEngaged = 'false';
        window.__stagedPdfNativeMutationCommitBarrierForAutomation = async () => {
            document.documentElement.dataset.evbNativeProjectionEngaged = 'true';
        };
    });
}

async function runSave(
    page: Page,
    path: string,
    text: string,
    electronPid: number | null,
) {
    const position = {
        x: 0.27,
        y: 0.28,
    };
    const created = await callWorkspaceCommand<boolean>(page, 'commentAtPoint', [
        1,
        position.x,
        position.y,
        {preferTextAnchor: false},
    ]);
    expect(created).toEqual({
        called: true,
        value: true,
    });
    await page.waitForSelector('textarea.note-window__textarea', {timeout: 20_000});
    await page.evaluate((noteText: string) => {
        const textarea = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
            'textarea.note-window__textarea',
        )).at(-1);
        if (!textarea) {
            throw new Error('Benchmark note editor did not open');
        }
        const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
        )?.set;
        setter?.call(textarea, noteText);
        textarea.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: noteText,
            inputType: 'insertText',
        }));
        textarea.dispatchEvent(new Event('change', {bubbles: true}));
        textarea.dispatchEvent(new Event('blur', {bubbles: true}));
    }, text);
    await waitForWorkspaceToolbarIdle(page, {timeoutMs: 20_000});
    await waitForSaveFrontierReady(page);
    const beforeBytes = (await stat(path)).size;
    const timestamp = new Date().toISOString();
    let sampling = true;
    let peakRssBytes = await readResidentBytes(electronPid);
    const rssSampler = (async () => {
        while (sampling) {
            await new Promise(resolve => setTimeout(resolve, 50));
            if (!sampling) {
                break;
            }
            const rssBytes = await readResidentBytes(electronPid);
            if (rssBytes !== null) {
                peakRssBytes = Math.max(peakRssBytes ?? 0, rssBytes);
            }
        }
    })();
    const startedAt = performance.now();
    let durationMs = 0;
    try {
        const result = await callWorkspaceCommand<boolean>(page, 'handleSave');
        expect(result).toEqual({
            called: true,
            value: true,
        });
        await waitForWorkspaceToolbarIdle(page, {timeoutMs: SAVE_TIMEOUT_MS});
        await waitForViewerInteractive(page, SAVE_TIMEOUT_MS);
        durationMs = performance.now() - startedAt;
    } finally {
        sampling = false;
        await rssSampler;
    }
    const afterBytes = (await stat(path)).size;
    await page.keyboard.press('Escape');
    await waitForNoOpenNoteWindows(page);
    const closed = await callWorkspaceCommand<boolean>(page, 'handleCloseFileFromUi', [{persist: false}]);
    expect(closed).toEqual({
        called: true,
        value: true,
    });
    return {
        afterBytes,
        beforeBytes,
        durationMs,
        peakRssBytes,
        timestamp,
    };
}

async function readResidentBytes(pid: number | null) {
    if (!pid || process.platform === 'win32') {
        return null;
    }
    try {
        const {stdout} = await execFileAsync('ps', [
            '-o',
            'rss=',
            '-p',
            String(pid),
        ], {encoding: 'utf8'});
        const kib = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(kib) ? kib * 1024 : null;
    } catch {
        return null;
    }
}

benchmarkDescribe('Electron E2E - save pipeline benchmark', () => {
    it('records repeated real-app saves in an isolated headless session', async () => {
        const mode = 'native-freetext';
        const tier: TPerformanceMode = benchmarkTier === 'low'
            ? 'low'
            : 'high';
        const warmups = parsePositiveInteger(
            process.env.EVB_SAVE_PIPELINE_BENCHMARK_WARMUPS,
            5,
        );
        const iterations = parsePositiveInteger(
            process.env.EVB_SAVE_PIPELINE_BENCHMARK_ITERATIONS,
            10,
        );
        const fixturePath = benchmarkFixture!;
        const outputPath = benchmarkOutput!;
        const workingFixture = `${outputPath}.${mode}-${tier}.pdf`;
        await mkdir(dirname(outputPath), {recursive: true});
        const inputBytes = (await stat(fixturePath)).size;
        const sourceSemanticReopen = await readPdfAnnotationSummary(fixturePath);
        const session = await startConfiguredSession(
            `e2e-save-benchmark-${mode}-${tier}-${Date.now()}`,
            tier,
            {EVB_LARGE_PDF_SAVE_OPTIMIZE_MIN_BYTES: '1'},
        );
        try {
            await session.page.waitForFunction(
                (expectedTier: TPerformanceMode) => (
                    document.documentElement.classList.contains(`performance-tier-${expectedTier}`)
                ),
                {timeout: SAVE_TIMEOUT_MS},
                tier,
            );
            const hostProfile = await session.page.evaluate(() => (
                window.electronAPI?.host.getResourceProfile() ?? null
            ));
            if (hostProfile) {
                expect(hostProfile).toMatchObject({tier});
            }
            const totalRuns = warmups + iterations;
            const timings: number[] = [];
            const iterationMeasurements = [];
            let peakRssBytes: number | null = null;
            const electronPid = getSessionInfo(session.name)?.electronPid ?? null;
            for (let index = 0; index < totalRuns; index += 1) {
                const runFixture = index === totalRuns - 1
                    ? workingFixture
                    : `${workingFixture}.${String(index)}.pdf`;
                await copyFile(fixturePath, runFixture);
                await openPdfInApp(session.page, runFixture, SAVE_TIMEOUT_MS);
                await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
                await openAnnotationsTab(session.page, SAVE_TIMEOUT_MS);
                await installNativeProjectionProbe(session.page);
                const measurement = await runSave(
                    session.page,
                    runFixture,
                    'save-benchmark-freetext',
                    electronPid,
                );
                const nativeProjectionEngaged = await session.page.evaluate(
                    () => document.documentElement.dataset.evbNativeProjectionEngaged === 'true',
                );
                expect(nativeProjectionEngaged).toBe(true);
                if (measurement.peakRssBytes !== null) {
                    peakRssBytes = Math.max(peakRssBytes ?? 0, measurement.peakRssBytes);
                }
                if (index >= warmups) {
                    timings.push(measurement.durationMs);
                    iterationMeasurements.push({
                        iteration: index - warmups + 1,
                        ...measurement,
                    });
                }
                if (runFixture !== workingFixture) {
                    await rm(runFixture, {force: true});
                }
            }
            const outputBytes = await readFile(workingFixture);
            const semanticReopen = await readPdfAnnotationSummary(workingFixture);
            const result = {
                schemaVersion: 1,
                scenario: `${mode}-${tier}`,
                mode,
                annotationAction: 'page-note',
                tier,
                hostProfile,
                fixturePath,
                inputPath: fixturePath,
                outputPath: workingFixture,
                warmups,
                iterations,
                iterationMeasurements,
                totalMs: {
                    p50: percentile(timings, 0.5),
                    p95: percentile(timings, 0.95),
                    samples: timings,
                },
                peakRssBytes,
                ioBytes: {
                    logicalRead: null,
                    logicalWritten: null,
                    physicalRead: null,
                    physicalWritten: null,
                },
                phaseTimingsMs: {
                    baseHash: null,
                    cloneOrCopy: null,
                    conflictCheck: null,
                    expectationRefresh: null,
                    fileSync: null,
                    historyReload: null,
                    pdfJsSemanticReopen: null,
                    qpdf: null,
                    rustLoad: null,
                    rustReopen: null,
                    rustTail: null,
                    targetedValidation: null,
                },
                inputBytes,
                outputBytes: outputBytes.byteLength,
                outputSha256: createHash('sha256').update(outputBytes).digest('hex'),
                sourceSemanticReopen,
                semanticReopen,
            };
            await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
        } finally {
            await session.stop();
        }
    }, 30 * 60_000);
});
