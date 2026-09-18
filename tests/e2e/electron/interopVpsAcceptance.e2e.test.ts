import {execFileSync} from 'node:child_process';
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {randomUUID} from 'node:crypto';
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
import {verifyInteropRendering} from '@scripts/verify-interop-rendering.mjs';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    collectAnnotationOwnershipDebugState,
    createStickyNoteWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    callWorkspaceCommand,
    waitForAutomationEvent,
    waitForSaveFrontierReady,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    triggerOpenPathInApp,
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

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
    extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
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
    execFileSync('qpdf', [
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
    await page.click('[data-testid="unencrypted-save-continue"]');
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
