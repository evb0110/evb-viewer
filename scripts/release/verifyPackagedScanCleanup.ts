import {
    execFile,
    spawn,
} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
    copyFile,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import puppeteer from 'puppeteer-core';
import type {
    Browser,
    Page,
} from 'puppeteer-core';
import {
    collectDescendantPidsUnix,
    findFreePort,
    isProcessAlive,
    killPids,
} from '@scripts/electron-run/electronRunProcessTree';
import {preparePackagedAutomationLaunch} from '@scripts/release/preparePackagedAutomationLaunch';
import {
    evaluateInPage,
    installPageEvaluationShims,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {IWorkspaceExposeProbeWindow} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    waitForPackagedCdpEndpoint,
    waitForPackagedRendererPage,
} from '@scripts/release/waitForPackagedCdpEndpoint';

const STARTUP_TIMEOUT_MS = 90_000;
const DETECTION_TIMEOUT_MS = 30 * 60_000;
const CLEANUP_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_EXPECTED_PAGE_COUNT = 392;
const execFileAsync = promisify(execFile);

interface IArguments {
    auditSourcePath: string | null;
    artifactDir: string;
    expectedPageCount: number;
    executablePath: string;
    referenceMetadataDir: string | null;
    scaleOnly: boolean;
    sourcePath: string;
    sourcePages: string | null;
    syntheticSpecPath: string | null;
}

interface IDetectionSample {
    completed: number;
    pendingThumbnails: number;
    text: string;
    total: number;
}

interface IGeometryRect {
    height: number;
    top: number;
}

interface IGeometry {
    host: IGeometryRect | null;
    shell: IGeometryRect | null;
    toolbar: IGeometryRect | null;
    workspace: IGeometryRect | null;
}

interface IGeometrySample {
    kind: 'cleanup' | 'pdf';
    value: IGeometry;
}

interface IResourceSample {
    processCount: number;
    rssBytes: number;
    timestampMs: number;
}

interface INewTabEvidence {
    activeTabIdAfter: string;
    activeTabIdBefore: string;
    emptyStateVisible: boolean;
    tabCountAfter: number;
    tabCountBefore: number;
}

interface IQueuedCleanupEvidence {
    completedAfterCancel: number;
    completedBeforeClick: number;
    detectionContinuedAfterCancel: boolean;
    queuedStatusText: string;
}

async function sha256(filePath: string) {
    const digest = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const input = createReadStream(filePath);
        input.on('data', chunk => digest.update(chunk));
        input.once('error', reject);
        input.once('end', resolve);
    });
    return digest.digest('hex');
}

async function preserveFinalPdfIdentity(
    args: IArguments,
    sourcePath: string,
    outputPath: string,
) {
    const [
        pdfImages,
        pdfInfo,
        executableSha256,
        outputSha256,
        sourceSha256,
    ] = await Promise.all([
        execFileAsync('pdfimages', [
            '-list',
            outputPath,
        ]),
        execFileAsync('pdfinfo', [
            '-f',
            '1',
            '-l',
            String(args.expectedPageCount),
            '-box',
            outputPath,
        ]),
        sha256(args.executablePath),
        sha256(outputPath),
        sha256(sourcePath),
    ]);
    await Promise.all([
        writeFile(
            path.join(args.artifactDir, 'pdfimages-list.txt'),
            pdfImages.stdout,
        ),
        writeFile(
            path.join(args.artifactDir, 'pdfinfo-box.txt'),
            pdfInfo.stdout,
        ),
        writeFile(
            path.join(args.artifactDir, 'checksums.json'),
            `${JSON.stringify({
                executable: {
                    path: args.executablePath,
                    sha256: executableSha256,
                },
                outputPdf: {
                    path: outputPath,
                    sha256: outputSha256,
                },
                sourcePdf: {
                    path: sourcePath,
                    sha256: sourceSha256,
                },
            }, null, 2)}\n`,
        ),
    ]);
}

