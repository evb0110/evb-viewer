import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {Browser} from 'puppeteer-core';

const FAILURE_ARTIFACT_DIR = path.resolve(process.env.EVB_PACKAGED_SMOKE_ARTIFACT_DIR ?? '.devkit/test/packaged-core-pdf-smoke');

export async function capturePackagedCorePdfFailureArtifacts(browser: Browser | null, error: unknown) {
    try {
        const page = browser ? ((await browser.pages()).find((candidate) => !candidate.isClosed()) ?? null) : null;
        await mkdir(FAILURE_ARTIFACT_DIR, {recursive: true});
        const failure = {
            error:
                error instanceof Error
                    ? {
                          message: error.message,
                          stack: error.stack,
                      }
                    : {message: String(error)},
            renderer: page
                ? await page
                      .evaluate(() => {
                          const testApi = (
                              window as Window & {
                                  __evbTestApi?: {
                                      collectWorkspaceDebugState?: () => unknown;
                                      getAutomationEvents?: () => unknown[];
                                  };
                              }
                          ).__evbTestApi;
                          return {
                              automationEvents: testApi?.getAutomationEvents?.().slice(-40) ?? [],
                              bodyText: document.body?.innerText.slice(0, 4_000) ?? '',
                              url: window.location.href,
                              workspace: testApi?.collectWorkspaceDebugState?.() ?? null,
                          };
                      })
                      .catch((rendererError) => ({captureError: String(rendererError)}))
                : null,
            timestamp: new Date().toISOString(),
        };
        await writeFile(path.join(FAILURE_ARTIFACT_DIR, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
        if (page) {
            await page
                .screenshot({
                    fullPage: true,
                    path: path.join(FAILURE_ARTIFACT_DIR, 'renderer.png'),
                })
                .catch(() => undefined);
            await writeFile(path.join(FAILURE_ARTIFACT_DIR, 'renderer.html'), await page.content().catch(() => ''));
        }
        console.error(`Packaged core-PDF smoke diagnostics saved to ${FAILURE_ARTIFACT_DIR}`);
    } catch (captureError) {
        console.error('Could not save packaged core-PDF smoke diagnostics:', captureError);
    }
}
