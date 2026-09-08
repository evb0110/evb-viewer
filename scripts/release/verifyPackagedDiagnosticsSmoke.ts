/* eslint-disable custom/file-naming -- this executable also exports its argument parser for coverage */
import {spawn} from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import type {
    Browser,
    Page,
} from 'puppeteer-core';
import {DEFAULT_SETTINGS} from '@contracts/settings';
import type {TClientDiagnosticsPreference} from '@contracts/diagnostics/diagnosticsPreference';
import {
    decodeFailureReceipt,
    type FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import {
    findFreePort,
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {preparePackagedAutomationLaunch} from '@scripts/release/preparePackagedAutomationLaunch';
import {
    waitForPackagedCdpEndpoint,
    waitForPackagedRendererPage,
} from '@scripts/release/waitForPackagedCdpEndpoint';

const STARTUP_TIMEOUT_MS = 75_000;
const DELIVERY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const REQUIRED_DELIVERY_PHASE: ISentryNodeAuditEntry['phase'] = process.argv.includes('--allow-rejected')
    ? 'attempted'
    : 'accepted';

interface IDiagnosticsCanaryMainHealth {
    preference: TClientDiagnosticsPreference;
    transportReady: boolean;
}

interface ISentryNodeAuditEntry {
    code: string;
    dist: string;
    environment: string;
    eventId: string;
    itemType: string;
    phase: 'accepted' | 'attempted' | 'rejected';
    release: string;
    runtime: string;
}

type TRendererCanaryKind = 'fatal-ui' | 'renderer' | 'ui-only' | 'worker-parent';

interface IRendererCanaryApi {
    capture(kind: TRendererCanaryKind): FailureReceipt;
    directConsoleError(): void;
    getPreference(): TClientDiagnosticsPreference;
    setPreference(preference: TClientDiagnosticsPreference): Promise<boolean>;
}

interface ICanaryWindow extends Window {
    __appReady?: boolean;
    __evbDiagnosticsCanaryMain?: {trigger(action: 'crash-main' | 'main-error' | 'main-health'): Promise<FailureReceipt | IDiagnosticsCanaryMainHealth | boolean | null>;};
    __evbRendererDiagnosticsCanary?: IRendererCanaryApi;
}

interface IRunningSession {
    auditPath: string;
    browser: Browser;
    child: ReturnType<typeof spawn>;
    page: Page;
    userDataPath: string;
}

type TPackagedAutomationLaunch = ReturnType<typeof preparePackagedAutomationLaunch>;

const activeSessions = new Set<IRunningSession>();

export function parseExecutableArgument(args: string[]) {
    const index = args.indexOf('--executable');
    return index < 0 ? null : args[index + 1] ?? null;
}

async function walk(root: string): Promise<string[]> {
    const entries = await readdir(root, {withFileTypes: true}).catch(() => []);
    const paths: string[] = [];
    for (const entry of entries) {
        const candidate = path.join(root, entry.name);
        if (entry.isDirectory()) {
            paths.push(...await walk(candidate));
        } else if (entry.isFile()) {
            paths.push(candidate);
        }
    }
    return paths;
}

async function resolveExecutablePath() {
    const explicit = parseExecutableArgument(process.argv.slice(2));
    if (explicit) {
        return path.resolve(explicit);
    }
    const files = await walk(path.resolve('release'));
    const match = files.find((candidate) => {
        const normalized = candidate.replaceAll('\\', '/');
        if (process.platform === 'darwin') {
            return normalized.endsWith('/EVB Viewer.app/Contents/MacOS/EVB Viewer');
        }
        if (process.platform === 'win32') {
            return normalized.endsWith('/EVB Viewer.exe')
                && /\/win(?:-arm64)?-unpacked\//u.test(normalized);
        }
        return /\/linux(?:-arm64)?-unpacked\/evb-viewer$/u.test(normalized);
    });
    if (!match) {
        throw new Error('Could not find the packaged EVB Viewer executable under release/');
    }
    return match;
}

async function writePreference(userDataPath: string, preference: TClientDiagnosticsPreference) {
    await mkdir(userDataPath, {recursive: true});
    await writeFile(path.join(userDataPath, 'settings.json'), JSON.stringify({
        ...DEFAULT_SETTINGS,
        clientDiagnosticsPreference: preference,
    }, null, 2), 'utf8');
}

async function readAudit(auditPath: string): Promise<ISentryNodeAuditEntry[]> {
    const text = await readFile(auditPath, 'utf8').catch(() => '');
    return text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as ISentryNodeAuditEntry);
}

async function waitForAudit(
    auditPath: string,
    predicate: (entries: ISentryNodeAuditEntry[]) => boolean,
) {
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    let entries = await readAudit(auditPath);
    while (Date.now() < deadline) {
        if (predicate(entries)) {
            return entries;
        }
        await delay(100);
        entries = await readAudit(auditPath);
    }
    throw new Error(`Timed out waiting for diagnostics audit record; observed ${JSON.stringify(entries)}`);
}

async function waitForExit(pid: number) {
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline && isProcessAlive(pid)) {
        await delay(100);
    }
    return !isProcessAlive(pid);
}