async function sampleProcessTreeRss(rootPid: number): Promise<IResourceSample> {
    const pids = [
        rootPid,
        ...collectDescendantPidsUnix(rootPid),
    ].filter((pid, index, values) => values.indexOf(pid) === index);
    const {stdout} = await execFileAsync('/bin/ps', [
        '-o',
        'rss=',
        '-p',
        pids.join(','),
    ]);
    const rssKilobytes = stdout
        .split(/\s+/u)
        .map(value => Number.parseInt(value, 10))
        .filter(Number.isFinite)
        .reduce((sum, value) => sum + value, 0);
    return {
        processCount: pids.length,
        rssBytes: rssKilobytes * 1024,
        timestampMs: Date.now(),
    };
}

function parseArguments(argv: string[]): IArguments {
    const value = (name: string) => {
        const index = argv.indexOf(name);
        const result = index >= 0 ? argv[index + 1] : undefined;
        if (!result) {
            throw new Error(
                'Usage: verifyPackagedScanCleanup.ts '
                + '--executable <path> --source <pdf> --artifact-dir <directory>',
            );
        }
        return path.resolve(result);
    };
    const expectedPageCountIndex = argv.indexOf('--expected-pages');
    const expectedPageCount = expectedPageCountIndex >= 0
        ? Number.parseInt(argv[expectedPageCountIndex + 1] ?? '', 10)
        : DEFAULT_EXPECTED_PAGE_COUNT;
    if (!Number.isInteger(expectedPageCount) || expectedPageCount < 1) {
        throw new Error('--expected-pages must be a positive integer');
    }
    const optionalValue = (name: string) => {
        const index = argv.indexOf(name);
        if (index < 0) {
            return null;
        }
        const result = argv[index + 1];
        if (!result) {
            throw new Error(`Missing value for ${name}`);
        }
        return path.resolve(result);
    };
    const optionalRawValue = (name: string) => {
        const index = argv.indexOf(name);
        if (index < 0) {
            return null;
        }
        const result = argv[index + 1];
        if (!result) {
            throw new Error(`Missing value for ${name}`);
        }
        return result;
    };
    const sourcePages = optionalRawValue('--source-pages');
    if (sourcePages) {
        const pages = sourcePages
            .split(',')
            .map(value => Number.parseInt(value.trim(), 10));
        if (
            pages.length !== expectedPageCount
            || pages.some(page => !Number.isInteger(page) || page < 1)
        ) {
            throw new Error(
                '--source-pages must contain one positive source page per expected output page',
            );
        }
    }
    const result = {
        auditSourcePath: optionalValue('--audit-source'),
        artifactDir: value('--artifact-dir'),
        expectedPageCount,
        executablePath: value('--executable'),
        referenceMetadataDir: optionalValue('--reference-metadata-dir'),
        scaleOnly: argv.includes('--scale-only'),
        sourcePath: value('--source'),
        sourcePages,
        syntheticSpecPath: optionalValue('--synthetic-spec'),
    };
    if ((result.auditSourcePath === null) !== (result.sourcePages === null)) {
        throw new Error('--audit-source and --source-pages must be provided together');
    }
    if (!result.scaleOnly && !result.referenceMetadataDir) {
        throw new Error(
            '--reference-metadata-dir is required for final artifact verification',
        );
    }
    return result;
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await delay(100);
    }
    return !isProcessAlive(pid);
}

async function waitForProcessTreeExit(pids: number[], timeoutMs: number) {
    const uniquePids = [...new Set(pids)];
    const results = await Promise.all(uniquePids.map(pid => waitForProcessExit(pid, timeoutMs)));
    return results.every(Boolean);
}

async function detectionSample(page: Page): Promise<IDetectionSample | null> {
    return evaluateInPage(page, () => {
        const status = document.querySelector<HTMLElement>('.scan-cleanup-toolbar-count');
        const text = status?.getAttribute('aria-label') ?? status?.textContent ?? '';
        // The counter copy is localized prose ("2 of 4 pages"), not a fixed
        // "2 / 4"; accept any non-digit separator between the two counts.
        const match = /(\d+)\D+(\d+)/u.exec(text);
        if (!match) {
            return null;
        }
        return {
            completed: Number(match[1]),
            pendingThumbnails: document.querySelectorAll(
                '.scan-thumbnail-detection-pending',
            ).length,
            text: text.trim(),
            total: Number(match[2]),
        };
    });
}

