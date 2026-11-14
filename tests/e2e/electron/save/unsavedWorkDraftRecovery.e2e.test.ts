import {decodeManifest} from '@document-store/documentDirectory';
import {
    copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {
    basename, dirname, join,
} from 'node:path';
import {
    expect, it,
} from 'vitest';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openDocumentSidebarTab, openPdfInApp, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {clickAnnotationTool, createStickyNoteWithPointer, selectAllFocusedAnnotationText} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {getActiveWorkspaceWorkingCopyPath, readDocumentBytes} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    createMultiPageTextFixturePdf, readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    readWorkspaceStateValues, requireWorkspaceCommand, waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    hasWorkspaceCrashCheckpoint,
    readWorkspaceRecoveryRecords,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {stopSingleSession} from '@scripts/electron-run/stopSession';

interface IPoint {
    readonly x: number;
    readonly y: number;
}

it.each(['text-box', 'note', 'rejected-note'])(
    'restores focused %s typing after SIGKILL following a durable draft write', async (kind) => {
        const outputDirectory = mkdtempSync(join(tmpdir(), 'evb-draft-recovery-'));
        const sourcePath = join(outputDirectory, 'draft-source.pdf');
        copyFileSync(join(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf'), sourcePath);
        const sessionName = `e2e-unsaved-draft-${Date.now()}`;
        let session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [sourcePath],
        });
        try {
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            if (kind === 'rejected-note') {
                // Reject the canonical note boundary; durable draft storage still works.
                await session.page.setCacheEnabled(false);
                await session.page.setRequestInterception(true);
                let injected = false;
                session.page.on('request', async request => {
                    const url = new URL(request.url());
                    const asset = url.protocol === 'file:' ? fileURLToPath(url) : join(process.cwd(), 'nuxt-output', 'public', url.pathname);
                    if (!/\.js(?:\?|$)/u.test(request.url()) || !existsSync(asset)) {
                        await request.continue();
                        return;
                    }
                    const body = readFileSync(asset, 'utf8');
                    const seam = /updateAnnotationCommentInViewer:\s*\([^)]*\)\s*=>\s*\{/u;
                    if (!seam.test(body)) {
                        await request.continue();
                        return;
                    }
                    injected = true;
                    await request.respond({status: 200, contentType: 'application/javascript', body: body.replace(seam,
                        '$&if(Reflect.get(window,"__rejectNoteUpdate")){Reflect.set(window,"__noteUpdateRejected",true);throw new Error("Sustained canonical note rejection");}')});
                });
                await session.page.reload();
                await openPdfInApp(session.page, sourcePath);
                await waitForPdfLoaded(session.page, 60_000);
                await waitForViewerInteractive(session.page, 60_000);
                expect(injected).toBe(true);
            }
            await requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]);
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
            if (kind === 'text-box') {
                await clickAnnotationTool(session.page, 'Text', 30_000);
                const pointHandle = await session.page.waitForFunction(() => {
                    const page = document.querySelector<HTMLElement>('.editor-pane.is-active .page_container[data-page="1"]');
                    const layer = page?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
                    const background = layer?.querySelector<HTMLElement>('.pdf-annotation-editor-surface__background');
                    const rect = layer?.getBoundingClientRect();
                    if (
                        !page
                        || !page.classList.contains('page_container--rendered')
                        || page.dataset.pageLayerReadiness !== 'ready'
                        || !layer
                        || layer.dataset.pdfAnnotationEditorReady !== 'true'
                        || !layer.classList.contains('is-interactive')
                        || !background
                        || getComputedStyle(background).pointerEvents === 'none'
                        || !rect
                        || rect.width <= 0
                        || rect.height <= 0
                    ) return false;
                    const x = rect.left + rect.width * 0.42;
                    const y = rect.top + rect.height * 0.31;
                    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
                    return document.elementFromPoint(x, y) === background
                        ? {
                            x,
                            y,
                        }
                        : false;
                }, {timeout: 30_000});
                const point = await pointHandle.jsonValue() as IPoint;
                await pointHandle.dispose();
                await session.page.mouse.click(point.x, point.y);
                const editor = '.editor-pane.is-active .pdf-annotation-editor-text-box.is-editing [contenteditable="true"]';
                try {
                    await session.page.waitForFunction((selector: string) => document.activeElement === document.querySelector(selector), {timeout: 30_000}, editor);
                } catch (error) {
                    const visibleState = await session.page.evaluate(() => ({
                        activeElement: document.activeElement?.tagName ?? null,
                        editingEditorVisible: Boolean(document.querySelector('.pdf-annotation-editor-text-box.is-editing [contenteditable="true"]')),
                        activeTool: document.querySelector('.editor-pane.is-active .notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                        visiblePageText: document.querySelector<HTMLElement>('.editor-pane.is-active .page_container[data-page="1"]')?.innerText.slice(0, 240) ?? null,
                    }));
                    await session.page.screenshot({
                        path: join(outputDirectory, 'focus-timeout.png'),
                        fullPage: true,
                    });
                    throw new Error(`${String(error)}; visible UI state: ${JSON.stringify(visibleState)}`);
                }
            }
            const draftText = `Focused ${kind} draft ${Date.now()}`;
            if (kind !== 'text-box') {
                await createStickyNoteWithPointer(session.page, 'Previously accepted note', {x: 0.4, y: 0.3});
                await clickAsUser(session.page, 'textarea.note-window__textarea');
                await selectAllFocusedAnnotationText(session.page);
                if (kind === 'rejected-note') {
                    await session.page.evaluate(() => Reflect.set(window, '__rejectNoteUpdate', true));
                    // First reject an earlier update, then type while rejection persists.
                    await session.page.keyboard.type('Earlier rejected note draft');
                    await session.page.waitForFunction(() => Reflect.get(window, '__noteUpdateRejected') === true);
                    await selectAllFocusedAnnotationText(session.page);
                }
            }
            const pid = getSessionInfo(session.name)?.electronPid;
            if (typeof pid !== 'number') throw new Error('Owned Electron main PID is missing');
            await session.page.keyboard.type(draftText, {delay: 10});
            // Recovery promises one durable draft write after the change, independent of host speed.
            await expect.poll(() => JSON.stringify(readWorkspaceRecoveryRecords(session.name)), {timeout: 30_000})
                .toContain(draftText);
            process.kill(pid, 'SIGKILL');
            const crashed = session;
            await crashed.browser.disconnect();
            await stopSingleSession(crashed.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            session = await startElectronE2ESession(sessionName, {clean: false});
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            if (kind !== 'text-box') await openDocumentSidebarTab(session.page, 'annotations');
            await session.page.waitForFunction((text: string) => {
                const boxes = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-text-box'));
                const notes = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'));
                const comments = Array.from(document.querySelectorAll<HTMLElement>('.notes-list .note-item-text'));
                return boxes.some(editor => editor.innerText === text && editor.getClientRects().length > 0)
                    || notes.some(editor => editor.value === text && editor.getClientRects().length > 0)
                    || comments.some(comment => comment.innerText.trim() === text && comment.getClientRects().length > 0);
            }, {timeout: 60_000}, draftText).catch(async error => {
                console.info('FOCUSED_TYPING_RECOVERY_FAILURE', JSON.stringify(await session.page.evaluate(() => ({
                    text: document.body.innerText,
                    capture: (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.(),
                }))));
                throw error;
            });
            expect(JSON.stringify(readWorkspaceRecoveryRecords(session.name))).toContain(draftText);
            // Report the live recovered state after the durable cut for retained evidence.
            console.info('FOCUSED_TYPING_RECOVERED', JSON.stringify({kind, text: draftText,
                capture: await session.page.evaluate(() => (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.())}));
            const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
            expect(state.dirtyState?.fileDirty).toBe(true);

        } finally {
            await session.stop();
            rmSync(outputDirectory, {
                recursive: true,
                force: true,
            });
        }
    }, 90_000);

it('keeps an unsaved page edit through a crash and a reboot that empties the temp folder', async () => {
    const sourcePath = await createMultiPageTextFixturePdf(`reboot-recovery-${Date.now()}.pdf`, 2);
    const rebootTempDir = mkdtempSync(join(tmpdir(), 'evb-reboot-tmp-'));
    const extraEnv = {
        TMPDIR: rebootTempDir,
        TMP: rebootTempDir,
        TEMP: rebootTempDir,
    };
    const sessionName = `e2e-reboot-recovery-${Date.now()}`;
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        extraEnv,
        initialOpenPaths: [sourcePath],
    });
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]);
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        await expect.poll(() => {
            if (!hasWorkspaceCrashCheckpoint(session.name)) return null;
            const record = readWorkspaceRecoveryRecords(session.name)[0] as {checkpoint?: {tabs?: Array<{isDirty?: boolean}>}} | undefined;
            return record?.checkpoint?.tabs?.[0]?.isDirty ?? null;
        }, {timeout: 60_000}).toBe(true);

        const crashed = session;
        await crashed.browser.disconnect();
        await stopSingleSession(crashed.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        // Empty this session's OS temp folder, preserving its durable app state
        // and every other session's scratch.
        for (const entry of readdirSync(rebootTempDir)) {
            rmSync(join(rebootTempDir, entry), {
                recursive: true,
                force: true,
            });
        }
        session = await startElectronE2ESession(sessionName, {
            clean: false,
            extraEnv,
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);

        await session.page.waitForFunction(() => {
            const rect = document.querySelector('.editor-pane.is-active .page_container[data-page="1"]')?.getBoundingClientRect();
            return Boolean(rect && rect.width > rect.height);
        }, {timeout: 60_000});
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        expect((await readPdfPageSnapshots(await readDocumentBytes(session.page)))[0]?.rotation).toBe(90);
        expect((await readPdfPageSnapshots(sourcePath))[0]?.rotation).toBe(0);
    } finally {
        await session.stop();
        rmSync(sourcePath, {force: true});
        rmSync(rebootTempDir, {
            recursive: true,
            force: true,
        });
    }
});

