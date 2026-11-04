import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    copyFile, readFile, writeFile, rm, cp, mkdir,
} from 'node:fs/promises';
import {
    existsSync, mkdtempSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {readWorkspaceStateValues} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    openDjvuInApp, openPdfInApp, openDocumentSidebarTab, waitForDjvuLoaded, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {getDjvuNativeToolPaths} from '@electron/features/djvu/main/nativeToolPaths';

const execFileAsync = promisify(execFile);
const sourcePath = resolve('tests/fixtures/djvu/sources/bookmark-component-ids.djvu');

describe('DjVu converted bookmark destinations', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-djvu-bookmark-destinations-${Date.now()}`});

    it('shows Unicode native DjVu bookmarks and follows a component-ID destination', async () => {
        const evidence = resolve(process.env.EVB_ROUND2_EVIDENCE_DIR ?? '.devkit/checks/round2/candidate', 'a38-native-djvu');
        await mkdir(evidence, {recursive: true});
        const fixture = join(evidence, 'indirect');
        await cp(resolve('tests/fixtures/djvu/sources/indirect'), fixture, {recursive: true});
        const djvuPath = join(fixture, 'index.djvu');
        const titles = [
            'Введение — café',
            '章二: Ελληνικά',
        ];
        const quoted = (title: string) => Array.from(Buffer.from(title, 'utf8'), byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
        const outlinePath = join(evidence, 'outline.txt');
        await writeFile(outlinePath, `(bookmarks ("${quoted(titles[0]!)}" "#low-dpi.djvu") ("${quoted(titles[1]!)}" "#high-dpi.djvu"))`);
        await execFileAsync(getDjvuNativeToolPaths().djvused, [
            djvuPath,
            '-e',
            `set-outline "${outlinePath}"`,
            '-s',
        ]);
        const header = await readFile(djvuPath);
        expect(header.toString('ascii', 12, 20)).toBe('DJVMDIRM');
        expect(header[24]! & 0x80, 'indirect indexes select the native desktop preview').toBe(0);
        const session = await sessions.restart({
            clean: true,
            extraEnv: {EVB_PDF_IMAGE_COMBINE_ENABLE: '1'},
        });
        await writeFile(join(evidence, 'session.json'), JSON.stringify({
            name: session.name,
            djvuPath,
        }, null, 2));
        await openDjvuInApp(session.page, djvuPath);
        await waitForDjvuLoaded(session.page);
        await openDocumentSidebarTab(session.page, 'Bookmarks');
        await session.page.waitForFunction(() => document.querySelectorAll('.document-bookmark-item__row').length === 2);
        const renderedTitles = await session.page.$$eval('.document-bookmark-item__row', rows => rows.map(row => row.textContent?.trim()));
        await writeFile(join(evidence, 'titles.json'), JSON.stringify(renderedTitles, null, 2));
        expect(renderedTitles).toEqual(titles);
        await clickFoundAsUser(session.page, (title: string) => Array.from(document.querySelectorAll<HTMLElement>('.document-bookmark-item__row'))
            .find(row => row.textContent?.trim() === title), titles[1]!, {description: 'native DjVu component-ID bookmark'});
        await expect.poll(async () => (await readToolbarPageIndicator(session.page)).renderedPage).toBe(2);
        await session.page.waitForFunction(() => {
            const page = document.querySelector<HTMLElement>('[data-testid="document-page-source-page"][data-page-number="2"]');
            const image = page?.querySelector<HTMLImageElement>('[data-document-page-visual="committed"]');
            const viewport = page?.closest('[data-document-viewer-chassis-viewport]')?.getBoundingClientRect();
            const rect = page?.getBoundingClientRect();
            return image?.complete && image.naturalWidth > 0 && viewport && rect
                && Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top) > 8;
        });
        await writeFile(join(evidence, 'destination.json'), JSON.stringify(await readToolbarPageIndicator(session.page), null, 2));
        await session.page.screenshot({path: join(evidence, 'bookmarks.png')});
        await writeFile(join(evidence, 'titles-final.json'), JSON.stringify(renderedTitles, null, 2));
        await writeFile(join(evidence, 'rendered-sidebar.txt'), await session.page.$eval('body', body => body.innerText));
    });

    it('reports bookmark metadata failure and preserves the existing destination', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-e2e-djvu-outline-failure-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        const djvuPath = join(directory, 'large-outline.djvu');
        const outlinePath = join(directory, 'outline.txt');
        const outputPath = join(directory, 'converted.pdf');
        const previousBytes = '%PDF-1.4\nprevious destination bytes\n';
        await copyFile(sourcePath, djvuPath);
        await writeFile(outlinePath, `(bookmarks ("${'Large outline title '.repeat(16_000)}" "#1"))`);
        await writeFile(outputPath, previousBytes);
        const session = await sessions.restart({
            clean: true,
            sessionName: () => `e2e-djvu-outline-failure-${Date.now()}`,
            extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: outputPath},
        });
        await openDjvuInApp(session.page, djvuPath, 120_000);
        await waitForDjvuLoaded(session.page, 120_000);
        await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
        await clickAsUser(session.page, '.convert-advanced-toggle');
        await waitForFunctionInPage(session.page, () => {
            const radio = document.querySelector<HTMLButtonElement>('[role="radio"][value="direct-1"]');
            return Boolean(radio && !radio.disabled);
        }, {timeout: 30_000});
        await clickAsUser(session.page, '[role="radio"][value="direct-1"]');
        await expect.poll(() => session.page.evaluate(() => document
            .querySelector('[role="dialog"] .convert-option [role="checkbox"]')
            ?.getAttribute('aria-checked'))).toBe('true');
        // Make extraction fail only after the dialog offered preservation.
        // An outline unreadable at dialog load correctly offers no checkbox.
        await execFileAsync(getDjvuNativeToolPaths().djvused, [
            djvuPath,
            '-e',
            `set-outline "${outlinePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
            '-s',
        ]);
        await clickFoundAsUser(session.page, () => Array.from(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
            .find(element => element.textContent?.includes('Convert DjVu to PDF'))
            ?.querySelectorAll<HTMLButtonElement>('button') ?? [])
            .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled), null, {
            description: 'Convert with default bookmark preservation',
            timeoutMs: 30_000,
        });
        const hasFailure = () => session.page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]'))
            .some(element => element.innerText.includes('Conversion failed')));
        await expect.poll(async () => await hasFailure() || await readFile(outputPath, 'utf8') !== previousBytes,
            {timeout: 60_000}).toBe(true);
        expect(await hasFailure(), 'the failed preservation is visible').toBe(true);
        expect(await readFile(outputPath, 'utf8'), 'failure leaves previous destination bytes intact').toBe(previousBytes);
        const diagnostics = await readFile(join(process.cwd(), '.devkit', 'sessions', session.name, 'session.log'), 'utf8');
        expect(diagnostics, 'the failure belongs to outline extraction').toContain('stdout exceeded 262144 bytes');
    });

    it('preserves component-ID bookmark targets in the saved PDF and navigates after reopening', async () => {
        const outputDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-djvu-bookmarks-'));
        onTestFinished(() => rm(outputDirectory, {
            recursive: true,
            force: true,
        }));
        const outputPath = join(outputDirectory, 'converted.pdf');
        const session = await sessions.restart({
            clean: true,
            sessionName: () => `e2e-djvu-bookmark-destinations-${Date.now()}`,
            extraEnv: {
                EVB_E2E_SAVE_DIALOG_PATH: outputPath,
                EVB_PDF_IMAGE_COMBINE_ENABLE: '1',
            },
        });
        await openDjvuInApp(session.page, sourcePath, 120_000);
        await waitForDjvuLoaded(session.page, 120_000);
        await clickAsUser(session.page, '[data-focus-restore="djvu-convert"]');
        await waitForFunctionInPage(session.page, () => {
            const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
                .find(element => element.textContent?.includes('Convert DjVu to PDF'));
            if (!dialog) return false;
            const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
                .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled);
            return button !== undefined;
        }, {timeout: 30_000});
        await clickAsUser(session.page, '.convert-advanced-toggle');
        await waitForFunctionInPage(session.page, () => {
            const radio = document.querySelector<HTMLButtonElement>('[role="radio"][value="direct-1"]');
            return Boolean(radio && !radio.disabled);
        }, {timeout: 30_000});
        await clickAsUser(session.page, '[role="radio"][value="direct-1"]');
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('[role="radio"][value="direct-1"]')?.getAttribute('aria-checked') === 'true'
        ), {timeout: 5_000});
        await clickFoundAsUser(session.page, () => Array.from(Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
            .find(element => element.textContent?.includes('Convert DjVu to PDF'))
            ?.querySelectorAll<HTMLButtonElement>('button') ?? [])
            .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled), null, {
            description: 'Convert in the DjVu conversion dialog',
            timeoutMs: 30_000,
        });
        await expect.poll(() => existsSync(outputPath), {timeout: 300_000}).toBe(true);
        const qpdf = getPdfNativeToolPaths().qpdf;
        const {stdout: outlineJson} = await execFileAsync(qpdf, [
            '--json',
            '--json-key=outlines',
            outputPath,
        ]);
        const outline = JSON.parse(outlineJson) as {outlines: Array<{
            action?: unknown;
            dest?: unknown;
            destpageposfrom1?: number;
            kids: unknown[];
            title: string;
        }>;};
        expect(outline.outlines.map(entry => ({
            hasDestination: entry.dest !== undefined || entry.action !== undefined,
            page: entry.destpageposfrom1,
            title: entry.title,
        }))).toEqual([
            {
                hasDestination: true,
                page: 1,
                title: 'Page one',
            },
            {
                hasDestination: true,
                page: 2,
                title: 'Page two component target',
            },
            {
                hasDestination: true,
                page: 3,
                title: 'Page three numeric control',
            },
        ]);

        await clickAsUser(session.page, '.tab-list .tab.is-active .tab-close');
        // Reopening the same path before the close finishes would match the
        // closing document instead of opening the saved file.
        await expect.poll(async () => (
            await readWorkspaceStateValues<{originalPath?: string | null}>(session.page, ['originalPath'])
        ).originalPath, {timeout: 10_000}).toBeNull();
        await openPdfInApp(session.page, outputPath, 120_000);
        await waitForPdfLoaded(session.page, 120_000);
        await openDocumentSidebarTab(session.page, 'Bookmarks');
        for (const [
            title,
            pageNumber,
        ] of [
                [
                    'Page two component target',
                    2,
                ],
                [
                    'Page one',
                    1,
                ],
            ] as const) {
            const bookmarkRow = await session.page.waitForSelector(`aria/${title}[role="button"]`, {
                visible: true,
                timeout: 15_000,
            });
            expect(bookmarkRow, `bookmark row accessible name is ${title}`).not.toBeNull();
            expect(await bookmarkRow!.evaluate(element => element.matches('.document-bookmark-item__row'))).toBe(true);
            await clickAsUser(session.page, bookmarkRow!);
            await expect.poll(async () => (await readToolbarPageIndicator(session.page)).renderedPage, {timeout: 15_000}).toBe(pageNumber);
            expect((await readToolbarPageIndicator(session.page)).renderedPage).toBe(pageNumber);
        }
    }, 420_000);
});
