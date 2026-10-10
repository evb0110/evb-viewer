import {execFileSync} from 'node:child_process';
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    createHash, randomUUID,
} from 'node:crypto';
import {
    join,
    resolve,
} from 'node:path';
import {
    afterAll,
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {
    createCanvas, loadImage,
} from '@napi-rs/canvas';
import {
    degrees, PDFDocument, PDFString, StandardFonts,
} from 'pdf-lib';
import {verifyInteropRendering} from '@scripts/verify-interop-rendering.mjs';
import {inspectPdf} from '@scripts/verify-interop-corpus.mjs';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    clickAnnotationTool,
    collectAnnotationOwnershipDebugState,
    createCanonicalTextBoxWithPointer,
    createStickyNoteWithPointer,
    selectAllFocusedAnnotationText,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    createMultiPageTextFixturePdf, readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    callWorkspaceCommand,
    waitForAutomationEvent,
    waitForSaveFrontierReady,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    triggerOpenPathInApp,
    openDocumentSidebarTab,
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import {waitForViewportQuiet} from '@tests/e2e/electron/helpers/viewportPageObservation';

const CORPUS_DIRECTORY = resolve(
    process.cwd(),
    'tests/fixtures/electron/interop',
);
const SYNTHETIC_FIXTURE = join(
    CORPUS_DIRECTORY,
    'synthetic-annotation-interoperability.pdf',
);
const STOCK_FIXTURE = join(
    CORPUS_DIRECTORY,
    'stock-pdfjs-save-of-synthetic.pdf',
);
const ACCEPTANCE_TIMEOUT_MS = 180_000;
const SAVE_TIMEOUT_MS = 60_000;
const EXPECTED_IMPORTED_KINDS = [
    'note',
    'placed-image',
    'shape',
    'text-box',
    'text-markup',
];
const INTEROP_E2E_SCRATCH_ROOT = resolve(process.cwd(), '.devkit', 'artifacts');
const interopE2eFixtureDirectories: string[] = [];

const sessionFixture = createElectronE2ESessionFixture({
    restartBeforeEach: true,
    sessionName: () => `e2e-interop-vps-${Date.now()}`,
});

function copyFreshFixture(sourcePath: string, label: string) {
    mkdirSync(INTEROP_E2E_SCRATCH_ROOT, {recursive: true});
    const directory = mkdtempSync(join(
        INTEROP_E2E_SCRATCH_ROOT,
        `.issue-167-vps-input-${label}-`,
    ));
    interopE2eFixtureDirectories.push(directory);
    const destination = join(directory, 'document.pdf');
    copyFileSync(sourcePath, destination);
    return destination;
}

function createGeneratedEncryptedFixture(sourcePath: string) {
    mkdirSync(INTEROP_E2E_SCRATCH_ROOT, {recursive: true});
    const directory = mkdtempSync(join(
        INTEROP_E2E_SCRATCH_ROOT,
        '.issue-167-vps-encrypted-',
    ));
    interopE2eFixtureDirectories.push(directory);
    const destination = join(directory, 'encrypted-input.pdf');
    const password = `evb-interop-${process.pid}-${Date.now()}-${randomUUID()}`;
    execFileSync(getPdfNativeToolPaths().qpdf, [
        '--encrypt',
        password,
        password,
        '256',
        '--',
        sourcePath,
        destination,
    ], {stdio: 'pipe'});
    return {
        password,
        path: destination,
    };
}

afterAll(async () => {
    // Stop the Electron session before deleting a test-owned input. A queued
    // save can still be finishing after its automation wait has expired.
    await sessionFixture.stop({preserveArtifacts: true});
    for (const directory of interopE2eFixtureDirectories) {
        rmSync(directory, {
            force: true,
            recursive: true,
        });
    }
});

async function expectImportedCanonicalKinds(page: Page) {
    await page.waitForFunction((expectedKinds: string[]) => {
        const editorLayer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer',
        );
        const kinds = Array.from(
            editorLayer?.querySelectorAll<HTMLElement>('[data-annotation-id][data-annotation-kind]') ?? [],
        )
            .map(entity => entity.dataset.annotationKind ?? '')
            .filter((kind, index, values) => values.indexOf(kind) === index)
            .sort();
        const staticLayer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container[data-page="1"] .annotation-layer, '
            + '.editor-pane.is-active .page_container[data-page="1"] .annotationLayer',
        );
        const staticNonLinkAnnotationCount = Array.from(
            staticLayer?.querySelectorAll<HTMLElement>('[data-annotation-id]') ?? [],
        ).filter(element => !element.closest('.linkAnnotation')).length;
        const staticLinkHrefs = Array.from(
            staticLayer?.querySelectorAll<HTMLAnchorElement>('.linkAnnotation a[data-href]') ?? [],
        ).map(link => link.dataset.href ?? '');
        return kinds.join(',') === expectedKinds.slice().sort().join(',')
            && staticNonLinkAnnotationCount > 0
            && staticLinkHrefs.includes('https://example.com/evb-interop-corpus');
    }, {timeout: SAVE_TIMEOUT_MS}, EXPECTED_IMPORTED_KINDS);
    const debug = await collectAnnotationOwnershipDebugState(page);
    expect([...new Set(debug.canonicalEntities.map(entity => entity.kind))].sort()).toEqual(
        EXPECTED_IMPORTED_KINDS,
    );
    expect(debug.legacyEditorLayerCount).toBe(0);
    expect(debug.staticNonLinkAnnotationCount).toBeGreaterThan(0);
    expect(debug.staticLinkHrefs).toContain('https://example.com/evb-interop-corpus');
    const comments = debug.workspaceState.annotationComments as Array<Record<string, unknown>> | undefined;
    const legacyNote = comments?.find(comment => comment.text === 'Legacy note to edit');
    expect(legacyNote).toMatchObject({
        source: 'pdf',
        annotationKind: 'note',
        text: 'Legacy note to edit',
    });
    expect(debug.canonicalEntities).toContainEqual(expect.objectContaining({
        id: legacyNote?.appAnnotationId,
        kind: 'note',
    }));
    return debug;
}

