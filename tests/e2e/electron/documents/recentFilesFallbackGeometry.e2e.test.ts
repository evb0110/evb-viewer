import {
    describe,
    expect,
    it,
} from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    closeSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    activateMenuItemAsUser,
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import { createMixedPageSizeTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    goToPageViaToolbar,
    openPdfInApp,
    readDrawnPage,
    readHeldShell,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
    setRememberPlaceAsUser,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import { requireWorkspaceCommand } from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    installCommittedSurfaceSampler,
    isOpeningBeforePageGeometry,
    stopCommittedSurfaceSampler,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';

const TIMEOUT_MS = 15_000;
const ARTIFACT_DIR = join(process.cwd(), '.devkit', 'e2e-artifacts', 'recent-fallback-geometry');

async function waitForRecentFileRow(session: IElectronE2ESession, sourcePath: string) {
    await waitForFunctionInPage(session.page, (target: string) => Array.from(
        document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'),
    ).some(row => row.dataset.recentSource === target), {timeout: TIMEOUT_MS}, sourcePath);
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

// A mixed-size PDF (612x900, 612x792, 612x820) left on its last page in
// continuous Fit Width, turned a quarter, reopens from Recent with its held
// page shell on the rect the drawn page takes. Fit Width fits the widest
// turned page, 900 wide, not the current page's 820.
async function expectQuarterTurnedFitWidthReopenOnDrawnRect(
    session: IElectronE2ESession,
    label: string,
    expectedOpeningGeometry: 'exact' | 'unavailable',
) {
    await setRememberPlaceAsUser(session, true);
    const fixturePath = await createMixedPageSizeTextFixturePdf(`recent-fallback-${label}-${Date.now()}.pdf`);
    const fixtureDocumentRef = requireDocumentRef(fixturePath);
    const sourceHash = sha256(fixturePath);
    mkdirSync(ARTIFACT_DIR, {recursive: true});

    await openPdfInApp(session.page, fixturePath);
    await waitForPdfLoaded(session.page);
    // Both through the application menu, while the document is fully shown.
    await activateMenuItemAsUser(session.page, {accelerator: 'CmdOrCtrl+1'});
    await activateMenuItemAsUser(session.page, {id: 'rotate-view-clockwise'});
    const readView = () => requireWorkspaceCommand<{
        viewMode: string;
        continuousScroll: boolean;
        viewRotation: number;
    }>(session.page, 'getToolbarSnapshot');
    await expect.poll(async () => (await readView())?.viewRotation, {timeout: TIMEOUT_MS}).toBe(90);
    await goToPageViaToolbar(session.page, 3);
    const left = await readView();
    expect(left?.continuousScroll).toBe(true);
    const liveBeforeClose = await readDrawnPage(session, 3);

    await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
    await waitForRecentFileRow(session, fixturePath);
    expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
        window.__deferDocumentOpenForAutomation?.(path) ?? false
    ), fixtureDocumentRef)).toBe(true);
    if (expectedOpeningGeometry === 'unavailable') {
        await installCommittedSurfaceSampler(session.page);
    }
    await clickFoundAsUser(session.page, (target: string) => Array.from(
        document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'),
    ).find(row => row.dataset.recentSource === target)
        ?.querySelector<HTMLButtonElement>('button.recent-open'), fixturePath, {description: 'recent open button'});
    let openingShell: Awaited<ReturnType<typeof readHeldShell>> = null;
    if (expectedOpeningGeometry === 'exact') {
        await waitForFunctionInPage(session.page, () => Boolean(
            document.querySelector('.editor-pane.is-active [data-document-opening-shell-id]'),
        ), {timeout: TIMEOUT_MS});
        openingShell = await readHeldShell(session);
        expect(openingShell?.page).toBe(3);
    } else {
        // A rejected exact table cannot size a UserUnit-correct placeholder.
        // The claimed reopen remains bare until PDF.js supplies full geometry.
        await waitForFunctionInPage(session.page, (fileName: string) => {
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"]');
            const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis');
            const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]');
            const rect = viewport?.getBoundingClientRect();
            const visibleSurface = Array.from(host?.querySelectorAll<HTMLElement>(
                '.start-open-panel, .document-page-skeleton, .document-viewer-chassis__opening-page, .page_canvas, canvas',
            ) ?? []).some(node => {
                const box = node.getBoundingClientRect();
                return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
            });
            return document.querySelector('.tab-list .tab.is-active .tab-label')?.textContent?.trim() === fileName
                && viewport?.dataset.openSurfacePhase === 'pending'
                && chassis?.dataset.openSurfaceHasOpeningGeometry === 'false'
                && Boolean(rect && rect.width > 0 && rect.height > 0)
                && !visibleSurface;
        }, {timeout: TIMEOUT_MS}, basename(fixturePath));
        expect(await readHeldShell(session)).toBeNull();
    }
    await session.page.screenshot({path: join(ARTIFACT_DIR, `${label}-held.png`)});

    expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
        window.__releaseDocumentOpenForAutomation?.(path) ?? false
    ), fixtureDocumentRef)).toBe(true);
    await waitForPdfLoaded(session.page, TIMEOUT_MS);
    await waitForToolbarCurrentPage(session.page, 3);
    await waitForFunctionInPage(session.page, () => Boolean(document.querySelector(
        '.editor-pane.is-active #pdf-viewer .page_container[data-page="3"] canvas',
    )), {timeout: TIMEOUT_MS});
    const drawn = await readDrawnPage(session, 3);
    if (expectedOpeningGeometry === 'unavailable') {
        const trace = await stopCommittedSurfaceSampler(session.page);
        writeFileSync(join(ARTIFACT_DIR, `${label}-opening-frames.json`), JSON.stringify(trace, null, 2));
        const claimIndex = trace.frames.findIndex(frame => frame.openSurfacePhase === 'pending');
        expect(claimIndex, JSON.stringify(trace)).toBeGreaterThanOrEqual(0);
        const frames = trace.frames.slice(claimIndex);
        const shellIndex = frames.findIndex(frame => frame.kind === 'page-shell');
        const canvasIndex = frames.findIndex(frame => frame.kind === 'committed-canvas');
        expect(trace.errors ?? [], JSON.stringify(trace)).toEqual([]);
        expect(shellIndex, JSON.stringify(frames)).toBeGreaterThan(0);
        expect(canvasIndex, JSON.stringify(frames)).toBeGreaterThan(shellIndex);
        expect(frames.slice(0, shellIndex).every(frame => (
            isOpeningBeforePageGeometry(frame)
            && frame.skeletonCount === 0
            && !frame.outerPlaceholderVisible
            && (frame.visibleWorkspaceHostCount ?? 0) === 1
        )), JSON.stringify(frames)).toBe(true);
        expect(frames.slice(shellIndex, canvasIndex).every(frame => (
            frame.kind === 'page-shell' && frame.pageNumber === 3
            && frame.skeletonCount === 1 && frame.skeletonSharesShell
        )), JSON.stringify(frames)).toBe(true);
        expect(frames.slice(canvasIndex).every(frame => frame.kind === 'committed-canvas' && frame.pageNumber === 3), JSON.stringify(frames)).toBe(true);
        const firstShell = frames[shellIndex]!;
        expect(firstShell.shellRect).not.toBeNull();
        openingShell = firstShell.shellRect ? {
            page: 3,
            ...firstShell.shellRect,
        } : null;
    }
    await session.page.screenshot({path: join(ARTIFACT_DIR, `${label}-drawn.png`)});
    console.log(`[fallback-geometry] ${label} ${JSON.stringify({
        sourceHash,
        left,
        liveBeforeClose,
        expectedOpeningGeometry,
        openingShell,
        drawn,
        widthRatio: openingShell && drawn ? openingShell.width / drawn.width : null,
    })}`);

    expect(sha256(fixturePath), 'the source bytes are unchanged').toBe(sourceHash);
    // The first exact shell and drawn page use the same Fit Width scale,
    // within the committed surface contract's one CSS pixel.
    for (const key of [
        'width',
        'height',
    ] as const) {
        expect(Math.abs((drawn?.[key] ?? Number.NaN) - (openingShell?.[key] ?? Number.NaN)), `${label} ${key}: ${JSON.stringify({
            openingShell,
            drawn,
        })}`).toBeLessThanOrEqual(1);
    }
}