async function waitForCompleteDetection(page: Page, expectedPageCount: number) {
    const samples: IDetectionSample[] = [];
    let lastCompleted = -1;
    const deadline = Date.now() + DETECTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const sample = await detectionSample(page);
        if (sample && sample.completed !== lastCompleted) {
            if (sample.completed < lastCompleted) {
                throw new Error(
                    `Detection counter moved backward: ${lastCompleted} -> ${sample.completed}`,
                );
            }
            if (sample.total !== expectedPageCount) {
                throw new Error(
                    `Detection counter total is ${sample.total}; expected ${expectedPageCount}`,
                );
            }
            samples.push(sample);
            lastCompleted = sample.completed;
        }
        const state = await evaluateInPage(page, () => ({
            actionEnabled: document.querySelector<HTMLButtonElement>(
                '.scan-cleanup-toolbar-primary-action',
            )?.disabled === false,
            cancelVisible: document.querySelector(
                '.scan-cleanup-toolbar-cancel-detection',
            ) !== null,
            pendingThumbnails: document.querySelectorAll(
                '.scan-thumbnail-detection-pending',
            ).length,
        }));
        if (
            !state.cancelVisible
            && state.actionEnabled
            && lastCompleted >= 0
            && state.pendingThumbnails === 0
        ) {
            return samples;
        }
        await delay(200);
    }
    throw new Error(
        `Packaged detection did not reach ${expectedPageCount}/${expectedPageCount}; `
        + `last completed count was ${lastCompleted}`,
    );
}

async function verifyCleanupQueuedDuringDetection(
    page: Page,
    expectedPageCount: number,
): Promise<IQueuedCleanupEvidence> {
    await waitForFunctionInPage(page, (expected: number) => {
        const action = document.querySelector<HTMLButtonElement>(
            '.scan-cleanup-toolbar-primary-action',
        );
        const status = document.querySelector<HTMLElement>('.scan-cleanup-toolbar-count');
        const text = status?.getAttribute('aria-label') ?? status?.textContent ?? '';
        // The counter copy is localized prose ("2 of 4 pages"), not a fixed
        // "2 / 4"; accept any non-digit separator between the two counts.
        const match = /(\d+)\D+(\d+)/u.exec(text);
        return action?.disabled === false
            && document.querySelector('.scan-cleanup-toolbar-cancel-detection') !== null
            && match !== null
            && Number(match[2]) === expected
            && Number(match[1]) < expected;
    }, {timeout: STARTUP_TIMEOUT_MS}, expectedPageCount);
    const before = await detectionSample(page);
    if (!before) {
        throw new Error('Packaged queued-cleanup verification found no detection counter');
    }

    await page.click('.scan-cleanup-toolbar-primary-action');
    // The redesigned run meter (#70) renders its status as child text spans
    // instead of an aria-valuetext attribute.
    await waitForFunctionInPage(page, () => {
        const meter = document.querySelector<HTMLElement>('.scan-cleanup-run-meter');
        const action = document.querySelector<HTMLButtonElement>(
            '.scan-cleanup-toolbar-primary-action',
        );
        return meter !== null
            && meter.textContent.trim().length > 0
            && action?.disabled === false;
    }, {timeout: 10_000});
    const queuedStatusText = await evaluateInPage(page, () =>
        document.querySelector<HTMLElement>('.scan-cleanup-run-meter')
            ?.textContent.trim() ?? '');
    if (!queuedStatusText.toLowerCase().includes('pre-analyzing')) {
        throw new Error(
            `Cleanup click did not expose a queued pre-analysis state: "${queuedStatusText}"`,
        );
    }

    await page.click('.scan-cleanup-toolbar-primary-action');
    await waitForFunctionInPage(page, () => (
        document.querySelector('.scan-cleanup-run-meter') === null
        && document.querySelector('.scan-cleanup-toolbar-cancel-detection') !== null
    ), {timeout: 10_000});
    const after = await detectionSample(page);
    if (!after) {
        throw new Error('Pre-analysis disappeared after canceling queued cleanup');
    }
    const evidence = {
        completedAfterCancel: after.completed,
        completedBeforeClick: before.completed,
        detectionContinuedAfterCancel: after.total === expectedPageCount,
        queuedStatusText,
    };
    console.log(
        'Packaged verification stage: cleanup queued and canceled during pre-analysis '
        + 'without canceling detection',
    );
    return evidence;
}

