import {execFileSync} from 'node:child_process';
import {
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    decode,
    encode,
} from 'fast-png';
import {PDFDocument} from 'pdf-lib';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
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

const FIXTURE_DPI = 150;
const FIXTURE_WIDTH_PX = 825;
const FIXTURE_HEIGHT_PX = 1_275;
const PX_PER_MM = FIXTURE_DPI / 25.4;
/**
 * Where each leaf's text block starts, in pixels at 150 DPI. Leaves 1 and 2
 * are a title opening whose ink starts 1 mm apart, 3 to 4 mm under the
 * running heads' tail (leaf 8); leaves 3 to 7 are a shoulder and the running
 * heads. A cluster grown from the lowest ink top ends between the two title
 * leaves and printed them 4 mm apart.
 */
const LEAF_INK_TOPS_PX = [
    146,
    152,
    100,
    118,
    118,
    118,
    118,
    126,
];

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-ink-placement-${Date.now()}`});

async function createTitleOpeningPdf(path: string) {
    const doc = await PDFDocument.create();
    for (const top of LEAF_INK_TOPS_PX) {
        const pixels = new Uint8Array(FIXTURE_WIDTH_PX * FIXTURE_HEIGHT_PX).fill(245);
        for (let line = 0; line < 12; line += 1) {
            for (let column = 0; column < 26; column += 1) {
                const left = 150 + column * 20;
                const glyphTop = top + line * 40;
                for (let y = glyphTop; y < glyphTop + 15; y += 1) {
                    pixels.fill(40, y * FIXTURE_WIDTH_PX + left, y * FIXTURE_WIDTH_PX + left + 12);
                }
            }
        }
        const image = await doc.embedPng(encode({
            width: FIXTURE_WIDTH_PX,
            height: FIXTURE_HEIGHT_PX,
            channels: 1,
            data: pixels,
        }));
        const width = FIXTURE_WIDTH_PX / FIXTURE_DPI * 72;
        const height = FIXTURE_HEIGHT_PX / FIXTURE_DPI * 72;
        doc.addPage([
            width,
            height,
        ]).drawImage(image, {
            x: 0,
            y: 0,
            width,
            height,
        });
    }
    writeFileSync(path, await doc.save());
}

/** The first painted row of an output page, in millimetres from its top. */
function readInkTopMm(pdfPath: string, pageNumber: number, outputPrefix: string) {
    execFileSync(getPdfNativeToolPaths().pdftoppm, [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-singlefile',
        '-gray',
        '-png',
        '-r',
        String(FIXTURE_DPI),
        pdfPath,
        outputPrefix,
    ]);
    const image = decode(readFileSync(`${outputPrefix}.png`));
    for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            if ((image.data[(y * image.width + x) * image.channels] ?? 255) < 128) {
                return y / PX_PER_MM;
            }
        }
    }
    throw new Error(`Output page ${String(pageNumber)} has no ink`);
}

describe('scan cleanup ink placement', () => {
    it('prints two title leaves whose ink agrees at one height', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-cleanup-ink-placement-'));
        onTestFinished(() => rm(sourceDirectory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(sourceDirectory, 'title-opening.pdf');
        await createTitleOpeningPdf(sourcePath);
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
        const {originalPath: outputPath} = await readWorkspaceStateValues(session.page, ['originalPath']);
        expect(typeof outputPath).toBe('string');

        const versoTopMm = readInkTopMm(outputPath as string, 1, join(sourceDirectory, 'verso'));
        const rectoTopMm = readInkTopMm(outputPath as string, 2, join(sourceDirectory, 'recto'));
        const scannedApartMm = (LEAF_INK_TOPS_PX[1]! - LEAF_INK_TOPS_PX[0]!) / PX_PER_MM;
        console.log('scan-cleanup-ink-placement-tops-mm', JSON.stringify({
            versoTopMm,
            rectoTopMm,
            scannedApartMm,
        }));
        expect(Math.abs(rectoTopMm - versoTopMm)).toBeLessThanOrEqual(scannedApartMm);
    }, 300_000);
});
