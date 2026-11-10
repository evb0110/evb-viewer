import {
    mkdtempSync,
    writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    PDFDict,
    PDFDocument,
    type PDFFont,
    PDFName,
    PDFNumber,
    type PDFPage,
    StandardFonts,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import type {TScanCleanupDetectionJobState} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {readPdfPageSnapshots} from '@tests/e2e/electron/helpers/fixtures';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
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

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-born-digital-spreads-${Date.now()}`});

const PAGE_WIDTH = 464.882;
const PAGE_HEIGHT = 680.315;
const WORDS = 'the commission prepared a critical edition of the slavonic bible from every surviving manuscript tradition'.split(' ');

/** A justified page body: a marker line, then full-width lines of words. */
function drawPageBody(page: PDFPage, font: PDFFont, left: number, marker: string) {
    page.drawText(marker, {
        x: left,
        y: 600,
        size: 11,
        font,
    });
    for (let line = 0; line < 34; line += 1) {
        const words = WORDS.slice(line % 5).concat(WORDS).slice(0, 9).join(' ');
        page.drawText(words, {
            x: left,
            y: 575 - line * 14,
            size: 10,
            font,
        });
    }
}

/**
 * An InDesign-style spread export: a lone first page at page size, then pages
 * two pages wide with a blank paper gutter, one of them with a blank verso.
 * Its font carries glyph widths, as an exporter writes them.
 */
async function createBornDigitalSpreadsPdf(path: string) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    drawPageBody(doc.addPage([
        PAGE_WIDTH,
        PAGE_HEIGHT,
    ]), font, 70, 'TITLE PAGE');
    const spread = doc.addPage([
        PAGE_WIDTH * 2,
        PAGE_HEIGHT,
    ]);
    drawPageBody(spread, font, 70, 'VERSO TWO');
    drawPageBody(spread, font, PAGE_WIDTH + 55, 'RECTO TWO');
    drawPageBody(doc.addPage([
        PAGE_WIDTH * 2,
        PAGE_HEIGHT,
    ]), font, PAGE_WIDTH + 55, 'RECTO THREE');
    await font.embed();
    const fontDictionary = doc.context.lookup(font.ref, PDFDict);
    const codes = Array.from({length: 95}, (_, index) => 32 + index);
    fontDictionary.set(PDFName.of('FirstChar'), PDFNumber.of(32));
    fontDictionary.set(PDFName.of('LastChar'), PDFNumber.of(126));
    fontDictionary.set(PDFName.of('Widths'), doc.context.obj(codes.map(code => Math.round(font.widthOfTextAtSize(String.fromCharCode(code), 1000)))));
    writeFileSync(path, await doc.save());
}

describe('scan cleanup of a born-digital spread export', () => {
    it('cuts every facing pair where its pages meet and keeps each page\'s text', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-born-digital-spreads-'));
        onTestFinished(() => rm(sourceDirectory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(sourceDirectory, 'spread-export.pdf');
        await createBornDigitalSpreadsPdf(sourcePath);
        const observed: TScanCleanupDetectionJobState[] = [];
        await session.page.exposeFunction('__recordBornDigitalSpreadDetection', (state: TScanCleanupDetectionJobState) => observed.push(state));
        await session.page.evaluate(() => {
            const probe = window as Window & {__recordBornDigitalSpreadDetection?: (state: TScanCleanupDetectionJobState) => Promise<void>};
            window.electronAPI?.scanCleanup?.onDetectionJobState(state => {void probe.__recordBornDigitalSpreadDetection?.(state);});
        });
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
        await waitForFunctionInPage(session.page, () => {
            const action = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action');
            return action !== null && !action.disabled
                && document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText);
        }, {timeout: 120_000});

        const labels = await session.page.$$eval(
            '.scan-thumbnail-list [data-document-thumbnail-item]',
            items => items.map(item => (item as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
        );
        expect(labels.map(label => label.split(' · ')[0])).toEqual([
            '1 Single',
            '2 Spread',
            '3 Spread',
        ]);
        const completed = observed.findLast(state => state.status === 'completed');
        expect(completed?.results.map(result => result.pagePlanEvidence?.automaticSplit?.xNormalized ?? null)).toEqual([
            null,
            0.5,
            0.5,
        ]);

        await clickAsUser(session.page, '.scan-cleanup-toolbar-primary-action');
        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return typeof active?.originalPath === 'string'
                && active.originalPath !== source
                && active.originalPath.endsWith('— cleaned.pdf');
        }, {timeout: 180_000}, sourcePath);
        const {originalPath: outputPath} = await readWorkspaceStateValues(session.page, ['originalPath']);
        expect(typeof outputPath).toBe('string');
        const outputMarkers = (await readPdfPageSnapshots(outputPath as string))
            .map(page => page.textSnippet.match(/^(?:TITLE PAGE|VERSO TWO|RECTO TWO|RECTO THREE)/)?.[0] ?? page.textSnippet);
        expect(outputMarkers).toEqual([
            'TITLE PAGE',
            'VERSO TWO',
            'RECTO TWO',
            '',
            'RECTO THREE',
        ]);
    }, 300_000);
});