async function editImportedTextBox(page: Page) {
    const point = await page.evaluate(() => {
        const entity = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container[data-page="1"] '
            + '[data-annotation-kind="text-box"]',
        );
        if (!entity) {
            return null;
        }
        const rect = entity.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    });
    if (!point) {
        throw new Error('The committed corpus did not expose an imported text box');
    }
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => (
        document.querySelector(
            '.editor-pane.is-active .page_container[data-page="1"] '
            + '[data-annotation-kind="text-box"].is-selected',
        ) !== null
    ), {timeout: SAVE_TIMEOUT_MS});
    await page.$eval(
        '.editor-pane.is-active .page_container[data-page="1"] [data-pdf-annotation-editor-surface]',
        element => (element as HTMLElement).focus({preventScroll: true}),
    );
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (
        document.querySelector('.annotation-style-popover') === null
    ), {timeout: SAVE_TIMEOUT_MS});
    await waitForSaveFrontierReady(page, SAVE_TIMEOUT_MS);
    const debug = await collectAnnotationOwnershipDebugState(page);
    expect(debug.annotationDirtyEntityCount).toBeGreaterThan(0);
}

async function openPasswordProtectedPdf(page: Page, path: string, password: string) {
    // The encrypted open cannot satisfy waitForPdfLoaded until the password
    // prompt has been answered. Trigger the transaction first, then drive the
    // shared password dialog and wait for the resulting PDF.
    await triggerOpenPathInApp(page, path, SAVE_TIMEOUT_MS);
    await page.waitForSelector('input[type="password"]', {
        timeout: SAVE_TIMEOUT_MS,
        visible: true,
    });
    await page.type('input[type="password"]', password);
    await page.keyboard.press('Enter');
    await waitForPdfLoaded(page, SAVE_TIMEOUT_MS);
    await waitForViewerInteractive(page, SAVE_TIMEOUT_MS);
}

