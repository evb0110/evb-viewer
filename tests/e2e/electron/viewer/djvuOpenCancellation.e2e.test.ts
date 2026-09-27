import {
    describe,
    expect,
    it,
} from 'vitest';
import {readFileSync} from 'node:fs';
import {
    copyFile,
    mkdtemp,
    rm,
    truncate,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {observeRendererErrors} from '@tests/e2e/electron/helpers/rendererErrorObservation';
import {
    openDjvuInApp,
    triggerOpenPathInApp,
} from '@tests/e2e/electron/helpers/viewerCore';

const DJVU_OPEN_TIMEOUT_MS = 90_000;
const djvuFixturePath = resolve('tests/fixtures/electron/djvu-fixtures/djvu-open-cancellation-5010-pages.djvu');
const nativePreviewSourcePath = resolve('tests/fixtures/djvu/sources/browser-boundary-501-pages.djvu');

describe('Electron E2E - DjVu Open Cancellation', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-djvu-open-cancellation-${Date.now()}`});

    it('renders the first page on the native preview path for a sparse 97 MiB DjVu', async () => {
        const fixtureDirectory = await mkdtemp(join(tmpdir(), 'djvu-native-preview-'));
        const nativePreviewFixturePath = join(fixtureDirectory, 'browser-boundary-501-pages.djvu');
        try {
            await copyFile(nativePreviewSourcePath, nativePreviewFixturePath);
            await truncate(nativePreviewFixturePath, 97 * 1024 * 1024);
            const session = await sessionFixture.restart({
                clean: true,
                extraEnv: {EVB_PDF_IMAGE_COMBINE_ENABLE: '1'},
                sessionName: () => `e2e-djvu-native-preview-${Date.now()}`,
            });
            const observer = await observeRendererErrors(session.page);
            try {
                await openDjvuInApp(session.page, nativePreviewFixturePath, DJVU_OPEN_TIMEOUT_MS);
                const renderedPage = await session.page.evaluate(() => {
                    const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
                    const page = host?.querySelector<HTMLElement>(
                        '[data-testid="document-page-source-page"][data-page-number="1"]',
                    );
                    const image = page?.querySelector<HTMLImageElement>(
                        ':scope > [data-testid="document-page-source-image"]',
                    );
                    const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.();
                    return {
                        imageComplete: image?.complete ?? false,
                        imageHeight: image?.naturalHeight ?? 0,
                        imageWidth: image?.naturalWidth ?? 0,
                        pageCount: toolbar?.totalPages ?? 0,
                        pageVisual: page?.dataset.pageSourceVisual ?? null,
                        visualState: image?.dataset.documentPageVisual ?? null,
                    };
                });
                expect(renderedPage).toMatchObject({
                    imageComplete: true,
                    pageCount: 501,
                    pageVisual: 'fresh',
                    visualState: 'committed',
                });
                expect(renderedPage.imageWidth).toBeGreaterThan(0);
                expect(renderedPage.imageHeight).toBeGreaterThan(0);
                expect((await observer.collect()).visibleErrorSurfaces).toEqual([]);
            } finally {
                observer.dispose();
            }
        } finally {
            await rm(fixtureDirectory, {
                force: true,
                recursive: true,
            });
        }
    }, 120_000);

    it('cancels an opening DjVu without showing an error', async () => {
        const session = sessionFixture.getSession();
        const observer = await observeRendererErrors(session.page);
        try {
            const logPath = join(electronFileLogDir(session.name), 'app.ndjson');
            const initialLogLength = readFileSync(logPath, 'utf8').length;
            const openingSurface = waitForFunctionInPage(session.page, () => {
                const host = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                );
                const visible = (element: Element) => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return rect.width > 0 && rect.height > 0
                        && style.display !== 'none' && style.visibility !== 'hidden';
                };
                return (host?.querySelectorAll('[data-testid="document-page-source-image"]').length ?? 0) === 0
                    && Array.from(host?.querySelectorAll(
                        '[data-document-open-surface="neutral"], .document-viewer-chassis__opening-page, .document-source-viewer__skeleton, [data-document-page-visual="skeleton"]',
                    ) ?? []).some(visible);
            }, {timeout: DJVU_OPEN_TIMEOUT_MS});
            await triggerOpenPathInApp(session.page, djvuFixturePath, DJVU_OPEN_TIMEOUT_MS);
            await openingSurface;
            await session.page.click('.tab-list .tab.is-active .tab-close');

            const readNewLog = () => readFileSync(logPath, 'utf8').slice(initialLogLength);
            await expect.poll(readNewLog, {timeout: DJVU_OPEN_TIMEOUT_MS})
                .toContain('Cancel result: true');
            const cancellationLog = readNewLog();
            expect(cancellationLog).toContain('Cancel requested');
            expect(cancellationLog).not.toContain('DjVu open failed:');

            await session.page.evaluate(() => new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }));
            const errors = await observer.collect();
            expect(errors.visibleErrorSurfaces).toEqual([]);
        } finally {
            observer.dispose();
        }
    }, 120_000);
});