async function sampleGeometry(page: Page): Promise<IGeometry> {
    return evaluateInPage(page, () => {
        const shell = document.querySelector<HTMLElement>('.editor-global-toolbar-shell');
        const host = document.querySelector<HTMLElement>('.editor-global-toolbar-host');
        const toolbar = host?.querySelector<HTMLElement>(':scope > .toolbar');
        const workspace = document.querySelector<HTMLElement>('.workspace-main-shell');
        const rect = (element: HTMLElement | null | undefined) => {
            const bounds = element?.getBoundingClientRect();
            return bounds
                ? {
                    height: Math.round(bounds.height * 100) / 100,
                    top: Math.round(bounds.top * 100) / 100,
                }
                : null;
        };
        return {
            host: rect(host),
            shell: rect(shell),
            toolbar: rect(toolbar),
            workspace: rect(workspace),
        };
    });
}

async function activatePane(page: Page, paneId: string, toolbarSelector: string) {
    await evaluateInPage(page, (targetPaneId: string) => {
        const pane = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane'))
            .find(candidate => candidate.dataset.editorPaneId === targetPaneId);
        pane?.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            pointerId: 1,
        }));
        return pane !== undefined;
    }, paneId);
    await waitForFunctionInPage(page, (
        targetPaneId: string,
        targetToolbarSelector: string,
    ) => (
        document.querySelector<HTMLElement>('.editor-pane.is-active')
            ?.dataset.editorPaneId === targetPaneId
        && document.querySelector(targetToolbarSelector) !== null
    ), {timeout: 30_000}, paneId, toolbarSelector);
    await evaluateInPage(page, () => new Promise<boolean>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    }));
}