async function startSession(
    launch: TPackagedAutomationLaunch,
    root: string,
    name: string,
    preference: TClientDiagnosticsPreference,
    options: {disableAdapter?: boolean} = {},
): Promise<IRunningSession> {
    const userDataPath = path.join(root, name);
    const auditPath = path.join(userDataPath, 'diagnostics-audit.jsonl');
    await writePreference(userDataPath, preference);
    const cdpPort = await findFreePort();
    const child = spawn(launch.executablePath, [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataPath}`,
    ], {
        env: {
            ...launch.env,
            EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
            EVB_AUTOMATION_SESSION_NAME: `packaged-diagnostics-${name}`,
            EVB_AUTOMATION_USER_DATA_DIR: userDataPath,
            EVB_DIAGNOSTICS_CANARY_AUDIT_FILE: auditPath,
            ...(options.disableAdapter ? {EVB_DIAGNOSTICS_CANARY_DISABLE_ADAPTER: '1'} : {}),
        },
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    let browser: Browser | null = null;
    try {
        const endpoint = await waitForPackagedCdpEndpoint(cdpPort, STARTUP_TIMEOUT_MS, name);
        browser = await puppeteer.connect({
            browserWSEndpoint: endpoint,
            defaultViewport: null,
            protocolTimeout: 120_000,
        });
        const page = await waitForPackagedRendererPage(browser, STARTUP_TIMEOUT_MS, name);
        await page.waitForFunction(() => {
            const canaryWindow = window as ICanaryWindow;
            return canaryWindow.__appReady === true
                && Boolean(canaryWindow.__evbDiagnosticsCanaryMain)
                && Boolean(canaryWindow.__evbRendererDiagnosticsCanary);
        }, {timeout: STARTUP_TIMEOUT_MS});
        const session = {
            auditPath,
            browser,
            child,
            page,
            userDataPath,
        };
        activeSessions.add(session);
        return session;
    } catch (error) {
        await browser?.close().catch(() => {});
        if (child.pid && isProcessAlive(child.pid)) {
            await killProcessTree(child.pid, 1_500).catch(() => {});
        }
        throw error;
    }
}

async function stopSession(session: IRunningSession) {
    await session.browser.close().catch(() => {});
    if (!await waitForExit(session.child.pid!)) {
        await killProcessTree(session.child.pid!, 1_500);
    }
    if (isProcessAlive(session.child.pid!)) {
        throw new Error('Packaged diagnostics process remained alive after cleanup.');
    }
    activeSessions.delete(session);
}

async function assertNoDelivery(session: IRunningSession, label: string) {
    await session.page.evaluate(() => {
        (window as ICanaryWindow).__evbRendererDiagnosticsCanary!.directConsoleError();
    });
    await delay(1_000);
    const entries = await readAudit(session.auditPath);
    if (entries.length > 0) {
        throw new Error(`${label} produced diagnostics delivery: ${JSON.stringify(entries)}`);
    }
}

function deliveredEntryFor(entries: ISentryNodeAuditEntry[], receipt: FailureReceipt) {
    return entries.find(entry => entry.phase === REQUIRED_DELIVERY_PHASE && entry.eventId === receipt.eventId);
}

async function captureRenderer(session: IRunningSession, kind: TRendererCanaryKind) {
    return session.page.evaluate((canaryKind) => (
        (window as ICanaryWindow).__evbRendererDiagnosticsCanary!.capture(canaryKind)
    ), kind);
}

async function waitForMainTransportReady(session: IRunningSession) {
    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    let health: FailureReceipt | IDiagnosticsCanaryMainHealth | boolean | null = null;
    while (Date.now() < deadline) {
        health = await session.page.evaluate(() => (
            (window as ICanaryWindow).__evbDiagnosticsCanaryMain!.trigger('main-health')
        ));
        if (
            health !== null
            && typeof health === 'object'
            && 'preference' in health
            && health.preference === 'granted'
            && health.transportReady === true
        ) {
            return health;
        }
        await delay(100);
    }
    throw new Error(`Main diagnostics transport was not ready after consent persistence: ${JSON.stringify(health)}`);
}

async function runGrantedMatrix(session: IRunningSession) {
    const firstReceipt = await captureRenderer(session, 'ui-only');
    const grantSelector = '[data-runtime-error-action="grant-diagnostics"]';
    await session.page.waitForSelector(grantSelector, {
        timeout: DELIVERY_TIMEOUT_MS,
        visible: true,
    });
    const grantControl = await session.page.$eval(grantSelector, (element) => ({
        disabled: element instanceof HTMLButtonElement && element.disabled,
        tagName: element.tagName,
    }));
    if (grantControl.tagName !== 'BUTTON' || grantControl.disabled) {
        throw new Error(`Diagnostics grant control is not an enabled button: ${JSON.stringify(grantControl)}`);
    }
    await session.page.$eval(grantSelector, element => (element as HTMLButtonElement).click());
    await waitForMainTransportReady(session);
    await waitForAudit(session.auditPath, entries => Boolean(deliveredEntryFor(entries, firstReceipt)));

    await session.page.$eval(
        '[data-runtime-error-action="details"]',
        element => (element as HTMLButtonElement).click(),
    );
    await session.page.waitForSelector(
        `[data-runtime-error-report-id="${firstReceipt.eventId}"] code`,
        {timeout: DELIVERY_TIMEOUT_MS},
    );
    const renderedErrorId = await session.page.$eval(
        `[data-runtime-error-report-id="${firstReceipt.eventId}"] code`,
        element => element.textContent.trim(),
    );
    if (renderedErrorId !== firstReceipt.eventId.slice(0, 8)) {
        throw new Error(`Runtime error UI rendered Error ID ${renderedErrorId}, expected ${firstReceipt.eventId.slice(0, 8)}`);
    }

    const receipts = [
        await captureRenderer(session, 'renderer'),
        await captureRenderer(session, 'worker-parent'),
    ];
    await session.page.evaluate(() => {
        (window as ICanaryWindow).__evbRendererDiagnosticsCanary!.directConsoleError();
    });
    const mainResult = await session.page.evaluate(() => (
        (window as ICanaryWindow).__evbDiagnosticsCanaryMain!.trigger('main-error')
    ));
    const mainReceipt = decodeFailureReceipt(mainResult);
    if (mainReceipt === null) {
        throw new Error('Main diagnostics canary did not return a failure receipt');
    }
    receipts.push(mainReceipt);
    const fatalReceipt = await captureRenderer(session, 'fatal-ui');
    receipts.push(fatalReceipt);
    await session.page.waitForSelector('#fatal-runtime-error-id code', {timeout: DELIVERY_TIMEOUT_MS});
    const fatalErrorId = await session.page.$eval(
        '#fatal-runtime-error-id code',
        element => element.textContent.trim(),
    );
    if (fatalErrorId !== fatalReceipt.eventId.slice(0, 8)) {
        throw new Error('Fatal error UI did not render the captured Error ID');
    }

    const delivered = await waitForAudit(session.auditPath, entries => (
        receipts.every(receipt => Boolean(deliveredEntryFor(entries, receipt)))
        && entries.some(entry => entry.phase === REQUIRED_DELIVERY_PHASE && entry.code === 'UNCLASSIFIED_CONSOLE_ERROR')
    ));
    const attempted = delivered.filter(entry => entry.phase === 'attempted');
    const completed = delivered.filter(entry => entry.phase === REQUIRED_DELIVERY_PHASE);
    if (attempted.length !== 6 || completed.length !== 6) {
        throw new Error(`Expected six one-item event attempts and ${REQUIRED_DELIVERY_PHASE} records, observed ${attempted.length}/${completed.length}`);
    }
    if (completed.some(entry => entry.itemType !== 'event')) {
        throw new Error('Packaged diagnostics emitted a non-event envelope item');
    }
    if (REQUIRED_DELIVERY_PHASE === 'attempted') {
        await waitForAudit(session.auditPath, entries => entries.filter(entry => (
            entry.phase === 'accepted' || entry.phase === 'rejected'
        )).length === 6);
    }

    const revoked = await session.page.evaluate(() => (
        (window as ICanaryWindow).__evbRendererDiagnosticsCanary!.setPreference('denied')
    ));
    if (!revoked) {
        throw new Error('Packaged diagnostics revocation did not persist');
    }
    const beforeRevokedCapture = (await readAudit(session.auditPath)).length;
    await session.page.evaluate(() => {
        (window as ICanaryWindow).__evbRendererDiagnosticsCanary!.directConsoleError();
    });
    await delay(1_000);
    const afterRevokedCapture = (await readAudit(session.auditPath)).length;
    if (afterRevokedCapture !== beforeRevokedCapture) {
        throw new Error('Revocation allowed a later diagnostics envelope');
    }
}

async function runStartupMarkerMatrix(launch: TPackagedAutomationLaunch, root: string) {
    const crashed = await startSession(launch, root, 'startup-marker', 'granted', {disableAdapter: true});
    await crashed.page.evaluate(() => {
        void (window as ICanaryWindow).__evbDiagnosticsCanaryMain!.trigger('crash-main');
    });
    await crashed.browser.disconnect();
    if (!await waitForExit(crashed.child.pid!)) {
        await killProcessTree(crashed.child.pid!, 1_500).catch(() => {});
        throw new Error('Startup marker canary did not exit after the main-process failure');
    }
    activeSessions.delete(crashed);
    const markerPath = path.join(crashed.userDataPath, 'startup-crash-marker.json');
    if (!(await stat(markerPath).catch(() => null))?.isFile()) {
        throw new Error('Startup marker canary did not persist its one-shot marker');
    }

    const replayed = await startSession(launch, root, 'startup-marker', 'granted');
    await waitForAudit(replayed.auditPath, entries => entries.some(entry => (
        entry.phase === REQUIRED_DELIVERY_PHASE && entry.code === 'MAIN_STARTUP_CRASH'
    )));
    if (await stat(markerPath).catch(() => null)) {
        throw new Error('Startup marker remained after the replay launch');
    }
    await stopSession(replayed);
}

async function run() {
    const executablePath = await resolveExecutablePath();
    const root = await mkdtemp(path.join(tmpdir(), 'evb-packaged-diagnostics-'));
    const launch = preparePackagedAutomationLaunch({
        executablePath,
        workDirectory: root,
        env: {
            ...process.env,
            EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_ENABLE_DIAGNOSTICS_CANARY: '1',
            EVB_ENABLE_RENDERER_FILE_OPEN_HELPER: '1',
        },
    });
    let passed = false;
    const cleanupErrors: Error[] = [];
    try {
        const unknown = await startSession(launch, root, 'unknown', 'unknown');
        await assertNoDelivery(unknown, 'Unknown preference');
        await stopSession(unknown);

        const denied = await startSession(launch, root, 'denied', 'denied');
        await assertNoDelivery(denied, 'Denied preference');
        await stopSession(denied);

        const granted = await startSession(launch, root, 'granted', 'unknown');
        await runGrantedMatrix(granted);
        const entriesBeforeClose = (await readAudit(granted.auditPath)).length;
        await stopSession(granted);
        const entriesAfterClose = (await readAudit(granted.auditPath)).length;
        if (entriesAfterClose !== entriesBeforeClose) {
            throw new Error('Packaged app emitted a close-time diagnostics envelope');
        }

        await runStartupMarkerMatrix(launch, root);
        process.stdout.write('Packaged diagnostics consent matrix passed\n');
        passed = true;
    } finally {
        let sessionsQuiescent = true;
        for (const session of [...activeSessions]) {
            try {
                await stopSession(session);
            } catch (error) {
                sessionsQuiescent = false;
                cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
            }
            if (typeof session.child.pid === 'number' && isProcessAlive(session.child.pid)) {
                sessionsQuiescent = false;
            }
        }
        if (sessionsQuiescent && launch.bundleDirectory) {
            try {
                await rm(launch.bundleDirectory, {
                    force: true,
                    recursive: true,
                });
            } catch (error) {
                cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        if (!sessionsQuiescent) {
            process.stderr.write(`Preserved diagnostics work directory while a session remained active: ${root}\n`);
        } else if (!passed && process.argv.includes('--keep-temp-on-failure')) {
            process.stderr.write(`Preserved failed diagnostics profile at ${root}\n`);
        } else {
            try {
                await rm(root, {
                    recursive: true,
                    force: true,
                });
            } catch (error) {
                cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
            }
        }
        for (const error of cleanupErrors) console.error('Packaged diagnostics cleanup failed:', error);
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Packaged diagnostics cleanup failed.');
    }
}

const canonicalEntryPath = process.argv[1] === undefined
    ? null
    : await realpath(path.resolve(process.argv[1])).catch(() => null);
const canonicalModulePath = await realpath(fileURLToPath(import.meta.url)).catch(() => null);
const isDirectInvocation = canonicalEntryPath !== null
    && canonicalModulePath !== null
    && canonicalEntryPath === canonicalModulePath;

if (isDirectInvocation) {
    void run().catch((error: unknown) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
    });
}