// The real page operations tool behind a shell wrapper that rejects only the
// metadata page-size read and execs the tool for every other command, so
// working copies still open. Each call is logged for the witness.
function createMetadataRejectingPageOps(barrierPath?: string) {
    const realPath = join(process.cwd(), '.tmp', 'pdf-page-ops', `${process.platform}-${process.arch}`, 'bin', 'evb-pdf-page-ops');
    expect(existsSync(realPath), realPath).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'page-ops-metadata-reject-'));
    const wrapperPath = join(dir, 'evb-pdf-page-ops');
    const callLog = join(dir, 'calls.log');
    writeFileSync(wrapperPath, [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${callLog}'`,
        'if [ "$1" = page-sizes ]; then',
        '    for arg in "$@"; do',
        '        if [ "$arg" = --metadata-only ]; then',
        ...(barrierPath ? [`            read released < '${barrierPath}'`] : []),
        '            echo \'forced test failure: page-sizes --metadata-only rejected\' >&2',
        `            printf 'REJECTED\\n' >> '${callLog}'`,
        '            exit 3',
        '        fi',
        '    done',
        'fi',
        `exec '${realPath}' "$@"`,
        '',
    ].join('\n'));
    chmodSync(wrapperPath, 0o700);
    console.log(`[fallback-geometry] wrapper ${JSON.stringify({
        realPath,
        realSha256: sha256(realPath),
        wrapperPath,
    })}`);
    return {
        wrapperPath,
        callLog,
    };
}