async function verifyPaneGeometry(page: Page, sourcePath: string) {
    const cleanupPaneId = await evaluateInPage(page, () =>
        document.querySelector<HTMLElement>('.editor-pane.is-active')
            ?.dataset.editorPaneId ?? null);
    if (!cleanupPaneId) {
        throw new Error('Packaged cleanup pane has no editor-pane identity');
    }
    const splitCreated = await evaluateInPage(page, async () => {
        const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
        if (!api?.splitEditor) {
            return false;
        }
        await api.splitEditor('right');
        return true;
    });
    if (!splitCreated) {
        throw new Error('Packaged automation API did not expose splitEditor');
    }
    console.log('Packaged verification stage: split request completed');
    try {
        await waitForFunctionInPage(
            page,
            () => document.querySelectorAll('.editor-pane').length === 2,
            {timeout: 10_000},
        );
    } catch {
        const state = await evaluateInPage(page, () => ({
            activePaneId: document.querySelector<HTMLElement>('.editor-pane.is-active')
                ?.dataset.editorPaneId ?? null,
            paneIds: Array.from(document.querySelectorAll<HTMLElement>('.editor-pane'))
                .map(candidate => candidate.dataset.editorPaneId ?? null),
            paneSlotIds: Array.from(document.querySelectorAll<HTMLElement>('.editor-pane-slot'))
                .map(candidate => candidate.dataset.editorPaneSlot ?? null),
        }));
        throw new Error(`Packaged split request did not create two panes: ${JSON.stringify(state)}`);
    }
    console.log('Packaged verification stage: two panes visible');
    await openPdfInApp(page, sourcePath, STARTUP_TIMEOUT_MS);
    await waitForPdfLoaded(page, STARTUP_TIMEOUT_MS);
    await waitForViewerInteractive(page, STARTUP_TIMEOUT_MS);
    const pdfPaneId = await evaluateInPage(page, () =>
        document.querySelector<HTMLElement>('.editor-pane.is-active')
            ?.dataset.editorPaneId ?? null);
    if (!pdfPaneId || pdfPaneId === cleanupPaneId) {
        throw new Error('Packaged PDF pane did not become independently active');
    }
    console.log('Packaged verification stage: geometry document loaded in second pane');

    const samples: IGeometrySample[] = [];
    for (let index = 0; index < 6; index += 1) {
        const cleanup = index % 2 === 0;
        await activatePane(
            page,
            cleanup ? cleanupPaneId : pdfPaneId,
            cleanup
                ? '#editor-global-toolbar-host .scan-cleanup-toolbar'
                : '#editor-global-toolbar-host .toolbar:not(.scan-cleanup-toolbar)',
        );
        samples.push({
            kind: cleanup ? 'cleanup' : 'pdf',
            value: await sampleGeometry(page),
        });
    }
    const baseline = samples[0]?.value;
    if (!baseline || samples.some(sample => JSON.stringify(sample.value) !== JSON.stringify(baseline))) {
        throw new Error(`Packaged pane geometry shifted: ${JSON.stringify(samples)}`);
    }
    await activatePane(
        page,
        cleanupPaneId,
        '#editor-global-toolbar-host .scan-cleanup-toolbar',
    );
    console.log('Packaged verification stage: six pane switches retained exact geometry');
    return samples;
}

async function verifyNewTabAfterScale(page: Page): Promise<INewTabEvidence> {
    const before = await evaluateInPage(page, () => ({
        activeTabId: document.querySelector<HTMLElement>('.tab[aria-selected="true"]')
            ?.dataset.tabId ?? null,
        tabCount: document.querySelectorAll('.tab[data-tab-id]').length,
    }));
    if (!before.activeTabId) {
        throw new Error('Packaged scale verification found no active tab before new-tab check');
    }
    await page.click('.tab-new');
    await waitForFunctionInPage(page, (
        previousActiveTabId: string,
        previousTabCount: number,
    ) => {
        const activeTabId = document.querySelector<HTMLElement>(
            '.tab[aria-selected="true"]',
        )?.dataset.tabId;
        return document.querySelectorAll('.tab[data-tab-id]').length === previousTabCount + 1
            && typeof activeTabId === 'string'
            && activeTabId !== previousActiveTabId
            && document.querySelector('.empty-state') !== null;
    }, {timeout: STARTUP_TIMEOUT_MS}, before.activeTabId, before.tabCount);
    const after = await evaluateInPage(page, () => ({
        activeTabId: document.querySelector<HTMLElement>('.tab[aria-selected="true"]')
            ?.dataset.tabId ?? null,
        emptyStateVisible: document.querySelector('.empty-state') !== null,
        tabCount: document.querySelectorAll('.tab[data-tab-id]').length,
    }));
    if (!after.activeTabId) {
        throw new Error('Packaged scale verification created a tab without activating it');
    }
    const evidence = {
        activeTabIdAfter: after.activeTabId,
        activeTabIdBefore: before.activeTabId,
        emptyStateVisible: after.emptyStateVisible,
        tabCountAfter: after.tabCount,
        tabCountBefore: before.tabCount,
    };
    console.log(
        'Packaged verification stage: new empty tab created after full detection',
    );
    return evidence;
}

