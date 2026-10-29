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
import {
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp, clickVisibleToolbarButton,
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
        'compact-fit-split',
        'identity-lossless',
    ])
        it(mode, async () => {
            const {page} = fixture.getSession();
            const source = resolve(evidence, `${mode}-source.pdf`);
            writeFileSync(source, Buffer.from(readFileSync(resolve('tests/fixtures/release/scan-cleanup-final-graph.pdf.hex'), 'utf8').replace(/\s/gu, ''), 'hex'));
            if (mode === 'compact-fit-split') {
                const sourceDocument = await PDFDocument.load(readFileSync(source), {updateMetadata: false});
                for (const sourcePage of sourceDocument.getPages()) {
                    for (const ref of sourcePage.node.Annots()?.asArray() ?? []) {
                        const annotation = sourceDocument.context.lookup(ref, PDFDict);
                        if (sourceDocument.context.lookup(annotation.get(PDFName.of('Subtype')))?.toString() === '/Link') {
                            annotation.delete(PDFName.of('A'));
                            annotation.set(PDFName.of('Dest'), sourceDocument.context.obj([
                                sourceDocument.getPage(0).ref,
                                PDFName.of('Fit'),
                            ]));
                        }
                    }
                }
                writeFileSync(source, await sourceDocument.save());
            }
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
            for (const toast of await page.$$('button[data-slot="close"]')) {
                if (await toast.isVisible()) await clickAsUser(page, toast);
            }
            await clickVisibleToolbarButton(page, 'Scan cleanup');
            await page.waitForFunction(() => document.querySelectorAll('.scan-thumbnail-exclude-toggle').length === 3
                && document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed', {timeout: 90000});
            if (await page.$('.scan-cleanup-first-run-guidance')) {
                await clickAsUser(page, '.scan-cleanup-first-run-guidance button');
                await page.waitForSelector('.scan-cleanup-first-run-guidance', {hidden: true});
            }
            const choices: Record<string, string> = {};
            async function toggle(control: string, wanted: boolean) {
                if (await page.$eval(control, el => el.getAttribute('aria-checked') === 'true') !== wanted)
                    await clickAsUser(page, control);
                await page.waitForFunction((control, wanted) => document.querySelector(control)?.getAttribute('aria-checked') === String(wanted), {}, control, wanted);
                choices[control] = String(wanted);
            }
            const inclusion = [
                'true',
                'true',
                String(mode === 'identity-lossless'),
            ];
            const exclusion = '.scan-thumbnail-overlay[data-page-number="3"] .scan-thumbnail-exclude-toggle';
            await toggle(exclusion, mode === 'identity-lossless');

            await toggle('[data-settings-scope="all"]', true);
            const layout = mode === 'compact-fit-split' ? 'Force two-page spreads' : 'Force single pages';
            if (await page.$eval('[aria-label="Page layout"]', el => el.textContent?.trim()) !== layout) {
                await clickAsUser(page, '[aria-label="Page layout"]');
                await clickFoundAsUser(page, layout => Array.from(document.querySelectorAll('[role="option"]'))
                    .find(el => el.checkVisibility() && el.textContent?.trim() === layout), layout, {description: layout});
            }
            await page.waitForFunction(layout => {
                const control = document.querySelector('[aria-label="Page layout"]');
                return control?.textContent?.trim() === layout && control.getAttribute('aria-expanded') === 'false';
            }, {}, layout);
            async function checkbox(label: string, wanted: boolean) {
                const id = await page.$$eval('label', (labels, text) => labels.find(el => el.textContent?.trim() === text)?.getAttribute('for'), label);
                expect(id, label).toBeTruthy();
                await toggle(`[id="${id}"]`, wanted);
            }
            await checkbox('Keep original images', !mode.startsWith('compact'));
            if (mode.startsWith('compact')) {
                await toggle('[role=radio][aria-label="Auto — recommended per page"]', true);
            }
            await checkbox('Crop each output page to its content', false);
            await checkbox('Match page size with other pages', false);
            await checkbox('Skip blank pages', false);
            // Auto Color bypasses illumination normalization; keep this fixture on that path.
            if (mode.startsWith('compact')) await page.waitForFunction(() => {
                const included = Array.from(document.querySelectorAll('.scan-thumbnail-status:not(.is-excluded)'));
                return included.length === 2 && included.every(el => el.textContent?.trim().endsWith('Color'));
            });
            await page.waitForFunction(selector => {
                const button = document.querySelector<HTMLButtonElement>(selector);
                return button && !button.disabled && button.textContent?.includes('Clean');
            }, { timeout: 90000 }, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
            expect(await page.$$eval('.scan-thumbnail-exclude-toggle', els => els.map(el => el.getAttribute('aria-checked')))).toEqual(inclusion);
            expect(await page.evaluate(choices => Object.entries(choices)
                .every(choice => document.querySelector(choice[0])?.getAttribute('aria-checked') === choice[1]), choices)).toBe(true);
            expect(await page.$eval('[aria-label="Page layout"]', el => el.textContent?.trim())).toBe(layout);
            await page.screenshot({ path: resolve(evidence, `${mode}-settings.png`) });
            await clickAsUser(page, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
            await page.waitForFunction(source => {
                const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.readActiveWorkspaceStateValues?.(['originalPath']);
                return typeof state?.originalPath === 'string' && state.originalPath !== source && state.originalPath.endsWith('— cleaned.pdf');
            }, { timeout: 180000 }, source);
            const state = await readWorkspaceStateValues(page, ['originalPath']);
            const saved = resolve(evidence, `${mode}-output.pdf`);
            copyFileSync(state.originalPath as string, saved);
            const savedDocument = await PDFDocument.load(readFileSync(saved), { updateMetadata: false });
            const savedPdf = await pdfjs.getDocument({
                data: new Uint8Array(readFileSync(saved)),
                ...createPdfjsNodeDocumentOptions(),
            }).promise;
            try {
                if (mode === 'compact-fit-split') {
                    expect(savedPdf.numPages).toBe(4);
                    const links = [];
                    for (let n = 1; n <= savedPdf.numPages; n += 1)
                        links.push(...(await (await savedPdf.getPage(n)).getAnnotations()).filter(annotation => annotation.subtype === 'Link'));
                    expect(links.length).toBeGreaterThan(0);
                    for (const link of links) {
                        expect(link.dest[1].name).toBe('Fit');
                        expect(await savedPdf.getPageIndex(link.dest[0])).toBe(0);
                    }
                    return;
                }
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
            }
            finally {
                await savedPdf.loadingTask.destroy();
            }
        }, 240000);
});
