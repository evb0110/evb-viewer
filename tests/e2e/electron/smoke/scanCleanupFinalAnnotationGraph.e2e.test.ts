import {
    PDFDict, PDFDocument, PDFHexString, PDFName, PDFString,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPdfjsNodeDocumentOptions } from '@electron/features/search/pdfjsPageTexts';
import {
    copyFileSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
    describe, it, expect,
} from 'vitest';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { clickAsUser } from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp, waitForPdfLoaded, waitForViewerInteractive, clickVisibleToolbarButton,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow, readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR } from '@contracts/scan-cleanup/toolbarSelectors';
const fixture = createElectronE2ESessionFixture({ sessionName: () => `e2e-scanlinks6r8-${Date.now()}` });
const evidence = resolve(process.env.SCANLINKS6_PROOF_DIR ?? `.devkit/tmp/cleanup-final-graph-${Date.now()}`, 'final-annotation-graph');
mkdirSync(evidence, { recursive: true });
describe('public catalog cleanup proof', () => {
    for (const mode of [
        'lossless',
        'lossless-crop',
        'compact',
        'compact-threads',
        'identity-lossless',
    ])
        it(mode, async () => {
            const session = fixture.getSession();
            const page = session.page;
            const source = resolve(evidence, `${mode}-source.pdf`);
            writeFileSync(source, Buffer.from(readFileSync(resolve('tests/fixtures/release/scan-cleanup-final-graph.pdf.hex'), 'utf8').replace(/\s/gu, ''), 'hex'));
            if (mode === 'lossless-crop') {
                const sourceDocument = await PDFDocument.load(readFileSync(source), {updateMetadata: false});
                sourceDocument.getPage(1).setCropBox(0, 0, 100, 120);
                writeFileSync(source, await sourceDocument.save());
            }
            if (mode === 'compact-threads') {
                const sourceDocument = await PDFDocument.load(readFileSync(source), {updateMetadata: false});
                sourceDocument.catalog.delete(PDFName.of('AcroForm'));
                for (const page of sourceDocument.getPages()) {
                    const entries = page.node.Annots()?.asArray() ?? [];
                    page.node.set(PDFName.of('Annots'), sourceDocument.context.obj(entries.filter(ref =>
                        sourceDocument.context.lookup(ref, PDFDict).get(PDFName.of('Subtype'))?.toString() !== '/Widget',
                    )));
                }
                writeFileSync(source, await sourceDocument.save());
            }
            await openPdfInApp(page, source);
            await waitForPdfLoaded(page);
            await waitForViewerInteractive(page);
            await page.screenshot({ path: resolve(evidence, `${mode}-source.png`) });
            await clickVisibleToolbarButton(page, 'Scan cleanup');
            await page.waitForSelector('.scan-cleanup-surface');
            await page.waitForFunction(() => document.querySelectorAll('.scan-thumbnail-exclude-toggle').length === 3, { timeout: 90000 });
            const exclusion = await page.$$('.scan-thumbnail-exclude-toggle');
            if (await exclusion[2]!.evaluate(el => el.getAttribute('aria-checked') === 'true') !== (mode === 'identity-lossless'))
                await clickAsUser(page, exclusion[2]!);
            async function checkbox(labelText: string, wanted: boolean) {
                const labels = await page.$$('label');
                for (const label of labels)
                    if (await label.evaluate((el, text) => el.textContent?.trim() === text, labelText)) {
                        const current = await label.evaluate(el => {
                            const id = el.getAttribute('for');
                            const control = id ? document.getElementById(id) : el.parentElement?.querySelector('[role="checkbox"],input[type="checkbox"]');
                            return control?.getAttribute('aria-checked') === 'true' || (control as HTMLInputElement)?.checked === true;
                        });
                        if (current !== wanted)
                            await clickAsUser(page, label);
                        return;
                    }
                throw new Error(`Checkbox label unavailable: ${labelText}`);
            }
            await checkbox('Preserve original quality (no rasterization)', !mode.startsWith('compact'));
            await clickAsUser(page, '[data-settings-scope="all"]');
            await page.waitForFunction(() => document.querySelector('[data-settings-scope="all"]')?.getAttribute('aria-checked') === 'true');
            await clickAsUser(page, '[aria-label="Page layout"]');
            await page.waitForSelector('[role="option"]');
            const layouts = await page.$$('[role="option"]');
            const single = await Promise.all(layouts.map(option => option.evaluate(el => [
                'Force single pages',
                'Single page',
            ].includes(el.textContent?.trim() ?? ''))));
            if (!single.includes(true))
                throw new Error('Single-page layout option unavailable');
            await clickAsUser(page, layouts[single.indexOf(true)]!);
            await checkbox('Crop each output page to its content', false);
            await checkbox('Skip blank pages', false);
            await checkbox('Match page size with other pages', false);
            if (mode.startsWith('compact')) {
                await clickAsUser(page, '[role=radio][aria-label="Auto — recommended per page"]');
                if (await page.$eval('.scan-cleanup-advanced-toggle', el => el.getAttribute('aria-expanded') !== 'true'))
                    await clickAsUser(page, '.scan-cleanup-advanced-toggle');
                await checkbox('Normalize uneven illumination', false);
            }
            expect(await page.$$eval('.scan-thumbnail-exclude-toggle', els => els.map(el => el.getAttribute('aria-checked')))).toEqual(mode === 'identity-lossless' ? [
                'true',
                'true',
                'true',
            ] : [
                'true',
                'true',
                'false',
            ]);
            await page.screenshot({ path: resolve(evidence, `${mode}-settings.png`) });
            await page.waitForFunction(selector => {
                const button = document.querySelector<HTMLButtonElement>(selector);
                return button && !button.disabled && button.textContent?.includes('Clean');
            }, { timeout: 90000 }, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
            await clickAsUser(page, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
            await page.waitForFunction(source => {
                const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.readActiveWorkspaceStateValues?.(['originalPath']);
                return typeof state?.originalPath === 'string' && state.originalPath !== source && state.originalPath.endsWith('— cleaned.pdf');
            }, { timeout: 180000 }, source);
            const state = await readWorkspaceStateValues(page, ['originalPath']);
            copyFileSync(state.originalPath as string, resolve(evidence, `${mode}-output.pdf`));
            const saved = resolve(evidence, `${mode}-output.pdf`);
            await openPdfInApp(page, saved);
            await waitForPdfLoaded(page);
            await waitForViewerInteractive(page);
            await page.screenshot({ path: resolve(evidence, `${mode}-reopened.png`) });
            const savedDocument = await PDFDocument.load(readFileSync(saved), { updateMetadata: false });
            const savedPdf = await pdfjs.getDocument({
                data: new Uint8Array(readFileSync(saved)),
                ...createPdfjsNodeDocumentOptions(),
            }).promise;
            try {
                const pages = [];
                for (let n = 1; n <= savedPdf.numPages; n += 1)
                    pages.push(await (await savedPdf.getPage(n)).getAnnotations());
                const entries = savedDocument.getPages().flatMap(page => (page.node.Annots()?.asArray() ?? []).map(ref => ({
                    ref,
                    annotation: savedDocument.context.lookup(ref, PDFDict),
                })));
                const text = (entry: typeof entries[number]) => entry.annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText();
                const root = entries.find(entry => text(entry) === 'remote root');
                const reply = entries.find(entry => text(entry) === 'reply');
                expect.soft(root).toBeDefined();
                expect.soft(reply).toBeDefined();
                expect.soft(reply?.annotation.get(PDFName.of('IRT'))?.toString()).toBe(root?.ref.toString());
                const link = pages.flat().find(annotation => annotation.subtype === 'Link');
                expect.soft(link).toBeDefined();
                expect.soft(await savedPdf.getPageIndex(link!.dest[0])).toBe(0);
                if (mode !== 'compact-threads') expect.soft(pages.map(page => page.find(annotation => annotation.subtype === 'Widget')?.buttonValue)).toEqual(mode === 'identity-lossless' ? [
                    'Option C',
                    'Option A',
                    'Option B',
                ] : [
                    'Option C',
                    'Option A',
                ]);
                expect.soft(savedPdf.numPages).toBe(mode === 'identity-lossless' ? 3 : 2);
                expect.soft(savedDocument.catalog.has(PDFName.of('StructTreeRoot'))).toBe(mode === 'identity-lossless');
                expect.soft(savedDocument.catalog.has(PDFName.of('MarkInfo'))).toBe(mode === 'identity-lossless');
                writeFileSync(resolve(evidence, `${mode}-annotations.json`), JSON.stringify(pages, null, 2));
            }
            finally {
                await savedPdf.loadingTask.destroy();
            }
        }, 240000);
});