async function waitForCleanedOutput(page: Page, sourcePath: string) {
    await waitForFunctionInPage(page, (source: string) => {
        const active = (window as IWorkspaceExposeProbeWindow)
            .__evbTestApi
            ?.readActiveWorkspaceStateValues(['originalPath']);
        return typeof active?.originalPath === 'string'
            && active.originalPath !== source
            && active.originalPath.endsWith('— cleaned.pdf');
    }, {timeout: CLEANUP_TIMEOUT_MS}, sourcePath);
    const outputPath = await evaluateInPage(page, () => {
        const active = (window as IWorkspaceExposeProbeWindow)
            .__evbTestApi
            ?.readActiveWorkspaceStateValues(['originalPath']);
        return typeof active?.originalPath === 'string' ? active.originalPath : null;
    });
    if (!outputPath) {
        throw new Error('Packaged cleanup completed without an output path');
    }
    return outputPath;
}

async function waitForLogEvidence(logPath: string, pattern: RegExp) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const contents = await readFile(logPath, 'utf8').catch(() => '');
        if (pattern.test(contents)) {
            return true;
        }
        await delay(100);
    }
    return false;
}

async function runArtifactAudit(
    args: IArguments,
    sourcePath: string,
    outputPath: string,
) {
    const metadataDir = path.join(args.artifactDir, 'native-metadata');
    const synthetic = args.syntheticSpecPath !== null;
    const scriptPath = path.resolve(
        process.cwd(),
        synthetic
            ? 'scripts/diagnostics/scan-cleanup-synthetic-audit.py'
            : 'scripts/diagnostics/scan-cleanup-artifact-audit.py',
    );
    const artifactDir = path.join(
        args.artifactDir,
        synthetic ? 'synthetic-artifact-audit' : 'artifact-audit',
    );
    const auditArguments = [
        scriptPath,
        '--source-pdf',
        args.auditSourcePath ?? sourcePath,
        '--output-pdf',
        outputPath,
        '--metadata-dir',
        metadataDir,
        '--analysis-metadata-dir',
        args.referenceMetadataDir!,
        '--artifact-dir',
        artifactDir,
        '--dpi',
        '200',
        ...(args.sourcePages
            ? [
                '--source-pages',
                args.sourcePages,
                '--metadata-pages',
                Array.from(
                    {length: args.expectedPageCount},
                    (_value, index) => String(index + 1),
                ).join(','),
            ]
            : []),
        ...(args.syntheticSpecPath
            ? [
                '--fixture-spec',
                args.syntheticSpecPath,
            ]
            : []),
    ];
    const auditPython = process.env.EVB_SCAN_CLEANUP_AUDIT_PYTHON ?? 'python3';
    await new Promise<void>((resolve, reject) => {
        const audit = spawn(auditPython, auditArguments, {
            cwd: process.cwd(),
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });
        let auditStdout = '';
        let auditStderr = '';
        audit.stdout.on('data', data => {
            const text = String(data);
            auditStdout += text;
            process.stdout.write(text);
        });
        audit.stderr.on('data', data => {
            const text = String(data);
            auditStderr += text;
            process.stderr.write(text);
        });
        audit.once('error', reject);
        audit.once('exit', code => {
            void Promise.all([
                writeFile(path.join(args.artifactDir, 'artifact-audit-stdout.log'), auditStdout),
                writeFile(path.join(args.artifactDir, 'artifact-audit-stderr.log'), auditStderr),
            ]).then(() => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Final PDF artifact audit failed with exit code ${String(code)}`));
                }
            }, reject);
        });
    });
}

async function run() {
    const args = parseArguments(process.argv.slice(2));
    if (path.basename(args.executablePath) !== 'EVB Viewer') {
        throw new Error(
            `Packaged executable must be named "EVB Viewer", got "${path.basename(args.executablePath)}"`,
        );
    }
    await mkdir(args.artifactDir, {recursive: true});
    const sourceCopyPath = path.join(args.artifactDir, 'rome-packaged-source.pdf');
    const geometryCopyPath = path.join(args.artifactDir, 'rome-pane-geometry-source.pdf');
    const outputCopyPath = path.join(args.artifactDir, 'rome-packaged-cleaned.pdf');
    const nativeMetadataPath = path.join(args.artifactDir, 'native-metadata');
    const userDataPath = path.join(args.artifactDir, 'user-data');
    const appLogPath = path.join(args.artifactDir, 'app-logs', 'scan-cleanup-worker.log');
    await rm(userDataPath, {
        force: true,
        recursive: true,
    });
    await rm(path.dirname(appLogPath), {
        force: true,
        recursive: true,
    });
    await rm(outputCopyPath, {force: true});
    await rm(nativeMetadataPath, {
        force: true,
        recursive: true,
    });
    await copyFile(args.sourcePath, sourceCopyPath);
    // A second logical document exercises pane switching without asking the
    // working-copy registry to open the same source twice while cleanup owns
    // the first tab.
    await copyFile(args.sourcePath, geometryCopyPath);
    const cdpPort = await findFreePort();
    const launch = preparePackagedAutomationLaunch({
        executablePath: args.executablePath,
        workDirectory: args.artifactDir,
        env: {
            ...process.env,
            EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_SESSION_NAME: 'packaged-scan-cleanup-verification',
            EVB_AUTOMATION_USER_DATA_DIR: userDataPath,
            EVB_ENABLE_RENDERER_FILE_OPEN_HELPER: '1',
            EVB_FILE_LOG_DIR: path.dirname(appLogPath),
            EVB_SCAN_CLEANUP_EVIDENCE_DIR: nativeMetadataPath,
            ELECTRON_FILE_LOG_LEVEL: 'debug',
        },
    });
    const child = spawn(launch.executablePath, [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataPath}`,
    ], {
        env: launch.env,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => {
        const text = String(data);
        stdout += text;
        process.stdout.write(text);
    });
    child.stderr.on('data', data => {
        const text = String(data);
        stderr += text;
        process.stderr.write(text);
    });

    let resourceSamplingActive = args.scaleOnly;
    const resourceSamples: IResourceSample[] = [];
    const resourceSampling = (async () => {
        while (resourceSamplingActive && typeof child.pid === 'number') {
            const sample = await sampleProcessTreeRss(child.pid).catch(() => null);
            if (sample) {
                resourceSamples.push(sample);
            }
            await delay(1_000);
        }
    })();
    const stopResourceSampling = async () => {
        resourceSamplingActive = false;
        await resourceSampling;
        return {
            peakProcessCount: resourceSamples.reduce(
                (peak, sample) => Math.max(peak, sample.processCount),
                0,
            ),
            peakRssBytes: resourceSamples.reduce(
                (peak, sample) => Math.max(peak, sample.rssBytes),
                0,
            ),
            samples: resourceSamples,
        };
    };

    let browser: Browser | null = null;
    try {
        const browserWSEndpoint = await waitForPackagedCdpEndpoint(
            cdpPort,
            STARTUP_TIMEOUT_MS,
            'Packaged EVB Viewer',
        );
        browser = await puppeteer.connect({
            browserWSEndpoint,
            defaultViewport: null,
            protocolTimeout: CLEANUP_TIMEOUT_MS,
        });
        const page = await waitForPackagedRendererPage(
            browser,
            STARTUP_TIMEOUT_MS,
            'Packaged EVB Viewer',
        );
        await installPageEvaluationShims(page);
        await openPdfInApp(page, sourceCopyPath, STARTUP_TIMEOUT_MS);
        await waitForPdfLoaded(page, STARTUP_TIMEOUT_MS);
        await waitForViewerInteractive(page, STARTUP_TIMEOUT_MS);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface', {
            timeout: STARTUP_TIMEOUT_MS,
            visible: true,
        });
        console.log('Packaged verification stage: cleanup surface opened');
        const queuedCleanupEvidence = await verifyCleanupQueuedDuringDetection(
            page,
            args.expectedPageCount,
        );
        const detectionSamples = await waitForCompleteDetection(page, args.expectedPageCount);
        console.log(
            `Packaged verification stage: detection completed ${String(args.expectedPageCount)}/${String(args.expectedPageCount)}`,
        );
        const geometrySamples = await verifyPaneGeometry(page, geometryCopyPath);
        if (args.scaleOnly) {
            const newTabEvidence = await verifyNewTabAfterScale(page);
            const resourceSummary = await stopResourceSampling();
            await writeFile(
                path.join(args.artifactDir, 'packaged-verification.json'),
                `${JSON.stringify({
                    detectionSamples,
                    executablePath: args.executablePath,
                    expectedPageCount: args.expectedPageCount,
                    geometryCopyPath,
                    geometrySamples,
                    newTabEvidence,
                    queuedCleanupEvidence,
                    resourceSummary,
                    scaleOnly: true,
                    sourceCopyPath,
                }, null, 2)}\n`,
            );
            console.log(
                'Packaged scan-cleanup scale verification passed: '
                + `${String(args.expectedPageCount)} pages analyzed, `
                + 'second pane opened, and new tab created',
            );
            await delay(500);
            return;
        }
        await page.click('.scan-cleanup-toolbar-primary-action');
        console.log('Packaged verification stage: final cleanup started');
        const generatedOutputPath = await waitForCleanedOutput(page, sourceCopyPath);
        console.log('Packaged verification stage: final cleanup output opened');
        await copyFile(generatedOutputPath, outputCopyPath);
        await preserveFinalPdfIdentity(args, sourceCopyPath, outputCopyPath);
        console.log('Packaged verification stage: final PDF identity preserved');
        const planEvidence = new RegExp(
            `page-plan evidence: pinned=${String(args.expectedPageCount)} absent=0 mismatched=0`,
            'u',
        );
        const logEvidence = await waitForLogEvidence(appLogPath, planEvidence);
        if (!logEvidence) {
            throw new Error(
                'Packaged cleanup logs lack exact pinned/absent/mismatched evidence',
            );
        }
        console.log('Packaged verification stage: rasterized final-PDF audit started');
        await runArtifactAudit(args, sourceCopyPath, outputCopyPath);
        console.log('Packaged verification stage: rasterized final-PDF audit passed');
        await writeFile(
            path.join(args.artifactDir, 'packaged-verification.json'),
            `${JSON.stringify({
                detectionSamples,
                executablePath: args.executablePath,
                expectedPageCount: args.expectedPageCount,
                geometryCopyPath,
                geometrySamples,
                outputCopyPath,
                queuedCleanupEvidence,
                auditSourcePath: args.auditSourcePath,
                referenceMetadataDir: args.referenceMetadataDir,
                scaleOnly: false,
                sourceCopyPath,
                sourcePages: args.sourcePages,
                syntheticSpecPath: args.syntheticSpecPath,
            }, null, 2)}\n`,
        );
        console.log(`Packaged scan-cleanup verification passed: ${outputCopyPath}`);
        await delay(500);
    } finally {
        await stopResourceSampling();
        await writeFile(path.join(args.artifactDir, 'packaged-stdout.log'), stdout);
        await writeFile(path.join(args.artifactDir, 'packaged-stderr.log'), stderr);
        await browser?.disconnect().catch(() => {});
        let processTreeExited = true;
        if (typeof child.pid === 'number') {
            // Closing the browser asks every deliberately dirty harness tab to
            // save and turns teardown into an unrelated Save As workflow.
            // Capture the complete owned tree before killing it, then await each
            // PID so the copied bundle cannot be removed while a helper still
            // has files open.
            const processTreePids = [
                ...collectDescendantPidsUnix(child.pid),
                child.pid,
            ];
            if (processTreePids.some(pid => isProcessAlive(pid))) {
                killPids(processTreePids, {signal: 'SIGKILL'});
            }
            processTreeExited = await waitForProcessTreeExit(processTreePids, 5_000);
        } else if (child.exitCode === null) {
            child.kill('SIGKILL');
            processTreeExited = false;
        }
        if (!processTreeExited) {
            console.error(`Packaged scan-cleanup process tree remained alive; preserving its launch copy at ${String(launch.bundleDirectory)}.`);
        } else if (launch.bundleDirectory) {
            await rm(launch.bundleDirectory, {
                force: true,
                recursive: true,
            });
        }
    }
}

await run();
