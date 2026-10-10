import {
    createHash, randomUUID,
} from 'node:crypto';
import {
    PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';
import {createPdfjsNodeDocumentOptions} from '@electron/features/search/pdfjsPageTexts';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {sessionDir} from '@scripts/electron-run/electronRunSessionPaths';
import {isRecord} from '@contracts/runtimeGuards';
import {decodeWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {waitForRendererReady} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    createLargeScannedFixturePdf,
    createMultiPageTextFixturePdf,
    readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    openAnnotationsTab,
    openPdfInApp,
    clickVisibleToolbarButton,
    goToPageViaToolbar,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-required-page-ops-${Date.now()}`});

async function openCleanup(session: ReturnType<typeof sessionFixture.getSession>) {
    for (const toast of await session.page.$$('button[aria-label="Dismiss"]')) {
        if (await toast.isVisible()) await clickAsUser(session.page, toast);
    }
    await clickAsUser(session.page, 'button[aria-label="Scan cleanup"]');
    await session.page.waitForSelector('.scan-cleanup-surface', {
        timeout: 20_000,
        visible: true,
    });
}

describe('scan cleanup required page ops', () => {
    it('keeps editable notes and markup aligned without baking their appearances into pixels', async () => {
        const evidence = join(process.cwd(), '.devkit', 'tmp', `cleanup-note-geometry-${randomUUID()}`);
        const session = await sessionFixture.restart({extraEnv: {EVB_SCAN_CLEANUP_EVIDENCE_DIR: evidence}});
        const fixture = await createLargeScannedFixturePdf('scan-cleanup-notes.pdf', 3, 0, 0.125, {runOwner: `${session.name}-notes`});
        const source = await PDFDocument.load(readFileSync(fixture));
        for (const page of source.getPages()) page.scale(0.1, 0.1);
        const plainPath = join(dirname(fixture), 'scan-cleanup-without-notes.pdf');
        writeFileSync(plainPath, await source.save());
        for (const [
            index,
            page,
        ] of source.getPages().entries()) {
            const note = source.context.register(source.context.obj({
                Type: 'Annot',
                Subtype: 'Text',
                Rect: [
                    8,
                    45,
                    12,
                    49,
                ],
                P: page.ref,
                Contents: PDFHexString.fromText(`Cleanup note Ω page ${index + 1}`),
            }));
            const markup = source.context.register(source.context.obj({
                Type: 'Annot',
                Subtype: 'Highlight',
                Rect: [
                    8,
                    37,
                    35,
                    41,
                ],
                P: page.ref,
                QuadPoints: [
                    8,
                    41,
                    35,
                    41,
                    8,
                    37,
                    35,
                    37,
                ],
                C: [
                    1,
                    1,
                    0,
                ],
                Contents: PDFHexString.fromText(`Cleanup highlight ${index + 1}`),
            }));
            page.node.set(PDFName.of('Annots'), source.context.obj([
                note,
                markup,
            ]));
        }
        writeFileSync(fixture, await source.save());
        const inspect = async (path: string) => {
            const saved = await PDFDocument.load(readFileSync(path), {updateMetadata: false});
            const document = await pdfjs.getDocument({
                data: new Uint8Array(readFileSync(path)),
                ...createPdfjsNodeDocumentOptions(),
            }).promise;
            try {
                const pages = [];
                for (let number = 1; number <= document.numPages; number += 1) {
                    const page = await document.getPage(number);
                    const viewport = page.getViewport({scale: 2});
                    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                    await Reflect.apply(page.render, page, [{
                        canvas,
                        canvasContext: canvas.getContext('2d'),
                        viewport,
                        annotationMode: pdfjs.AnnotationMode.DISABLE,
                    }]).promise;
                    pages.push({
                        annotations: await page.getAnnotations(),
                        rects: (saved.getPage(number - 1).node.Annots()?.asArray() ?? []).map(ref => {
                            const rect = saved.context.lookup(ref, PDFDict).lookup(PDFName.of('Rect'), PDFArray);
                            return rect.asArray().map((_value, index) => rect.lookup(index, PDFNumber).asNumber());
                        }),
                        pixels: createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex'),
                    });
                    page.cleanup();
                }
                return pages;
            } finally { await document.loadingTask.destroy(); }
        };
        const sourcePages = await inspect(fixture);
        const outputs = [];
        for (const path of [
            fixture,
            plainPath,
        ]) {
            if (path === plainPath) await session.resetForE2E();
            await session.command('windowResize', [
                1280,
                900,
            ]);
            await openPdfInApp(session.page, path, 90_000);
            await waitForPdfLoaded(session.page, 90_000);
            await waitForViewerInteractive(session.page, 90_000);
            await session.page.evaluate(async () => window.electronAPI!.scanCleanup!.updateSettings!({settingsPatch: {
                layoutMode: 'force-single',
                crop: false,
                matchPageSize: true,
                pageAlignment: 'center',
                marginsMm: {
                    leftMm: 2,
                    topMm: 2,
                    rightMm: 2,
                    bottomMm: 2,
                },
                firstRunGuidanceDismissed: true,
            }}));
            await openCleanup(session);
            const quality = await session.page.$('[role="checkbox"][aria-label="Preserve original quality (no rasterization)"]');
            if (await quality?.evaluate(node => node.getAttribute('aria-checked') === 'true')) await clickAsUser(session.page, quality!);
            await clickAsUser(session.page, '[role="radio"][aria-label="Grayscale"]');
            await clickAsUser(session.page, '.scan-cleanup-toolbar-primary-action');
            await waitForFunctionInPage(session.page, () => {
                const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.readActiveWorkspaceStateValues?.(['originalPath']);
                return typeof state?.originalPath === 'string' && state.originalPath.endsWith('— cleaned.pdf');
            }, {timeout: 180_000});
            const state = await readWorkspaceStateValues(session.page, ['originalPath']);
            expect(typeof state.originalPath).toBe('string');
            const pages = await inspect(String(state.originalPath));
            outputs.push(pages);
            if (path === fixture) {
                const plan: {pages: Array<{matrix: number[]}>} = JSON.parse(readFileSync(join(evidence, 'source-text-layer.json'), 'utf8'));
                expect(pages).toHaveLength(3);
                for (const [
                    index,
                    page,
                ] of pages.entries()) {
                    expect(page.annotations.map(annotation => [
                        annotation.subtype,
                        annotation.contentsObj?.str,
                    ]))
                        .toEqual(sourcePages[index]!.annotations.map(annotation => [
                            annotation.subtype,
                            annotation.contentsObj?.str,
                        ]));
                    const [
                        a,
                        b,
                        c,
                        d,
                        e,
                        f,
                    ] = plan.pages[index]!.matrix;
                    for (const ordinal of page.annotations.keys()) {
                        const [
                            x1,
                            y1,
                            x2,
                            y2,
                        ] = sourcePages[index]!.rects[ordinal]!;
                        const corners = [
                            [
                                x1,
                                y1,
                            ],
                            [
                                x1,
                                y2,
                            ],
                            [
                                x2,
                                y1,
                            ],
                            [
                                x2,
                                y2,
                            ],
                        ].map(([
                            x,
                            y,
                        ]) => [
                            a! * x! + c! * y! + e!,
                            b! * x! + d! * y! + f!,
                        ]);
                        const expected = [
                            Math.min(...corners.map(point => point[0]!)),
                            Math.min(...corners.map(point => point[1]!)),
                            Math.max(...corners.map(point => point[0]!)),
                            Math.max(...corners.map(point => point[1]!)),
                        ];
                        page.rects[ordinal]!.forEach((value: number, coordinate: number) => expect(value).toBeCloseTo(expected[coordinate]!, 4));
                    }
                }
                await waitForPdfLoaded(session.page, 90_000);
                await waitForViewerInteractive(session.page, 90_000);
                await openAnnotationsTab(session.page);
                await clickFoundAsUser(session.page, (text: string) => [...document.querySelectorAll('.editor-pane.is-active .note-item')]
                    .find(item => item.querySelector('.note-item-text')?.textContent?.trim() === text)?.querySelector('.note-item-content'),
                'Cleanup note Ω page 1', {
                    count: 2,
                    description: 'cleaned note card',
                });
                await session.page.waitForSelector('textarea.note-window__textarea', {
                    visible: true,
                    timeout: 20_000,
                });
                expect(await session.page.$eval('textarea.note-window__textarea', node => (node as HTMLTextAreaElement).value)).toBe('Cleanup note Ω page 1');
            }
        }
        expect(outputs[0]!.map(page => page.pixels)).toEqual(outputs[1]!.map(page => page.pixels));
    }, 300_000);

    it.each([
        'Black and white',
        'Grayscale',
        'Color',
    ])('completes a %s run with preserve quality and match size unchecked', async (mode) => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const fixturePath = await createLargeScannedFixturePdf(
            `scan-cleanup-page-ops-${mode.toLowerCase().replaceAll(' ', '-')}.pdf`,
            1,
            0,
        );
        // The managed working copy is always document.pdf; the output must keep
        // the user's own file name instead.
        const sourceStem = `Сканы книги ${mode} 書`;
        const sourcePath = join(dirname(fixturePath), `${sourceStem}.pdf`);
        copyFileSync(fixturePath, sourcePath);
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openCleanup(session);
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') !== 'pending'
                && document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action')?.disabled === false
        ), {timeout: 120_000});
        await waitForFunctionInPage(session.page, () => {
            const action = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action');
            if (!action || action.disabled) return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return (hit === action || action.contains(hit))
                    && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i
                        .test(document.body.innerText);
        }, {timeout: 120_000});

        for (const label of [
            'The tools required for scan cleanup are unavailable on this system.',
            'Scan cleanup could not be completed',
        ]) {
            const toast = await session.page.$$('button');
            for (const button of toast) {
                if (await button.isVisible() && await button.evaluate((element, text) => (
                    element.innerText.includes(text)
                ), label)) {
                    await clickAsUser(session.page, button);
                }
            }
        }

        const radios = await session.page.$$('[role="radio"]');
        const radio = (await Promise.all(radios.map(async element => ({
            element,
            visible: await element.isVisible(),
            text: await element.evaluate(node => node.textContent?.trim() ?? ''),
            disabled: await element.evaluate(node => (node as HTMLButtonElement).disabled),
            label: await element.evaluate(node => node.getAttribute('aria-label')),
        })))).find(candidate => candidate.visible && !candidate.disabled
                && (candidate.text === mode || candidate.label === mode))?.element;
        expect(radio, `visible ${mode} option`).toBeTruthy();
        await clickAsUser(session.page, radio!);
        await waitForFunctionInPage(session.page, (label: string) => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="radio"][aria-label]'))
                .some(element => element.getAttribute('aria-label') === label
                        && element.getAttribute('aria-checked') === 'true')
        ), {timeout: 5_000}, mode);

        for (const label of [
            'Preserve original quality (no rasterization)',
            'Match page size with other pages',
        ]) {
            const checkboxes = await session.page.$$(`[role="checkbox"][aria-label="${label}"]`);
            const checkbox = (await Promise.all(checkboxes.map(async element => ({
                element,
                visible: await element.isVisible(),
            })))).find(candidate => candidate.visible)?.element;
            expect(checkbox, `visible ${label} checkbox`).toBeTruthy();
            if (await checkbox!.evaluate(element => element.getAttribute('aria-checked') === 'true')) {
                await clickAsUser(session.page, checkbox!);
            }
        }

        const actionSelector = '.scan-cleanup-toolbar-primary-action';
        await waitForFunctionInPage(session.page, (selector: string) => {
            const action = document.querySelector<HTMLButtonElement>(selector);
            if (!action || action.disabled || action.getAttribute('aria-disabled') === 'true') return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            const previewRunning = /Building cleanup preview|Preview updating|Updating preview|Reading page images/i
                .test(document.body.innerText);
            return (hit === action || action.contains(hit)) && !previewRunning;
        }, {timeout: 120_000}, actionSelector);
        const action = await session.page.$(actionSelector);
        const actionRect = await action!.boundingBox();
        expect(actionRect).toBeTruthy();
        const actionState = await action!.evaluate((element, rect) => {
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            return {
                disabled: element instanceof HTMLButtonElement && element.disabled,
                ariaDisabled: element.getAttribute('aria-disabled'),
                rect,
                hit: document.elementFromPoint(x, y)?.outerHTML,
                previewRunning: /Building cleanup preview|Preview updating|Updating preview|Reading page images/i
                    .test(document.body.innerText),
            };
        }, actionRect!);
        console.log(`scan-cleanup-run-${mode}`, JSON.stringify(actionState));
        expect(actionState.disabled).toBe(false);
        expect(actionState.ariaDisabled).not.toBe('true');
        expect(actionState.previewRunning).toBe(false);
        await clickAsUser(session.page, action!);

        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return (typeof active?.originalPath === 'string'
                    && active.originalPath !== source
                    && active.originalPath.endsWith('— cleaned.pdf'))
                    || document.body.innerText.includes('evb-pdf-page-ops');
        }, {timeout: 180_000}, sourcePath);
        expect(await session.page.evaluate(() => document.body.innerText))
            .not.toContain('evb-pdf-page-ops');
        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = typeof outputState.originalPath === 'string' ? outputState.originalPath : null;
        expect(outputPath).toBeTruthy();
        expect(basename(outputPath!)).toBe(`${sourceStem} — cleaned.pdf`);
        expect(existsSync(outputPath!)).toBe(true);
        expect(statSync(outputPath!).size).toBeGreaterThan(0);
        expect(await readPdfPageSnapshots(outputPath!)).toEqual([{
            pageNumber: 1,
            rotation: 0,
            textSnippet: '',
        }]);
    }, 240_000);
});

describe('scan cleanup completed output recovery', () => {
    it('brings back a finished output that was never opened, behind the tab the reader is in, once the window reloads', async () => {
        const session = sessionFixture.getSession();
        const readerPath = await createMultiPageTextFixturePdf('scan-cleanup-reading-position.pdf', 6);
        await openPdfInApp(session.page, readerPath, 60_000);
        await waitForPdfLoaded(session.page, 60_000);
        const readZoom = () => evaluateInPage(session.page, () => (
            document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim() ?? ''
        ));
        const defaultZoom = await readZoom();
        await clickVisibleToolbarButton(session.page, 'Zoom In');
        await waitForFunctionInPage(session.page, (before: string) => {
            const zoom = document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim();
            return Boolean(zoom) && zoom !== before;
        }, {timeout: 60_000}, defaultZoom);
        const readingZoom = await readZoom();
        await goToPageViaToolbar(session.page, 4);
        // Recover a saved reading position, rather than racing the initial
        // checkpoint write for a document that has only just been opened.
        const recoveryRoot = join(sessionDir(session.name), 'electron-user-data', 'workspace-recovery');
        await expect.poll(() => existsSync(recoveryRoot) && readdirSync(recoveryRoot)
            .filter(name => name.endsWith('.json'))
            .some((name) => {
                const record: unknown = JSON.parse(readFileSync(join(recoveryRoot, name), 'utf8'));
                const checkpoint = isRecord(record) ? decodeWorkspaceCheckpoint(record.checkpoint) : null;
                const tab = checkpoint?.tabs.find(candidate => candidate.tabId === checkpoint.activeTabId);
                return tab?.fileName === basename(readerPath) && tab.currentPage === 4 && tab.zoomMode === 'custom';
            }), {timeout: 60_000}).toBe(true);
        const outputRoot = join(sessionDir(session.name), 'electron-user-data', 'scan-cleanup', 'output');
        const outputPath = join(outputRoot, randomUUID(), 'recovered — cleaned.pdf');
        mkdirSync(dirname(outputPath), {recursive: true});
        copyFileSync(await createLargeScannedFixturePdf('scan-cleanup-recovered.pdf', 1, 0), outputPath);
        writeFileSync(join(outputRoot, '.evb-scan-cleanup-completed-outputs.json'), JSON.stringify([{
            version: 1,
            outputPdfPath: outputPath,
            completedAtMs: Date.now(),
        }]));
        const readOutputTabs = () => session.page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
            .filter(tab => tab.textContent?.includes('recovered — cleaned.pdf'))
            .map(tab => tab.getAttribute('aria-selected') === 'true'));

        await session.page.reload({waitUntil: 'domcontentloaded'});
        await waitForRendererReady(session.page);
        // The output's tab comes back once; the tab the reader was in stays in front.
        await waitForFunctionInPage(session.page, () => [...document.querySelectorAll('[role="tab"]')]
            .some(tab => tab.textContent?.includes('recovered — cleaned.pdf')), {timeout: 60_000});
        expect(await readOutputTabs()).toEqual([false]);
        const readReaderTitle = () => session.page.$eval('[role="tab"][aria-selected="true"]', tab => tab.textContent?.trim());
        expect(await readReaderTitle()).toContain(basename(readerPath));

        // Reloading again, before the reader ever chose it, keeps that one
        // background tab: it was kept, and the output is not brought back twice.
        await session.page.reload({waitUntil: 'domcontentloaded'});
        await waitForRendererReady(session.page);
        await waitForFunctionInPage(session.page, () => [...document.querySelectorAll('[role="tab"]')]
            .some(tab => tab.textContent?.includes('recovered — cleaned.pdf')), {timeout: 60_000});
        expect(await readOutputTabs()).toEqual([false]);
        expect(await readReaderTitle()).toContain(basename(readerPath));
        await waitForToolbarCurrentPage(session.page, 4);
        await waitForFunctionInPage(session.page, (zoom: string) => {
            const container = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="4"]',
            );
            const viewport = container?.closest('#pdf-viewer')?.getBoundingClientRect();
            const canvas = container?.querySelector('canvas')?.getBoundingClientRect();
            return Boolean(viewport && canvas && canvas.width > 0 && canvas.height > 0
                && canvas.bottom > viewport.top && canvas.top < viewport.bottom
                && container?.querySelector('.textLayer, .text-layer')?.textContent?.includes('Page 4 sample text for annotations')
                && document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim() === zoom);
        }, {timeout: 60_000}, readingZoom);

        // Choosing it then shows the output, painted.
        await clickFoundAsUser(session.page, () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
            .find(tab => tab.textContent?.includes('recovered — cleaned.pdf')), undefined, {description: 'recovered output tab'});
        await waitForFunctionInPage(session.page, (path: string) => (
            (window as IWorkspaceExposeProbeWindow).__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath'])
                ?.originalPath === path
        ), {timeout: 60_000}, outputPath);
        await waitForPdfLoaded(session.page, 60_000);
        expect(await readOutputTabs()).toEqual([true]);
    }, 120_000);
});