describe('Electron E2E - Recent reopen geometry without exact page shapes', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: `e2e-recent-fallback-geometry-${Date.now()}`});

    it.skipIf(process.platform === 'win32')('paints a first open without waiting for the whole-document metadata reader', async () => {
        const barrierPath = join(mkdtempSync(join(tmpdir(), 'opening-metadata-barrier-')), 'release');
        execFileSync('mkfifo', [barrierPath]);
        const barrier = openSync(barrierPath, 'r+');
        const pageOps = createMetadataRejectingPageOps(barrierPath);
        const fixture = join(dirname(pageOps.wrapperPath), 'first-open.pdf');
        let session: IElectronE2ESession | null = null;
        try {
            session = await sessionFixture.restart({
                clean: true,
                extraEnv: {
                    EVB_PDF_PAGE_OPS_PATH: pageOps.wrapperPath,
                    EVB_E2E_OPEN_DIALOG_PATH: fixture,
                },
            });
            copyFileSync(await createMixedPageSizeTextFixturePdf(`first-open-metadata-${Date.now()}.pdf`), fixture);
            await clickAsUser(session.page, '.editor-pane.is-active .start-open-panel .open-panel-cta');
            await waitForPdfLoaded(session.page, TIMEOUT_MS);
            const drawn = await readDrawnPage(session, 1);
            expect(drawn?.width).toBeGreaterThan(100);
            expect(drawn?.height).toBeGreaterThan(100);
            mkdirSync(ARTIFACT_DIR, {recursive: true});
            await session.page.screenshot({path: join(ARTIFACT_DIR, 'first-open-metadata-held.png')});
        } catch (error) {
            await session?.captureFailureArtifacts('first-open-metadata-held');
            throw error;
        } finally {
            writeSync(barrier, 'release\n');
            closeSync(barrier);
            await sessionFixture.stop({preserveArtifacts: true});
            await sessionFixture.start({
                clean: true,
                extraEnv: {},
            });
            rmSync(dirname(pageOps.wrapperPath), {
                recursive: true,
                force: true,
            });
            rmSync(dirname(barrierPath), {
                recursive: true,
                force: true,
            });
        }
    });

    it('reopens a quarter-turned Fit Width mixed-size PDF on its drawn rect with exact page shapes', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-fallback-exact-${Date.now()}`,
        });
        await expectQuarterTurnedFitWidthReopenOnDrawnRect(session, 'exact', 'exact');
    });

    // Only the exact native table fails. The open stays bare while held, then
    // PDF.js's complete geometry owns its first shell and restored scale.
    it.skipIf(process.platform === 'win32')('reopens a quarter-turned Fit Width mixed-size PDF at its drawn scale when the page-size metadata read fails', async () => {
        const pageOps = createMetadataRejectingPageOps();
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-fallback-forced-${Date.now()}`,
            extraEnv: {EVB_PDF_PAGE_OPS_PATH: pageOps.wrapperPath},
        });
        let pageOpsCalls = '';
        try {
            await expectQuarterTurnedFitWidthReopenOnDrawnRect(session, 'forced-metadata-failure', 'unavailable');
        } finally {
            pageOpsCalls = existsSync(pageOps.callLog) ? readFileSync(pageOps.callLog, 'utf8') : '';
            console.log(existsSync(pageOps.callLog)
                ? `[fallback-geometry] page-ops calls\n${pageOpsCalls}`
                : `[fallback-geometry] page-ops call log missing: no wrapper call reached ${pageOps.callLog}`);
        }
        expect(pageOpsCalls).toContain('REJECTED');
    });
});
