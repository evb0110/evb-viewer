import {
    describe,
    expect,
    it,
} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {electronFileLogDir} from '@scripts/electron-run/electronRunSessionPaths';
import {
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {observeRendererErrors} from '@tests/e2e/electron/helpers/rendererErrorObservation';
import {triggerOpenPathInApp} from '@tests/e2e/electron/helpers/viewerCore';

const DJVU_OPEN_TIMEOUT_MS = 90_000;
const djvuFixture = resolveDjvuFixturePath();
const runOrSkip = selectFixtureDescribe(describe, djvuFixture);

runOrSkip('Electron E2E - DjVu Open Cancellation', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-djvu-open-cancellation-${Date.now()}`});

    it('cancels a recent DjVu open without showing an error', async () => {
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        const session = sessionFixture.getSession();
        const observer = await observeRendererErrors(session.page);
        try {
            const logPath = join(electronFileLogDir(session.name), 'app.ndjson');
            const initialLogLength = readFileSync(logPath, 'utf8').length;
            const openingSurface = waitForFunctionInPage(session.page, () => {
                const toolbar = (window as IE2EWindow).__evbTestApi?.getActiveToolbarSnapshot?.();
                const host = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                );
                const visible = (element: Element) => {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return rect.width > 0 && rect.height > 0
                        && style.display !== 'none' && style.visibility !== 'hidden';
                };
                return toolbar?.isOpeningDocument === true
                    && (host?.querySelectorAll('[data-testid="document-page-source-image"]').length ?? 0) === 0
                    && Array.from(host?.querySelectorAll(
                        '.document-viewer-chassis__opening-page, .document-source-viewer__skeleton, [data-document-page-visual="skeleton"]',
                    ) ?? []).some(visible);
            }, {timeout: DJVU_OPEN_TIMEOUT_MS});
            await triggerOpenPathInApp(session.page, djvuFixture.path, DJVU_OPEN_TIMEOUT_MS);
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
