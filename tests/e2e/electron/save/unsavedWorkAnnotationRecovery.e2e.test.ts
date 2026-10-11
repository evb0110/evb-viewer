import {encode} from 'fast-png';
import {
    copyFileSync, readFileSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import {
    activateMenuItemAsUser, clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {tmpdir} from 'node:os';
import {
    basename, join, resolve,
} from 'node:path';
import {
    afterEach, describe, expect, it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf, createOutlinePageLabelFixturePdf, fixtureBookmark,
    readPdfMetadataWithQpdf, readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/fixtures';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    clickVisibleToolbarButton, openDocumentSidebarTab, waitForActiveDocumentSource, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activatePaneByTab, createNewWorkspaceTab, splitActiveTabFromTabMenu,
} from '@tests/e2e/electron/helpers/workspaceTabs';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    hasWorkspaceCrashCheckpoint, readWorkspaceRecoveryRecords,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {stopSingleSession} from '@scripts/electron-run/stopSession';
import {electronUserDataPath} from '@scripts/electron-run/electronRunSessionPaths';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {decodeWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';

const FIXTURE_PATH = resolve(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf');

describe('checkpointed annotation recovery', () => {
    let session: IElectronE2ESession | null = null;
    let outputDirectory: string | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
        if (outputDirectory) rmSync(outputDirectory, {
            recursive: true,
            force: true,
        });
        outputDirectory = null;
    });

    it.runIf(process.platform === 'linux' || process.platform === 'darwin').each([
        'SIGTERM',
        'SIGHUP',
    ] as const)('recovers unsaved text after %s without a close decision', async (signal) => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-sigterm-recovery-'));
        const sourcePath = join(outputDirectory, 'sigterm-source.pdf');
        copyFileSync(FIXTURE_PATH, sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const sessionName = `e2e-sigterm-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [sourcePath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const marker = `SIGTERM unsaved text ${Date.now()}`;
        await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.4,
            y: 0.31,
        });
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {visible: true});

        // A person's Quit still asks, and Cancel leaves the unsaved annotation.
        await activateMenuItemAsUser(session.page, {accelerator: 'CmdOrCtrl+Q'});
        await session.page.waitForSelector('[role="dialog"]', {visible: true});
        const decisionText = await session.page.$eval('[role="dialog"]', dialog => dialog.textContent ?? '');
        expect(decisionText).toContain('Save changes');
        expect(decisionText).toContain('Discard changes');
        expect(decisionText).toContain('Cancel');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
            .find(button => button.textContent?.trim() === 'Cancel'), null, {description: 'Cancel Quit'});
        await session.page.waitForSelector('[role="dialog"]', {hidden: true});

        const signaled = session;
        const electronPid = getSessionInfo(signaled.name)?.electronPid;
        if (typeof electronPid !== 'number') throw new Error('The Electron main pid was missing');
        const closed = new Promise<'closed'>(resolve => signaled.page.once('close', () => resolve('closed')));
        const closeDecision = signaled.page.waitForSelector('[role="dialog"]', {
            visible: true,
            timeout: 8_000,
        }).then(() => 'prompt' as const, () => 'no-prompt' as const);
        const startedAt = Date.now();
        process.kill(electronPid, signal);
        const outcome = await Promise.race([
            closed,
            closeDecision,
        ]);
        if (outcome === 'prompt') {
            console.log(`${signal} close decision:`, await signaled.page.$eval('[role="dialog"]', dialog => dialog.textContent));
            console.log(await signaled.captureFailureArtifacts('sigterm-close-decision'));
        }
        expect.soft(outcome).not.toBe('prompt');
        await expect.poll(() => isProcessAlive(electronPid), {timeout: 8_000}).toBe(false)
            .catch(error => expect.soft(error).toBeUndefined());
        const stillAlive = isProcessAlive(electronPid);
        console.log(`${signal} main pid=${electronPid}, alive=${stillAlive}, elapsedMs=${Date.now() - startedAt}`);
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(hasWorkspaceCrashCheckpoint(signaled.name)).toBe(true);
        await signaled.browser.disconnect();
        // On the red revision, model the service manager's delayed hard kill.
        await stopSingleSession(signaled.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: stillAlive,
        });
        expect(isProcessAlive(electronPid)).toBe(false);
        session = null;
        session = await startElectronE2ESession(sessionName, {clean: false});
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await session.page.waitForFunction((text: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]'),
        ).some(entity => entity.textContent?.trim() === text), {timeout: 30_000}, marker);
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {visible: true});
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        console.log(await session.captureFailureArtifacts('sigterm-recovered'));
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(() => readPdfTextAnnotationRecords(sourcePath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
    }, 180_000);

    // A logout can follow an edit within the checkpoint debounce window. The
    // signal here arrives with no pause after the edit commits.
    it.runIf(process.platform === 'linux' || process.platform === 'darwin')('keeps an edit made just before SIGTERM', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-sigterm-fresh-edit-'));
        const sourcePath = join(outputDirectory, 'sigterm-fresh-source.pdf');
        copyFileSync(FIXTURE_PATH, sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const sessionName = `e2e-sigterm-fresh-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [sourcePath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const marker = `SIGTERM fresh edit ${Date.now()}`;
        await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.4,
            y: 0.31,
        });
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {visible: true});

        const signaled = session;
        const electronPid = getSessionInfo(signaled.name)?.electronPid;
        if (typeof electronPid !== 'number') throw new Error('The Electron main pid was missing');
        process.kill(electronPid, 'SIGTERM');
        await expect.poll(() => isProcessAlive(electronPid), {timeout: 8_000}).toBe(false);
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(hasWorkspaceCrashCheckpoint(signaled.name)).toBe(true);
        await signaled.browser.disconnect();
        await stopSingleSession(signaled.name, {preserveWorkspaceCheckpoint: true});

        session = null;
        session = await startElectronE2ESession(sessionName, {clean: false});
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await session.page.waitForFunction((text: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]'),
        ).some(entity => entity.textContent?.trim() === text), {timeout: 30_000}, marker);
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(() => readPdfTextAnnotationRecords(sourcePath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
    }, 180_000);

    it('restores committed FreeText through restart and Save As', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-annotation-recovery-'));
        const sourcePath = join(outputDirectory, 'annotation-source.pdf');
        const destinationPath = join(outputDirectory, 'annotation-recovered-save-as.pdf');
        copyFileSync(FIXTURE_PATH, sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const sessionName = `e2e-unsaved-annotation-${Date.now()}`;
        const saveAsEnv = {EVB_E2E_SAVE_DIALOG_PATH: destinationPath};
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            extraEnv: saveAsEnv,
            initialOpenPaths: [sourcePath],
        });
        try {
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            const marker = `Recovered FreeText ${Date.now()}`;
            await createCanonicalTextBoxWithPointer(session.page, marker, {
                x: 0.4,
                y: 0.31,
            });
            await expect.poll(() => {
                if (!hasWorkspaceCrashCheckpoint(session!.name)) return null;
                const entry = readWorkspaceRecoveryRecords(session!.name)[0] as {checkpoint?: {tabs?: Array<{
                    isDirty?: boolean;
                    annotationRecovery?: {artifactId?: string}
                }>}} | undefined;
                const recovery = entry?.checkpoint?.tabs?.[0]?.annotationRecovery;
                if (!entry?.checkpoint?.tabs?.[0]?.isDirty || !recovery?.artifactId) return null;
                const artifactPath = join(electronUserDataPath(session!.name), 'workspace-annotation-recovery', `${recovery.artifactId}.json`);
                const payload = JSON.parse(readFileSync(artifactPath, 'utf8')) as {payload?: {entities?: Array<{text?: string}>}};
                return payload.payload?.entities ?? null;
            }, {timeout: 60_000}).toEqual(expect.arrayContaining([expect.objectContaining({text: marker})]));
            expect(readFileSync(sourcePath)).toEqual(sourceBytes);

            const crashed = session;
            await crashed.browser.disconnect();
            await stopSingleSession(crashed.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            session = await startElectronE2ESession(sessionName, {
                clean: false,
                extraEnv: saveAsEnv,
            });
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            await session.page.waitForFunction((text: string) => Array.from(
                document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]'),
            ).some(entity => entity.textContent?.trim() === text), {timeout: 60_000}, marker);
            await openDocumentSidebarTab(session.page, 'Annotations', 30_000);
            await session.page.waitForFunction((text: string) => Array.from(
                document.querySelectorAll<HTMLElement>('.editor-pane.is-active .notes-list .note-item'),
            ).some(item => item.textContent?.includes(text)), {timeout: 30_000}, marker);

            await expect(callWorkspaceCommand<boolean>(session.page, 'handleSaveAs')).resolves.toEqual({
                called: true,
                value: true,
            });
            expect(await readPdfTextAnnotationRecords(destinationPath)).toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
            expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        } finally {
            await session.stop();
        }
    }, 240_000);

    it('protects another document after an admitted image exceeds the recovery budget', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-recovery-isolation-'));
        const imagePath = join(outputDirectory, 'accepted-large-image.png');
        const pixels = new Uint8Array(1200 * 1000 * 3);
        let seed = 0x12345678;
        for (let index = 0; index < pixels.length; index += 1) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            pixels[index] = seed & 255;
        }
        writeFileSync(imagePath, encode({
            width: 1200,
            height: 1000,
            channels: 3,
            depth: 8,
            data: pixels,
        }));
        const imageDocumentPath = join(outputDirectory, 'image-document.pdf');
        const noteDocumentPath = join(outputDirectory, 'note-document.pdf');
        copyFileSync(FIXTURE_PATH, imageDocumentPath);
        copyFileSync(FIXTURE_PATH, noteDocumentPath);
        const sourceBytes = readFileSync(noteDocumentPath);
        const sessionName = `e2e-recovery-isolation-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            extraEnv: {EVB_E2E_OPEN_IMAGE_PATH: imagePath},
            initialOpenPaths: [
                imageDocumentPath,
                noteDocumentPath,
            ],
        });
        const clickTab = (fileName: string) => clickFoundAsUser(session!.page, (name: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane .tab[data-tab-id]'),
        ).find(tab => tab.querySelector('.tab-label')?.textContent?.includes(name)), fileName, {description: `${fileName} tab`});
        await waitForPdfLoaded(session.page, 60_000);
        await clickTab(basename(imageDocumentPath));
        await waitForActiveDocumentSource(session.page, imageDocumentPath, 30_000);
        await waitForViewerInteractive(session.page, 30_000);
        await clickAsUser(session.page, '.editor-pane.is-active .page_container[data-page="1"]', {button: 'right'});
        await clickFoundAsUser(session.page, () => Array.from(
            document.querySelectorAll<HTMLElement>('.annotation-context-menu [role="menuitem"]'),
        ).find(item => item.textContent?.trim() === 'Insert Image from File...'), null, {description: 'Insert Image from File menu item'});
        await session.page.waitForSelector('.editor-pane.is-active .pdf-image-placement', {
            visible: true,
            timeout: 30_000,
        });
        await clickAsUser(session.page, '.editor-pane.is-active .pdf-image-placement__action--primary');
        await session.page.waitForSelector('.editor-pane.is-active .pdf-image-placement', {
            hidden: true,
            timeout: 30_000,
        });
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {
            visible: true,
            timeout: 30_000,
        });
        await clickTab(basename(noteDocumentPath));
        await waitForActiveDocumentSource(session.page, noteDocumentPath, 30_000);
        await waitForViewerInteractive(session.page, 30_000);
        const marker = 'Other document accepted text survives the oversized image';
        await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.4,
            y: 0.31,
        });
        await expect.poll(() => {
            const checkpoint = readWorkspaceRecoveryRecords(session!.name)
                .map(record => decodeWorkspaceCheckpoint(record.checkpoint)).find(Boolean);
            const imageTab = checkpoint?.tabs.find(tab => tab.fileName === basename(imageDocumentPath));
            const noteTab = checkpoint?.tabs.find(tab => tab.fileName === basename(noteDocumentPath));
            const artifact = noteTab?.annotationRecovery;
            if (!imageTab?.annotationRecoveryFailure || !artifact) return null;
            const payload = JSON.parse(readFileSync(join(electronUserDataPath(session!.name), 'workspace-annotation-recovery', `${artifact.artifactId}.json`), 'utf8')) as {payload?: {entities?: Array<{text?: string}>}};
            return {
                rejected: imageTab.annotationRecoveryFailure.reason,
                notePresent: payload.payload?.entities?.some(entity => entity.text === marker) ?? false,
            };
        }, {timeout: 20_000}).toEqual({
            rejected: 'capture-rejected',
            notePresent: true,
        });
        await session.page.waitForFunction(() => document.body.textContent?.includes('Latest edits are not protected'), {timeout: 5_000});
        expect(readFileSync(noteDocumentPath)).toEqual(sourceBytes);
        const crashed = session;
        await crashed.browser.disconnect();
        await stopSingleSession(crashed.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        session = null;
        session = await startElectronE2ESession(sessionName, {clean: false});
        await waitForPdfLoaded(session.page, 60_000);
        await clickTab(basename(noteDocumentPath));
        await waitForActiveDocumentSource(session.page, noteDocumentPath, 30_000);
        await waitForViewerInteractive(session.page, 30_000);
        await session.page.waitForFunction((text: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-annotation-kind="text-box"]'),
        ).some(entity => entity.textContent?.trim() === text), {timeout: 20_000}, marker);
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(() => readPdfTextAnnotationRecords(noteDocumentPath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
    }, 180_000);

    it('keeps admitted bookmark edits on the shared undo timeline and saves the final redo', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-metadata-history-'));
        const originalTitle = 'Original shared-history bookmark';
        const fixture = await createOutlinePageLabelFixturePdf(`metadata-history-${Date.now()}.pdf`, [fixtureBookmark(originalTitle, 0)]);
        const sourcePath = join(outputDirectory, 'metadata-source.pdf');
        copyFileSync(fixture, sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        session = await startElectronE2ESession(`e2e-metadata-history-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [sourcePath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await openDocumentSidebarTab(session.page, 'Bookmarks');
        await clickAsUser(session.page, '.document-bookmarks-toolbar__actions button');
        await session.page.waitForSelector('.pdf-bookmarks-tree', {visible: true});
        const bookmarkTitle = () => session!.page.$eval('.pdf-bookmark-item-row', row => row.textContent?.trim());
        const titleAt = (edit: number) => edit === 0 ? originalTitle : `Shared history edit ${edit}`;
        for (let edit = 1; edit <= 60; edit += 1) {
            await clickAsUser(session.page, '.pdf-bookmark-item-row', {button: 'right'});
            await session.page.waitForSelector('.bookmarks-context-menu .pdf-context-menu__action', {visible: true});
            await clickAsUser(session.page, '.bookmarks-context-menu .pdf-context-menu__action');
            await session.page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
            await session.page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
            await session.page.keyboard.press('A');
            await session.page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
            await session.page.keyboard.type(titleAt(edit));
            await session.page.keyboard.press('Enter');
            await expect.poll(bookmarkTitle).toBe(titleAt(edit));
        }
        await clickAsUser(session.page, '.editor-pane.is-active .page_container[data-page="1"]');
        for (let edit = 59; edit >= 0; edit -= 1) {
            await activateMenuItemAsUser(session.page, {accelerator: 'CmdOrCtrl+Z'});
            await expect.poll(bookmarkTitle).toBe(titleAt(edit));
        }
        for (let edit = 1; edit <= 60; edit += 1) {
            await activateMenuItemAsUser(session.page, {accelerator: process.platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Y'});
            await expect.poll(bookmarkTitle).toBe(titleAt(edit));
        }
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(async () => (await readPdfMetadataWithQpdf(sourcePath)).outlines.map(item => item.title), {timeout: 30_000})
            .toEqual([titleAt(60)]);
    }, 240_000);

    it('restores an unsaved bookmark title and all 129 tabs after a crash', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-metadata-recovery-'));
        const originalTitle = 'Original crash-test bookmark';
        const editedTitle = 'Accepted unsaved bookmark survives crash';
        const fixture = await createOutlinePageLabelFixturePdf(`metadata-recovery-${Date.now()}.pdf`, [fixtureBookmark(originalTitle, 0)]);
        const sourcePath = join(outputDirectory, 'metadata-source.pdf');
        copyFileSync(fixture, sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const sessionName = `e2e-metadata-recovery-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [sourcePath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        for (let index = 0; index < 128; index += 1) {
            await createNewWorkspaceTab(session);
        }
        const tabIds = () => session!.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.map(tab => tab.getAttribute('data-tab-id')));
        const expectedTabIds = await tabIds();
        expect(expectedTabIds).toHaveLength(129);
        await session.page.keyboard.down('Shift');
        await session.page.keyboard.press('Tab');
        await session.page.keyboard.up('Shift');
        await session.page.keyboard.press('Home');
        await expect.poll(() => session!.page.evaluate(() => document.activeElement?.getAttribute('data-tab-id'))).toBe(expectedTabIds[0]);
        await session.page.keyboard.press('Enter');
        await expect.poll(() => session!.page.$eval('.tab-list .tab.is-active', tab => tab.getAttribute('data-tab-id'))).toBe(expectedTabIds[0]);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await openDocumentSidebarTab(session.page, 'Bookmarks');
        await clickAsUser(session.page, '.document-bookmarks-toolbar__actions button');
        await session.page.waitForSelector('.pdf-bookmarks-tree', {visible: true});
        await clickFoundAsUser(session.page, (title: string) => Array.from(document.querySelectorAll<HTMLElement>('.pdf-bookmark-item-row'))
            .find(row => row.textContent?.trim() === title), originalTitle, {
            button: 'right',
            description: 'Existing bookmark context menu',
        });
        await session.page.waitForSelector('.bookmarks-context-menu .pdf-context-menu__action', {visible: true});
        await clickAsUser(session.page, '.bookmarks-context-menu .pdf-context-menu__action');
        await session.page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
        await session.page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
        await session.page.keyboard.press('A');
        await session.page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
        await session.page.keyboard.type(editedTitle);
        await session.page.keyboard.press('Enter');
        const bookmarkTitles = () => session!.page.$$eval('.pdf-bookmark-item-row, .document-bookmark-item__row', rows => rows.map(row => row.textContent?.trim()));
        await expect.poll(bookmarkTitles).toContain(editedTitle);
        await expect.poll(() => readWorkspaceRecoveryRecords(session!.name)
            .map(record => decodeWorkspaceCheckpoint(record.checkpoint))
            .find(checkpoint => checkpoint?.tabs.some(tab => tab.isDirty))?.tabs.map(tab => tab.tabId), {timeout: 30_000}).toEqual(expectedTabIds);
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);

        const crashed = session;
        await crashed.browser.disconnect();
        await stopSingleSession(crashed.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        session = null;
        session = await startElectronE2ESession(sessionName, {clean: false});
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await expect.poll(tabIds).toEqual(expectedTabIds);
        await openDocumentSidebarTab(session.page, 'Bookmarks');
        await expect.poll(bookmarkTitles, {timeout: 20_000}).toContain(editedTitle);
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(async () => (await readPdfMetadataWithQpdf(sourcePath)).outlines.map(item => item.title), {timeout: 30_000})
            .toContain(editedTitle);
    }, 240_000);

    it('recovers a split PDF as one document when its first view is hidden', async () => {
        const stamp = Date.now();
        const sharedPath = await createMultiPageTextFixturePdf(`recovery-split-shared-${stamp}.pdf`, 3);
        const otherPath = await createMultiPageTextFixturePdf(`recovery-split-other-${stamp}.pdf`, 2);
        const sessionName = `e2e-recovery-split-hidden-${stamp}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [
                sharedPath,
                otherPath,
            ],
        });
        // The tab menu is still animating closed right after a split; a person
        // clicks the tab once nothing covers it.
        const clickTab = (paneSelector: string, fileName: string) => clickFoundAsUser(session!.page, (query: {
            selector: string;
            name: string;
        }) => Array.from(document.querySelectorAll<HTMLElement>(`${query.selector} .tab[data-tab-id]`))
            .find(candidate => candidate.querySelector('.tab-label')?.textContent?.includes(query.name)), {
            selector: paneSelector,
            name: fileName,
        }, {description: `${fileName} tab in ${paneSelector}`});
        const paneIds = () => session!.page.$$eval('.editor-pane', panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''));
        try {
            await waitForPdfLoaded(session.page, 60_000);
            // Split the shared PDF, then show the other PDF where it was: the
            // first view of the split is now a hidden tab.
            await clickTab('.editor-pane', basename(sharedPath));
            await waitForActiveDocumentSource(session.page, sharedPath, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            await splitActiveTabFromTabMenu(session.page, 'right');
            const [leftPane] = await paneIds();
            await clickTab(`.editor-pane[data-editor-pane-id="${leftPane}"]`, basename(otherPath));
            await waitForActiveDocumentSource(session.page, otherPath, 60_000);
            await expect.poll(() => {
                const tabs = (readWorkspaceRecoveryRecords(session!.name)[0] as {checkpoint?: {tabs?: Array<{
                    workingCopyRef?: string | null;
                    fileName?: string | null
                }>}} | undefined)?.checkpoint?.tabs ?? [];
                const shared = tabs.filter(tab => tab.fileName === basename(sharedPath));
                return shared.length === 2 && shared[0]?.workingCopyRef && shared[0].workingCopyRef === shared[1]?.workingCopyRef;
            }, {timeout: 60_000}).toBeTruthy();

            const crashed = session;
            await crashed.browser.disconnect();
            await stopSingleSession(crashed.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            // The crashed session is stopped; a failed restart must not stop it again.
            session = null;
            session = await startElectronE2ESession(sessionName, {clean: false});
            await waitForPdfLoaded(session.page, 60_000);

            // An edit through the shown view of the split reaches its hidden view.
            const [
                restoredLeft,
                restoredRight,
            ] = await paneIds();
            await activatePaneByTab(session.page, restoredRight!);
            await waitForActiveDocumentSource(session.page, sharedPath, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            const marker = `Split recovery ${stamp}`;
            await createCanonicalTextBoxWithPointer(session.page, marker, {
                x: 0.4,
                y: 0.3,
            });
            await clickTab(`.editor-pane[data-editor-pane-id="${restoredLeft}"]`, basename(sharedPath));
            await session.page.waitForFunction((pane: string, text: string) => {
                const root = document.querySelector(`.editor-pane[data-editor-pane-id="${pane}"]`);
                return Boolean(root?.querySelector('.tab.is-active.is-dirty'))
                    && Array.from(root?.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="text-box"]') ?? [])
                        .some(entity => entity.textContent?.trim() === text);
            }, {timeout: 60_000}, restoredLeft!, marker);
        } finally {
            await session?.stop();
            session = null;
        }
    }, 360_000);
});