async function saveDecryptedOutput(page: Page, path: string) {
    const savePromise = callWorkspaceCommand<boolean>(page, 'handleSave');
    await page.waitForSelector('.unencrypted-save-dialog', {
        timeout: SAVE_TIMEOUT_MS,
        visible: true,
    });
    await clickAsUser(page, '[data-testid="unencrypted-save-continue"]');
    await expect(savePromise).resolves.toEqual({
        called: true,
        value: true,
    });
    await waitForAutomationEvent(page, 'save-committed', {
        path,
        timeoutMs: SAVE_TIMEOUT_MS,
    });
}

describe('Electron E2E - VPS interoperability acceptance', () => {
    it('preserves a rotated foreign FreeText appearance while saving an unrelated note', async () => {
        const {page} = sessionFixture.getSession();
        const artifactDirectory = resolve('.devkit/artifacts', `foreign-freetext-${Date.now()}`);
        mkdirSync(artifactDirectory, {recursive: true});
        const fixturePath = join(artifactDirectory, 'document.pdf');
        const pdf = await PDFDocument.create();
        const pdfPage = pdf.addPage([
            600,
            800,
        ]);
        pdfPage.setRotation(degrees(90));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const appearance = pdf.context.register(pdf.context.stream(
            'BT /Helv 12 Tf 0 0 0 rg 1 0 0 1 10 16 Tm (Project 8 foreign annotation) Tj ET\n',
            {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [
                    0,
                    0,
                    300,
                    40,
                ],
                Resources: {Font: {Helv: font.ref}},
            },
        ));
        pdfPage.node.set(pdf.context.obj('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'FreeText',
            Rect: [
                100,
                400,
                400,
                440,
            ],
            NM: PDFString.of('foreign-text'),
            Contents: PDFString.of('Project 8 foreign annotation'),
            DA: PDFString.of('/Helv 12 Tf 0 0 0 rg'),
            AP: {N: appearance},
            P: pdfPage.ref,
        }))]));
        writeFileSync(fixturePath, await pdf.save());
        function appearanceHash(label: string) {
            const prefix = join(artifactDirectory, label);
            execFileSync(getPdfNativeToolPaths().pdftoppm, [
                '-r',
                '72',
                '-f',
                '1',
                '-l',
                '1',
                '-singlefile',
                '-x',
                '400',
                '-y',
                '100',
                '-W',
                '40',
                '-H',
                '300',
                '-png',
                fixturePath,
                prefix,
            ], {stdio: 'pipe'});
            return createHash('sha256').update(readFileSync(`${prefix}.png`)).digest('hex');
        }
        const originalHash = appearanceHash('original-appearance');
        await openPdfInApp(page, fixturePath);
        await waitForViewerInteractive(page);
        await clickAnnotationTool(page, 'Select');
        const readyPage = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .page_container--rendered[data-page="1"][data-page-layer-readiness="ready"] '
            + '.pdf-annotation-editor-layer[data-pdf-annotation-editor-ready="true"]';
        await page.waitForSelector(readyPage);
        const textBoxSelector = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] [data-annotation-kind="text-box"]';
        async function waitForPaintedAppearance() {
            await page.waitForFunction(() => {
                const container = document.querySelector('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .page_container[data-page="1"]');
                if (!container) return false;
                const pageRect = container.getBoundingClientRect();
                return Array.from(container.querySelectorAll('canvas')).some(canvas => {
                    const rect = canvas.getBoundingClientRect();
                    if (!rect.width || !rect.height) return false;
                    const left = Math.max(rect.left, pageRect.left + pageRect.width / 2);
                    const top = Math.max(rect.top, pageRect.top + pageRect.height / 6);
                    const right = Math.min(rect.right, pageRect.left + pageRect.width * 0.55);
                    const bottom = Math.min(rect.bottom, pageRect.top + pageRect.height * 2 / 3);
                    if (right <= left || bottom <= top) return false;
                    const pixels = canvas.getContext('2d')?.getImageData(
                        (left - rect.left) * canvas.width / rect.width,
                        (top - rect.top) * canvas.height / rect.height,
                        (right - left) * canvas.width / rect.width,
                        (bottom - top) * canvas.height / rect.height,
                    ).data;
                    let ink = 0;
                    for (let index = 0; pixels && index < pixels.length; index += 4) {
                        if (pixels[index + 3]! > 0 && pixels[index]! < 200
                            && pixels[index + 1]! < 200 && pixels[index + 2]! < 200) ink += 1;
                    }
                    return ink > 100;
                });
            });
        }
        await waitForPaintedAppearance();
        const initialTextBoxes = (await page.$$(textBoxSelector)).length;
        async function captureAppearance(label: string) {
            const clip = await page.$eval('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .page_container[data-page="1"]', element => {
                const rect = element.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 6,
                    width: rect.width / 20,
                    height: rect.height / 2,
                };
            });
            const screenshotPath = join(artifactDirectory, `${label}.png`);
            await page.screenshot({
                path: screenshotPath,
                clip,
            });
            const image = await loadImage(screenshotPath);
            const canvas = createCanvas(image.width, image.height);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, image.width, image.height).data;
            const ink: Array<{
                x: number;
                y: number
            }> = [];
            for (let y = 0; y < image.height; y += 1) {
                for (let x = 0; x < image.width; x += 1) {
                    const offset = (y * image.width + x) * 4;
                    if (pixels[offset]! < 200 && pixels[offset + 1]! < 200 && pixels[offset + 2]! < 200) ink.push({
                        x,
                        y,
                    });
                }
            }
            const inkWidth = Math.max(...ink.map(point => point.x)) - Math.min(...ink.map(point => point.x)) + 1;
            const inkHeight = Math.max(...ink.map(point => point.y)) - Math.min(...ink.map(point => point.y)) + 1;
            return {
                clip,
                inkCount: ink.length,
                inkWidth,
                inkHeight,
            };
        }
        const initialAppearance = await captureAppearance('opened-appearance');
        const {
            clip, inkWidth, inkHeight,
        } = initialAppearance;
        // The app's input surface covers the static PDF.js element. Aim at
        // the painted rectangle through that surface with trusted input.
        await page.mouse.click(clip.x + clip.width / 2, clip.y + clip.height / 2, {count: 2});
        const editableTextBoxes = (await page.$$(`${textBoxSelector} [contenteditable="true"]`)).length;
        await page.keyboard.press('Escape');
        const noteText = 'Unrelated note beside the foreign appearance';
        await createStickyNoteWithPointer(page, noteText, {
            x: 0.2,
            y: 0.8,
        }, 1);
        await saveViaVisibleToolbar(page, SAVE_TIMEOUT_MS, fixturePath);
        const savedHash = appearanceHash('saved-appearance');
        const savedNotes = await readPdfTextAnnotationRecords(fixturePath);
        await openPdfInApp(page, copyFreshFixture(fixturePath, 'foreign-text-reopen'));
        await waitForViewerInteractive(page);
        await page.waitForSelector(readyPage);
        await page.waitForFunction((text: string) => Array.from(document.querySelectorAll(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .notes-list .note-item',
        )).some(item => item.textContent?.includes(text)), {}, noteText);
        await page.screenshot({path: join(artifactDirectory, 'reopened.png')});
        await waitForPaintedAppearance();
        const reopenedAppearance = await captureAppearance('reopened-appearance');
        const beforeZoomWidth = reopenedAppearance.clip.width;
        await clickAsUser(page, '.zoom-controls button[aria-label="Zoom In"]');
        await page.waitForFunction((before: number) => {
            const container = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .page_container[data-page="1"]');
            const canvas = container?.querySelector<HTMLCanvasElement>('.page_canvas canvas');
            return container?.dataset.pageLayerReadiness === 'ready'
                && container.getBoundingClientRect().width / 20 > before
                && canvas && canvas.width > before * 20;
        }, {}, beforeZoomWidth);
        await waitForPaintedAppearance();
        await page.waitForFunction((text: string) => Array.from(document.querySelectorAll(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .notes-list .note-item',
        )).some(item => item.textContent?.includes(text)), {}, noteText);
        await waitForViewportQuiet(page);
        await page.mouse.move(700, 320);
        await page.mouse.wheel({
            deltaX: -1200,
            deltaY: -1200,
        });
        await waitForViewportQuiet(page);
        await waitForPaintedAppearance();
        const zoomedAppearance = await captureAppearance('zoomed-appearance');
        const reopened = await collectAnnotationOwnershipDebugState(page);
        writeFileSync(join(artifactDirectory, 'observations.json'), JSON.stringify({
            originalHash,
            savedHash,
            initialTextBoxes,
            editableTextBoxes,
            inkWidth,
            inkHeight,
            reopenedAppearance,
            zoomedAppearance,
            savedNotes,
            reopened,
        }, null, 2));
        console.log(`FOREIGN_FREETEXT_EVIDENCE ${artifactDirectory}`);
        expect(initialTextBoxes, 'foreign text has no canonical text-box editor').toBe(0);
        expect(editableTextBoxes, 'double-clicking foreign text cannot edit it').toBe(0);
        expect(initialAppearance.inkCount, 'the foreign appearance renders in the app').toBeGreaterThan(100);
        expect(inkHeight, 'the appearance remains one rotated line').toBeGreaterThan(inkWidth * 8);
        expect(reopenedAppearance.inkCount, 'the foreign appearance is painted after reopening').toBeGreaterThan(100);
        expect(reopenedAppearance.inkHeight, 'reopened foreign text remains one rotated line')
            .toBeGreaterThan(reopenedAppearance.inkWidth * 8);
        expect(zoomedAppearance.inkCount, 'the foreign appearance survives zoom repaint').toBeGreaterThan(100);
        expect(zoomedAppearance.inkHeight, 'zoomed foreign text remains one rotated line')
            .toBeGreaterThan(zoomedAppearance.inkWidth * 8);
        expect(savedHash, 'saving a note leaves the foreign appearance pixels unchanged').toBe(originalHash);
        expect(savedNotes).toContainEqual(expect.objectContaining({
            subtype: '/Text',
            contents: noteText,
        }));
        expect(reopened.canonicalEntities.some(entity => entity.kind === 'text-box')).toBe(false);
        expect(reopened.workspaceState.annotationComments).toContainEqual(expect.objectContaining({text: noteText}));
    }, ACCEPTANCE_TIMEOUT_MS);

    it('keeps text on one rotated line through page rotation, save, and editing', async () => {
        const {page} = sessionFixture.getSession();
        const fixturePath = await createMultiPageTextFixturePdf(`rotated-text-box-${Date.now()}.pdf`, 2);
        await openPdfInApp(page, fixturePath);
        await waitForViewerInteractive(page);
        const id = await createCanonicalTextBoxWithPointer(page, 'Project 8 recovered annotation', {
            x: 0.4,
            y: 0.3,
        });
        const selector = `.editor-pane.is-active .pdf-annotation-editor-text-box[data-annotation-id="${id}"]`;
        async function readTextLine() {
            return page.$eval(selector, entity => {
                const content = entity.querySelector('[contenteditable="true"]') ?? entity;
                const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
                const letters: DOMRect[] = [];
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    for (let index = 0; index < (node.textContent?.length ?? 0); index += 1) {
                        if (/\s|\u200b|\ufeff/u.test(node.textContent![index]!)) continue;
                        const range = document.createRange();
                        range.setStart(node, index);
                        range.setEnd(node, index + 1);
                        letters.push(range.getBoundingClientRect());
                    }
                }
                return {
                    text: content.textContent?.trim(),
                    columns: Math.max(...letters.map(letter => letter.x)) - Math.min(...letters.map(letter => letter.x)),
                    rows: Math.max(...letters.map(letter => letter.y)) - Math.min(...letters.map(letter => letter.y)),
                };
            });
        }
        async function rotatePage(direction: 'clockwise' | 'counterclockwise') {
            const previous = await page.$eval(selector, entity => (entity as HTMLElement).style.cssText);
            await openDocumentSidebarTab(page, 'Pages');
            await clickAsUser(page, '.editor-pane.is-active [data-thumbnail-page="1"]', {button: 'right'});
            await clickFoundAsUser(page, target => Array.from(document.querySelectorAll('[role="menuitem"]'))
                .find(item => item.textContent?.trim().toLowerCase() === `rotate ${target}`), direction, {description: `Rotate page ${direction}`});
            await page.waitForFunction((target: string, before: string) => {
                const entity = document.querySelector<HTMLElement>(target);
                return entity && entity.style.cssText !== before;
            }, {timeout: SAVE_TIMEOUT_MS}, selector, previous);
            await waitForViewerInteractive(page);
        }
        const original = await readTextLine();
        expect(original.rows).toBeLessThan(1);
        await rotatePage('clockwise');
        const rotated = await readTextLine();
        expect(rotated.columns).toBeLessThan(1);
        expect(rotated.rows).toBeGreaterThan(100);
        await saveViaVisibleToolbar(page, SAVE_TIMEOUT_MS, fixturePath);
        const reopenPath = copyFreshFixture(fixturePath, 'rotated-text-reopen');
        await openPdfInApp(page, reopenPath);
        await waitForViewerInteractive(page);
        // Canvas readiness does not await the reopened annotation layer.
        await page.waitForSelector(selector, {
            visible: true,
            timeout: SAVE_TIMEOUT_MS,
        });
        expect((await readTextLine()).columns).toBeLessThan(1);
        await rotatePage('counterclockwise');
        expect((await readTextLine()).rows).toBeLessThan(1);
        await rotatePage('clockwise');
        await clickAnnotationTool(page, 'Select');
        await clickAsUser(page, selector, {count: 2});
        await page.waitForSelector(`${selector} [contenteditable="true"]`);
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await selectAllFocusedAnnotationText(page);
        await page.keyboard.type('Project 8 edited annotation');
        expect((await readTextLine()).columns).toBeLessThan(1);
        await page.keyboard.down(modifier);
        await page.keyboard.press('Enter');
        await page.keyboard.up(modifier);
        await saveViaVisibleToolbar(page, SAVE_TIMEOUT_MS, reopenPath);
        expect(await readTextLine()).toMatchObject({text: 'Project 8 edited annotation'});
        expect((await readTextLine()).columns).toBeLessThan(1);
    }, ACCEPTANCE_TIMEOUT_MS);

    it('imports, edits, saves, independently renders, and reopens the committed corpus twice', async () => {
        const session = sessionFixture.getSession();
        const fixturePath = copyFreshFixture(SYNTHETIC_FIXTURE, 'corpus');
        const artifactDirectory = join(
            process.cwd(),
            '.devkit/artifacts',
            `issue-167-vps-corpus-${Date.now()}`,
        );

        await openPdfInApp(session.page, fixturePath, SAVE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, SAVE_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        const initial = await expectImportedCanonicalKinds(session.page);
        expect(initial.canonicalEntities.length).toBeGreaterThanOrEqual(6);

        await editImportedTextBox(session.page);
        await saveViaVisibleToolbar(session.page, SAVE_TIMEOUT_MS, fixturePath);
        await verifyInteropRendering({
            artifactDirectory,
            corpusDirectory: CORPUS_DIRECTORY,
            inputPaths: [fixturePath],
        });
        const savedAnnotations = await inspectPdf(fixturePath);
        expect(savedAnnotations.annotations).toContainEqual(expect.objectContaining({
            kind: 'note',
            legacyFreeTextPopup: true,
            name: 'interop-marker-edited-legacy-note',
            subtype: 'FreeText',
        }));

        const reopenOne = copyFreshFixture(fixturePath, 'reopen-one');
        await openPdfInApp(session.page, reopenOne, SAVE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, SAVE_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        await expectImportedCanonicalKinds(session.page);

        const reopenTwo = copyFreshFixture(reopenOne, 'reopen-two');
        await openPdfInApp(session.page, reopenTwo, SAVE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, SAVE_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        await expectImportedCanonicalKinds(session.page);

        const manifest = JSON.parse(readFileSync(join(CORPUS_DIRECTORY, 'corpus-manifest.json'), 'utf8'));
        expect(manifest.entries.every((entry: {status: string}) => entry.status === 'ready')).toBe(true);
    }, ACCEPTANCE_TIMEOUT_MS);

    it('opens a generated encrypted corpus input and saves a password-free output', async () => {
        const session = sessionFixture.getSession();
        const encrypted = createGeneratedEncryptedFixture(STOCK_FIXTURE);
        const artifactDirectory = join(
            process.cwd(),
            '.devkit/artifacts',
            `issue-167-vps-encrypted-${Date.now()}`,
        );

        await openPasswordProtectedPdf(session.page, encrypted.path, encrypted.password);
        await expectImportedCanonicalKinds(session.page);
        const beforeEncryptedNotes = new Set(
            (await collectAnnotationOwnershipDebugState(session.page)).canonicalEntities
                .filter(entity => entity.kind === 'note')
                .map(entity => entity.id),
        );
        await createStickyNoteWithPointer(session.page, 'generated encrypted input note', {
            x: 0.15,
            y: 0.8,
        }, 1, {allowClearPointSearch: true});
        const placementHandle = await session.page.waitForFunction((previousIds: string[]) => {
            const previous = new Set(previousIds);
            const created = Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind="note"]',
            )).find(entity => !previous.has(entity.dataset.annotationId ?? ''));
            const pageContainer = created?.closest<HTMLElement>('.page_container');
            if (!created || !pageContainer) {
                return false;
            }
            const rect = created.getBoundingClientRect();
            const pageRect = pageContainer.getBoundingClientRect();
            return {
                height: rect.height,
                insidePage: rect.left >= pageRect.left
                    && rect.right <= pageRect.right
                    && rect.top >= pageRect.top
                    && rect.bottom <= pageRect.bottom,
                pageNumber: pageContainer.dataset.page ?? null,
                width: rect.width,
            };
        }, {timeout: SAVE_TIMEOUT_MS}, [...beforeEncryptedNotes]);
        const placement = await placementHandle.jsonValue() as {
            height: number;
            insidePage: boolean;
            pageNumber: string | null;
            width: number;
        };
        await placementHandle.dispose();
        expect(placement.pageNumber).toBe('1');
        expect(placement.insidePage).toBe(true);
        expect(placement.width).toBeGreaterThan(0);
        expect(placement.height).toBeGreaterThan(0);
        await saveDecryptedOutput(session.page, encrypted.path);
        const renderResult = await verifyInteropRendering({
            artifactDirectory,
            corpusDirectory: CORPUS_DIRECTORY,
            inputPaths: [encrypted.path],
        });
        expect(renderResult.files).toHaveLength(1);
        expect(renderResult.files[0]?.qpdf.stdout).toContain('File is not encrypted');

        await openPdfInApp(session.page, encrypted.path, SAVE_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, SAVE_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, SAVE_TIMEOUT_MS);
        await expectImportedCanonicalKinds(session.page);
    }, ACCEPTANCE_TIMEOUT_MS);
});
