import {
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRawStream,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
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

const FIXTURE_PNG = 'native/scan-cleanup/tests/fixtures/leaf-edge/prym-p00063-fore-edge-150dpi.png';
const FIXTURE_DPI = 150;

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-leaf-edge-${Date.now()}`});

/** A scanned book page whose recto carries the brown fore-edge strip along its right border. */
async function createForeEdgeBookPagePdf(path: string) {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(readFileSync(resolve(process.cwd(), FIXTURE_PNG)));
    const width = image.width / FIXTURE_DPI * 72;
    const height = image.height / FIXTURE_DPI * 72;
    doc.addPage([
        width,
        height,
    ]).drawImage(image, {
        x: 0,
        y: 0,
        width,
        height,
    });
    writeFileSync(path, await doc.save());
}

interface IPageImage {
    bitsPerComponent: number | null;
    colorSpace: string | null;
    filter: string | null;
    imageMask: boolean;
}

async function readFirstPageImages(path: string): Promise<IPageImage[]> {
    const doc = await PDFDocument.load(readFileSync(path));
    const resources = doc.getPage(0).node.Resources();
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const images: IPageImage[] = [];
    for (const [
        , reference,
    ] of xObjects?.entries() ?? []) {
        const stream = doc.context.lookup(reference);
        if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
        const bits = stream.dict.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber);
        images.push({
            bitsPerComponent: bits?.asNumber() ?? null,
            colorSpace: stream.dict.get(PDFName.of('ColorSpace'))?.toString() ?? null,
            filter: stream.dict.get(PDFName.of('Filter'))?.toString() ?? null,
            imageMask: stream.dict.get(PDFName.of('ImageMask'))?.toString() === 'true',
        });
    }
    return images;
}

describe('scan cleanup of a photographed book page', () => {
    it('writes a text page with a tinted fore-edge strip as black-and-white text', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-cleanup-leaf-edge-'));
        onTestFinished(() => rm(sourceDirectory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(sourceDirectory, 'fore-edge-book-page.pdf');
        await createForeEdgeBookPagePdf(sourcePath);
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
            if (!action || action.disabled || action.getAttribute('aria-disabled') === 'true') return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return (hit === action || action.contains(hit))
                && document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText);
        }, {timeout: 120_000});
        await clickAsUser(session.page, '.scan-cleanup-toolbar-primary-action');

        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return typeof active?.originalPath === 'string'
                && active.originalPath !== source
                && active.originalPath.endsWith('— cleaned.pdf');
        }, {timeout: 180_000}, sourcePath);
        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = outputState.originalPath;
        expect(typeof outputPath).toBe('string');

        const images = await readFirstPageImages(outputPath as string);
        console.log('scan-cleanup-leaf-edge-images', JSON.stringify(images));
        expect(images.length).toBeGreaterThan(0);
        expect(images.filter(image => image.bitsPerComponent !== 1 && !image.imageMask)).toEqual([]);
    }, 300_000);
});
