import {
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    createCanonicalAnnotationSurfaceFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';

const ACTIVE_IMAGE_PLACEMENT_SELECTOR = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .pdf-image-placement';
const CANONICAL_STAMP_SELECTOR = '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-stamp';
const STAMP_FIXTURE_PATH = join(
    process.cwd(),
    '.devkit',
    'stamp-picker-fixture-' + process.pid + '-' + Date.now() + '.jpg',
);
writeFileSync(STAMP_FIXTURE_PATH, Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAoAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Al7UCSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//Z',
    'base64',
));

const sessionFixture = createElectronE2ESessionFixture({
    restartBeforeEach: true,
    sessionName: () => 'e2e-stamp-picker-' + Date.now(),
    extraEnv: {
        EVB_E2E_OPEN_IMAGE_PATH: STAMP_FIXTURE_PATH,
        EVB_PDF_PAGE_OPS_ENABLE: '1',
    },
});

describe('stamp placement through the native picker', () => {
    it('places a stamp through the picker and reopens it in a fresh process', async () => {
        onTestFinished(() => rmSync(STAMP_FIXTURE_PATH, {force: true}));
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const fixturePath = await createCanonicalAnnotationSurfaceFixturePdf(
            'stamp-picker-' + Date.now() + '.pdf',
        );
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        const initialStampCount = (await readPdfAnnotationSummary(fixturePath)).bySubtype.Stamp ?? 0;
        const {page} = session;

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);

        const pickerResult = await callWorkspaceCommand(page, 'handleInsertImageFromFile');
        expect(pickerResult.called).toBe(true);
        await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
            timeout: 30_000,
            visible: true,
        });
        await page.click(
            ACTIVE_IMAGE_PLACEMENT_SELECTOR + ' .pdf-image-placement__action--primary',
        );
        await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
            hidden: true,
            timeout: 30_000,
        });
        await page.waitForSelector(CANONICAL_STAMP_SELECTOR, {
            timeout: 30_000,
            visible: true,
        });

        const saveEvent = await saveViaVisibleToolbar(page, 30_000, fixturePath);
        expect(realpathSync(String(saveEvent.detail.path))).toBe(realpathSync(fixturePath));
        expect((await readPdfAnnotationSummary(fixturePath)).bySubtype.Stamp).toBe(initialStampCount + 1);

        const reopenedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!reopenedSession) {
            throw new Error('Fresh Electron process failed to start');
        }
        await waitForPdfLoaded(reopenedSession.page);
        await waitForViewerInteractive(reopenedSession.page);
        await reopenedSession.page.waitForSelector(CANONICAL_STAMP_SELECTOR, {
            timeout: 30_000,
            visible: true,
        });
        expect((await readPdfAnnotationSummary(fixturePath)).bySubtype.Stamp).toBe(initialStampCount + 1);
    }, 120_000);
});
