import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    statSync,
} from 'node:fs';
import {
    mkdir, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import type {TScanCleanupDetectionJobState} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {electronAppTempDirPath} from '@scripts/electron-run/electronRunSessionPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    createLargeScannedFixturePdf, readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-copied-spread-${Date.now()}`});

async function clickText(
    session: ReturnType<typeof sessionFixture.getSession>,
    selector: string,
    text: string,
) {
    await clickFoundAsUser(session.page, (query: {
        selector: string;
        text: string;
    }) => Array.from(document.querySelectorAll<HTMLElement>(query.selector))
        .find(element => element.textContent?.trim() === query.text && element.checkVisibility()), {
        selector,
        text,
    }, {description: `${selector} with text ${text}`});
}

describe('scan cleanup copied spread evidence', () => {
    it('reuses the analyzed page plan for a preview during detection', async () => {
        const evidenceDir = resolve('.devkit/lane-a-1185', `real-app-${process.pid}`);
        await mkdir(evidenceDir, {recursive: true});
        await sessionFixture.restart({extraEnv: {EVB_SCAN_CLEANUP_EVIDENCE_DIR: evidenceDir}});
        const app = sessionFixture.getSession();
        await app.command('windowResize', [
            1280,
            900,
        ]);
        const observed: TScanCleanupDetectionJobState[] = [];
        await app.page.exposeFunction('__recordScanCleanupPlan', (state: TScanCleanupDetectionJobState) => observed.push(state));
        await app.page.evaluate(() => {
            const probe = window as Window & {__recordScanCleanupPlan?: (state: TScanCleanupDetectionJobState) => Promise<void>};
            const api = window.electronAPI?.scanCleanup;
            if (api === undefined || probe.__recordScanCleanupPlan === undefined) throw new Error('Scan cleanup event recorder unavailable');
            api.onDetectionJobState(state => {void probe.__recordScanCleanupPlan!(state);});
        });
        const sourcePath = await createLargeScannedFixturePdf('scan-cleanup-provisional-plan.pdf', 64, 0);
        await openPdfInApp(app.page, sourcePath, 90_000);
        await waitForPdfLoaded(app.page, 90_000);
        await waitForViewerInteractive(app.page, 90_000);
        await clickAsUser(app.page, 'button[aria-label="Scan cleanup"]');
        await app.page.waitForSelector('.scan-cleanup-surface', {visible: true});
        await clickText(app, 'button', 'Got it');
        let analyzed: TScanCleanupDetectionJobState | undefined;
        await vi.waitFor(() => {
            analyzed = observed.find(state => state.status === 'running' && state.progress.completedUnits > 0
                && state.progress.completedUnits < state.progress.totalUnits && state.results.some(result => result.pageNumber === 1));
            expect(analyzed).toBeDefined();
        }, {timeout: 90_000});
        await writeFile(join(evidenceDir, 'observed-provisional.json'), JSON.stringify(analyzed, null, 2));
        const plan = analyzed!.results.find(result => result.pageNumber === requirePageNumber(1))?.pagePlanEvidence;
        expect(plan).toBeDefined();
        const contentBoxes = Object.fromEntries(Object.entries(plan!.outputs).flatMap(([
            half,
            output,
        ]) => (
            output.contentBox === undefined ? [] : [[
                half,
                output.contentBox,
            ]]
        )));
        expect(Object.keys(contentBoxes).length).toBeGreaterThan(0);
        expect(await app.page.$eval('.scan-cleanup-surface', element => element.getAttribute('data-detection-status'))).toBe('pending');
        await clickAsUser(app.page, '.scan-thumbnail-list [data-document-thumbnail-item]:has(.scan-thumbnail-overlay[data-page-number="2"])');
        await clickAsUser(app.page, '.scan-thumbnail-list [data-document-thumbnail-item]:has(.scan-thumbnail-overlay[data-page-number="1"])');
        const appTemp = electronAppTempDirPath(app.name);
        await vi.waitFor(async () => {
            const files = (await readdir(appTemp, {recursive: true})).filter(name => name.endsWith('/manifest.json')
                && name.startsWith('scan-cleanup-preview-'));
            const manifests = await Promise.all(files.map(async name => {
                try {
                    return JSON.parse(await readFile(join(appTemp, name), 'utf8')) as {
                        operation?: string;
                        pages?: Array<{
                            sourcePageIndex: number;
                            options: {automaticContentBoxes?: unknown}
                        }>;
                    };
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                    throw error;
                }
            }));
            const replay = manifests.find(manifest => manifest?.operation === 'render'
                && manifest.pages?.some(page => page.sourcePageIndex === 0
                    && JSON.stringify(page.options.automaticContentBoxes) === JSON.stringify(contentBoxes)));
            expect(replay).toBeDefined();
            await writeFile(join(evidenceDir, 'preview-replay-manifest.json'), JSON.stringify(replay, null, 2));
        }, {timeout: 90_000});
        await app.page.waitForSelector('.cleaned-outputs .uniform-canvas', {
            visible: true,
            timeout: 90_000,
        });
        await waitForFunctionInPage(app.page, () => (
            !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText)
                && Array.from(document.querySelectorAll<HTMLImageElement>('.cleaned-outputs img.preview-pixel:not(.is-outgoing)'))
                    .some(image => image.complete && image.naturalWidth > 0 && image.checkVisibility())
        ), {timeout: 90_000});
        expect(await app.page.$eval('.scan-cleanup-surface', element => element.getAttribute('data-detection-status'))).toBe('pending');
        await app.page.screenshot({path: join(evidenceDir, 'preview.png')});
        await writeFile(join(evidenceDir, 'observed-states.json'), JSON.stringify(observed, null, 2));
    }, 180_000);

    it('completes a spread copied to every page with current detection evidence', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-cleanup-spread-'));
        onTestFinished(() => rm(sourceDirectory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(sourceDirectory, 'e2e-document-ops-cleanup-two.pdf');
        copyFileSync(resolve(process.cwd(), 'tests/fixtures/electron/document-ops-cleanup-two.pdf'), sourcePath);
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);

        for (const toast of await session.page.$$('button[aria-label="Dismiss"]')) {
            if (await toast.isVisible()) await clickAsUser(session.page, toast);
        }
        await clickAsUser(session.page, 'button[aria-label="Scan cleanup"]');
        await session.page.waitForSelector('.scan-cleanup-surface', {
            visible: true,
            timeout: 20_000,
        });
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
        ), {timeout: 120_000});

        await clickAsUser(session.page, '[role="radio"][aria-label="This page (p. 1)"]');
        await clickAsUser(session.page, '[role="combobox"][aria-label="Page layout"]');
        await clickText(session, '[role="option"]', 'Two-page spread');
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText)
        ), {timeout: 120_000});
        await clickAsUser(session.page, '[role="combobox"][aria-label="Output mode"]');
        await waitForFunctionInPage(session.page, () => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
                .some(element => element.innerText.trim() === 'Black-and-white text with color pictures')
        ), {timeout: 5_000});
        await clickText(session, '[role="option"]', 'Black-and-white text with color pictures');
        await waitForFunctionInPage(session.page, () => !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i
            .test(document.body.innerText), {timeout: 120_000});

        await clickAsUser(session.page, 'button[aria-label="Edit picture and fill zones"]');
        await clickText(session, '.zone-editor-controls [role="radio"]', 'Picture');
        const zone = await session.page.$('.zone-editor-polygons');
        expect(zone).toBeTruthy();
        const zoneRect = await zone!.boundingBox();
        expect(zoneRect).toBeTruthy();
        await session.page.mouse.move(zoneRect!.x + zoneRect!.width * 0.25, zoneRect!.y + zoneRect!.height * 0.75);
        await session.page.mouse.down();
        await session.page.mouse.move(zoneRect!.x + zoneRect!.width * 0.5, zoneRect!.y + zoneRect!.height * 0.7, {steps: 12});
        await session.page.mouse.up();
        // The new zone refreshes the preview. The zone stays on screen through
        // that refresh, and a drag made before the refresh finishes adds nothing.
        await waitForFunctionInPage(session.page, () => (
            document.querySelectorAll('.zone-editor-polygon:not(.is-draft)').length === 1
                && /Preview updating|Updating preview/i.test(document.body.innerText)
        ), {timeout: 10_000});
        await session.page.mouse.move(zoneRect!.x + zoneRect!.width * 0.6, zoneRect!.y + zoneRect!.height * 0.2);
        await session.page.mouse.down();
        await session.page.mouse.move(zoneRect!.x + zoneRect!.width * 0.8, zoneRect!.y + zoneRect!.height * 0.3, {steps: 12});
        await session.page.mouse.up();
        expect(await session.page.evaluate(() => /Preview updating|Updating preview/i.test(document.body.innerText))).toBe(true);
        await waitForFunctionInPage(session.page, () => (
            !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText)
                && !document.querySelector('.drag-overlay-layer')?.hasAttribute('inert')
        ), {timeout: 120_000});
        expect(await session.page.$$eval('.zone-editor-polygon:not(.is-draft)', polygons => polygons.length)).toBe(1);

        await clickAsUser(session.page, 'button[aria-label="Edit picture and fill zones"]');
        await clickText(session, 'button', 'Copy this page\'s settings to…');
        await waitForFunctionInPage(session.page, () => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .some(element => element.innerText.trim() === 'All pages')
        ), {timeout: 5_000});
        await clickText(session, '[role="menuitem"]', 'All pages');
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText)
        ), {timeout: 120_000});

        await clickAsUser(session.page, '[role="radio"][aria-label="All 2 pages"]');
        await waitForFunctionInPage(session.page, () => {
            const action = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action');
            if (!action || action.disabled || action.getAttribute('aria-disabled') === 'true') return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return (hit === action || action.contains(hit))
                && document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText);
        }, {timeout: 120_000});
        const action = await session.page.$('.scan-cleanup-toolbar-primary-action');
        const actionRect = await action!.boundingBox();
        expect(actionRect).toBeTruthy();
        const actionState = await action!.evaluate((element, rect) => ({
            disabled: element instanceof HTMLButtonElement && element.disabled,
            ariaDisabled: element.getAttribute('aria-disabled'),
            rect,
            hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.textContent,
            detectionStatus: document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status'),
            previewRunning: /Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText),
        }), actionRect!);
        console.log('scan-cleanup-copied-spread-run', JSON.stringify(actionState));
        expect(actionState.disabled).toBe(false);
        expect(actionState.ariaDisabled).not.toBe('true');
        expect(actionState.detectionStatus).toBe('completed');
        expect(actionState.previewRunning).toBe(false);
        await clickAsUser(session.page, action!);

        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return (typeof active?.originalPath === 'string'
                    && active.originalPath !== source
                    && active.originalPath.endsWith('— cleaned.pdf'))
                || document.body.innerText.includes('layout-mismatch');
        }, {timeout: 180_000}, sourcePath);
        expect(await session.page.evaluate(() => document.body.innerText)).not.toContain('layout-mismatch');
        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = typeof outputState.originalPath === 'string' ? outputState.originalPath : null;
        expect(outputPath).toBeTruthy();
        expect(existsSync(outputPath!)).toBe(true);
        expect(statSync(outputPath!).size).toBeGreaterThan(0);
        expect((await readPdfPageSnapshots(outputPath!)).length).toBeGreaterThan(0);
    }, 240_000);
});