it('keeps a restored tab\'s unsaved changes for a later start when its working copy is missing', async () => {
    const sourcePath = await createMultiPageTextFixturePdf(`lost-working-copy-${Date.now()}.pdf`, 2);
    const fileName = basename(sourcePath);
    const sessionName = `e2e-lost-working-copy-${Date.now()}`;
    const firstPageIsLandscape = () => {
        const rect = document.querySelector('.editor-pane.is-active .page_container[data-page="1"]')?.getBoundingClientRect();
        return rect ? rect.width > rect.height : null;
    };
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        initialOpenPaths: [sourcePath],
    });
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]);
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        const readStoredTab = () => {
            if (!hasWorkspaceCrashCheckpoint(session.name)) return null;
            const record = readWorkspaceRecoveryRecords(session.name)[0] as {checkpoint?: {tabs?: Array<{
                isDirty?: boolean;
                workingCopyRef?: string | null;
            }>}} | undefined;
            return record?.checkpoint?.tabs?.[0] ?? null;
        };
        await expect.poll(readStoredTab, {timeout: 60_000}).toMatchObject({
            isDirty: true,
            workingCopyRef: workingCopyPath,
        });
        // Remove only the current bytes; retain the recovery manifest.
        const documentDirectory = dirname(workingCopyPath);
        const revision = decodeManifest(readFileSync(join(documentDirectory, 'manifest.json'))).current;
        if (!revision) throw new Error('Rotation did not create a document revision');
        const revisionPath = join(documentDirectory, revision.file);
        const awayPath = `${revisionPath}.away`;
        const crashAndRestart = async (from: string, to: string) => {
            await session.browser.disconnect();
            await stopSingleSession(session.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            renameSync(from, to);
            session = await startElectronE2ESession(sessionName, {clean: false});
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
        };

        // The checkpoint came along and its working copy did not, as on a
        // roaming profile opened on another computer.
        await crashAndRestart(revisionPath, awayPath);

        const note = await session.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('li, [role="status"], [role="alert"]'))
            .map(element => element.innerText)
            .find(text => text.includes('Unsaved changes not found')) ?? false, {timeout: 60_000});
        expect(await note.jsonValue()).toContain(`The unsaved changes to ${fileName} are in a working copy that is missing on this computer, so the document opened as last saved. They are kept for a later start that finds the working copy.`);
        await expect.poll(() => session.page.evaluate(firstPageIsLandscape), {timeout: 60_000}).toBe(false);
        // Saving the document as it shows would drop those changes, so Save refuses and the tab stays changed.
        await clickAsUser(session.page, 'button.save-split-primary');
        await session.page.waitForFunction(() => document.body.innerText.includes('these changes cannot be saved'), {timeout: 60_000});
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        expect((await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState'])).dirtyState?.fileDirty).toBe(true);
        expect(existsSync(revisionPath)).toBe(false);
        await expect.poll(readStoredTab, {timeout: 60_000}).toMatchObject({
            isDirty: true,
            workingCopyRef: workingCopyPath,
        });

        await crashAndRestart(awayPath, revisionPath);
        await expect.poll(() => session.page.evaluate(firstPageIsLandscape), {timeout: 60_000}).toBe(true);
        expect((await readPdfPageSnapshots(sourcePath))[0]?.rotation).toBe(0);
    } finally {
        await session.stop();
        rmSync(sourcePath, {force: true});
    }
});
