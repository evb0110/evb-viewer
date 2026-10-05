import {
    describe,
    expect,
    it,
} from 'vitest';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import { requireWorkspaceCommand } from '@tests/e2e/electron/helpers/workspaceExpose';

const TIMEOUT_MS = 15_000;
const ARTIFACT_DIR = join(process.cwd(), '.devkit', 'e2e-artifacts', 'recent-fallback-geometry');

interface IRect {
    page: number;
    top: number;
    left: number;
    width: number;
    height: number;
}

function readHeldShell(session: IElectronE2ESession) {
    return evaluateInPage(session.page, (): IRect | null => {
        const shell = document.querySelector<HTMLElement>('.editor-pane.is-active [data-document-opening-shell-id]');
        const rect = shell?.getBoundingClientRect();
        return shell && rect ? {
            page: Number(shell.dataset.pageNumber),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
        } : null;
    });
}

function readDrawnPage(session: IElectronE2ESession, pageNumber: number) {
    return evaluateInPage(session.page, (page: number): IRect | null => {
        const rect = document.querySelector<HTMLElement>(
            `.editor-pane.is-active #pdf-viewer .page_container[data-page="${page}"]`,
        )?.getBoundingClientRect();
        return rect ? {
            page,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
        } : null;
    }, pageNumber);
}

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
async function expectQuarterTurnedFitWidthReopenOnDrawnRect(session: IElectronE2ESession, label: string) {
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
    await clickFoundAsUser(session.page, (target: string) => Array.from(
        document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'),
    ).find(row => row.dataset.recentSource === target)
        ?.querySelector<HTMLButtonElement>('button.recent-open'), fixturePath, {description: 'recent open button'});
    await waitForFunctionInPage(session.page, () => Boolean(
        document.querySelector('.editor-pane.is-active [data-document-opening-shell-id]'),
    ), {timeout: TIMEOUT_MS});
    const held = await readHeldShell(session);
    await session.page.screenshot({path: join(ARTIFACT_DIR, `${label}-held.png`)});
    expect(held?.page).toBe(3);

    expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
        window.__releaseDocumentOpenForAutomation?.(path) ?? false
    ), fixtureDocumentRef)).toBe(true);
    await waitForPdfLoaded(session.page, TIMEOUT_MS);
    await waitForToolbarCurrentPage(session.page, 3);
    await waitForFunctionInPage(session.page, () => Boolean(document.querySelector(
        '.editor-pane.is-active #pdf-viewer .page_container[data-page="3"] canvas',
    )), {timeout: TIMEOUT_MS});
    const drawn = await readDrawnPage(session, 3);
    await session.page.screenshot({path: join(ARTIFACT_DIR, `${label}-drawn.png`)});
    console.log(`[fallback-geometry] ${label} ${JSON.stringify({
        sourceHash,
        left,
        liveBeforeClose,
        held,
        drawn,
        widthRatio: held && drawn ? held.width / drawn.width : null,
    })}`);

    expect(sha256(fixturePath), 'the source bytes are unchanged').toBe(sourceHash);
    // Fit Width scale, within the committed surface contract's one CSS pixel.
    // The held position is reported but not asserted: without every page's
    // shape the opening frame cannot know the offset of page 3.
    for (const key of [
        'width',
        'height',
    ] as const) {
        expect(Math.abs((drawn?.[key] ?? Number.NaN) - (held?.[key] ?? Number.NaN)), `${label} ${key}: ${JSON.stringify({
            held,
            drawn,
        })}`).toBeLessThanOrEqual(1);
    }
}

// The real page operations tool behind a shell wrapper that rejects only the
// metadata page-size read and execs the tool for every other command, so
// working copies still open. Each call is logged for the witness.
function createMetadataRejectingPageOps() {
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

    it('reopens a quarter-turned Fit Width mixed-size PDF on its drawn rect with exact page shapes', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-fallback-exact-${Date.now()}`,
        });
        await expectQuarterTurnedFitWidthReopenOnDrawnRect(session, 'exact');
    });

    // Only the page operations metadata read fails, so the open keeps Poppler's
    // opening geometry and a working copy but has no list of every page.
    it.skipIf(process.platform === 'win32')('reopens a quarter-turned Fit Width mixed-size PDF at its drawn scale when the page-size metadata read fails', async () => {
        const pageOps = createMetadataRejectingPageOps();
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-fallback-forced-${Date.now()}`,
            extraEnv: {EVB_PDF_PAGE_OPS_PATH: pageOps.wrapperPath},
        });
        try {
            await expectQuarterTurnedFitWidthReopenOnDrawnRect(session, 'forced-metadata-failure');
        } finally {
            console.log(`[fallback-geometry] page-ops calls\n${readFileSync(pageOps.callLog, 'utf8')}`);
        }
        expect(readFileSync(pageOps.callLog, 'utf8')).toContain('REJECTED');
    });
});
