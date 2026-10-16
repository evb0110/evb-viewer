import {encode} from 'fast-png';
import {
    appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync,
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
    clickVisibleToolbarButton, openDocumentSidebarTab, saveViaVisibleToolbarWithDeadline, waitForActiveDocumentSource, waitForPdfLoaded, waitForViewerInteractive,
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
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {
    PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString,
} from 'pdf-lib';

const FIXTURE_PATH = resolve(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf');

function writeTextProtectionHoldHook(directory: string, message: string) {
    const gate = join(directory, 'checkpoint');
    const hook = join(directory, 'hold-checkpoint.cjs');
    writeFileSync(hook, `const fs=require('node:fs'),fsp=require('node:fs/promises');
if(process.type==='browser'){
 const gate=${JSON.stringify(gate)},open=fsp.open;
 fsp.open=async(path,...args)=>{
  if(fs.existsSync(gate+'.arm')&&String(path).includes('workspace-')){
   fs.writeFileSync(gate+'.held','');
   if(!fs.existsSync(gate+'.release'))await new Promise(resolve=>{const watcher=fs.watch(${JSON.stringify(directory)},()=>{if(fs.existsSync(gate+'.release')){watcher.close();resolve()}})});
   if(fs.existsSync(gate+'.reject'))throw Object.assign(new Error(${JSON.stringify(message)}),{code:'ENOSPC'});
  }
  return open(path,...args);
 };
 require('node:module').syncBuiltinESMExports();
}`);
    return {
        gate,
        hook,
    };
}

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

    // A4/T2: Escape cannot discard text already accepted with Ctrl/Cmd+Enter.
    it('keeps accepted text when Escape arrives during recovery protection', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-text-commit-escape-'));
        const sourcePath = join(outputDirectory, 'accepted-text.pdf');
        copyFileSync(await createMultiPageTextFixturePdf(`commit-escape-${Date.now()}.pdf`, 1), sourcePath);
        const {
            gate, hook,
        } = writeTextProtectionHoldHook(outputDirectory, 'Text protection failed');
        session = await startElectronE2ESession(`e2e-text-commit-escape-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [sourcePath],
            extraEnv: {NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(hook)}`},
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        writeFileSync(`${gate}.arm`, '');
        const marker = 'Accepted text survives Escape';
        const annotationId = await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.4,
            y: 0.3,
        });
        await expect.poll(() => existsSync(`${gate}.held`), {timeout: 30_000}).toBe(true);
        await session.page.keyboard.press('Escape');
        writeFileSync(`${gate}.release`, '');
        const selector = `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"][data-annotation-id="${annotationId}"]`;
        await expect.poll(() => session!.page.$eval(selector, entity => ({
            text: entity.textContent?.trim(),
            editing: entity.classList.contains('is-editing'),
        })).catch(() => null), {timeout: 10_000}).toEqual({
            text: marker,
            editing: false,
        });
        await saveViaVisibleToolbarWithDeadline(session.page, 30_000, sourcePath);
        expect(await readPdfTextAnnotationRecords(sourcePath)).toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
    }, 120_000);

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

    it.runIf(process.platform === 'linux' || process.platform === 'darwin').each([
        1,
        2,
        3,
    ])('recovers text accepted immediately before SIGKILL without Save: cut %s', async (cut) => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-text-acceptance-'));
        const folder = join(outputDirectory, ...Array.from({length: 6}, (_, index) => `accepted-text-component-${index}-${'x'.repeat(80)}`));
        mkdirSync(folder, {recursive: true});
        const sourcePath = join(folder, 'accepted-text.pdf');
        copyFileSync(await createMultiPageTextFixturePdf(`accepted-text-${cut}-${Date.now()}.pdf`, 3), sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const gate = join(outputDirectory, 'text-checkpoint');
        const hook = join(outputDirectory, 'text-checkpoint.cjs');
        writeFileSync(hook, `const fs=require('node:fs'),fsp=require('node:fs/promises');
if(process.type==='browser'){
 const gate=${JSON.stringify(gate)},target=${JSON.stringify(sourcePath)},cut=${JSON.stringify(cut)},open=fsp.open,rename=fsp.rename;
 fsp.open=async(path,...args)=>{
  if(cut!==2&&fs.existsSync(gate+'.arm')&&!fs.existsSync(gate+'.release')&&String(path).includes('workspace-')){
   fs.writeFileSync(gate+'.held','');
   await new Promise(resolve=>{const watcher=fs.watch(${JSON.stringify(outputDirectory)},()=>{if(fs.existsSync(gate+'.release')){watcher.close();resolve()}})});
   if(cut===1)throw Object.assign(new Error('ENOSPC: text checkpoint volume is full'),{code:'ENOSPC'});
  }
  return open(path,...args);
 };
 fsp.rename=async(from,to)=>{await rename(from,to);if(fs.existsSync(gate+'.arm')&&String(from)===target&&String(to).includes('.evb-transition-'))fs.writeFileSync(gate+'.displaced','')};
 require('node:module').syncBuiltinESMExports();
}`);
        const extraEnv = {NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(hook)}`};
        const sessionName = `e2e-text-acceptance-${cut}-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [sourcePath],
            extraEnv,
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await clickAsUser(session.page, '.zoom-controls-display');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLElement>('.zoom-dropdown .zoom-chip'))
            .find(chip => chip.textContent?.trim() === '100%'), undefined, {description: '100% page zoom'});
        await waitForViewerInteractive(session.page, 30_000);
        const pid = getSessionInfo(session.name)?.electronPid;
        if (typeof pid !== 'number') throw new Error('The owned Electron main pid is missing');
        const marker = `Immediate accepted text ${cut}`;
        let acceptance: {
            completionMs: number;
            rectangle: number[];
            canonicalRectangle: number[];
            paintedRectangle: number[]
        } | undefined;
        session.page.on('console', (message) => {
            if (message.text().startsWith('TEXT_ACCEPTANCE ')) acceptance = JSON.parse(message.text().slice('TEXT_ACCEPTANCE '.length)) as typeof acceptance;
        });
        await session.page.evaluate(() => {
            document.addEventListener('keydown', event => {
                if (event.isTrusted && event.key === 'Enter' && (event.ctrlKey || event.metaKey)
                    && event.target instanceof HTMLElement && event.target.isContentEditable) {
                    Reflect.set(window, '__textAcceptanceStarted', performance.now());
                }
            }, {capture: true});
        });
        await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.3,
            y: 0.3,
        });
        await session.page.waitForFunction((text: string) => {
            const entity = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-annotation-kind="text-box"]'))
                .find(node => node.textContent?.trim() === text && !node.classList.contains('is-editing'));
            if (!entity || !document.querySelector('.editor-pane.is-active .tab.is-active.is-dirty')) return false;
            const bounds = entity.getBoundingClientRect();
            const layer = entity.closest('.pdf-annotation-editor-layer')?.getBoundingClientRect();
            if (!layer || bounds.width <= 0 || bounds.height <= 0 || layer.width <= 0 || layer.height <= 0) return false;
            const recovery = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.();
            const canonical = recovery?.entities.find(candidate => candidate.kind === 'text-box' && candidate.text === text);
            if (canonical?.kind !== 'text-box') throw new Error('The completed text has no canonical geometry');
            const projectedStyle = document.createElement('div').style;
            projectedStyle.left = `${canonical.rect.left * 100}%`;
            projectedStyle.top = `${canonical.rect.top * 100}%`;
            projectedStyle.width = `${canonical.rect.width * 100}%`;
            projectedStyle.height = `${canonical.rect.height * 100}%`;
            if (entity.style.left !== projectedStyle.left || entity.style.top !== projectedStyle.top
                || entity.style.width !== projectedStyle.width || entity.style.height !== projectedStyle.height) {
                throw new Error('The completed geometry differs from the displayed text box');
            }
            console.info('TEXT_ACCEPTANCE', JSON.stringify({
                paintedRectangle: [
                    (bounds.left - layer.left) / layer.width,
                    (bounds.top - layer.top) / layer.height,
                    bounds.width / layer.width,
                    bounds.height / layer.height,
                ],
                canonicalRectangle: [
                    canonical.rect.left,
                    canonical.rect.top,
                    canonical.rect.width,
                    canonical.rect.height,
                ],
                completionMs: performance.now() - Number(Reflect.get(window, '__textAcceptanceStarted')),
                rectangle: [
                    entity.style.left,
                    entity.style.top,
                    entity.style.width,
                    entity.style.height,
                ].map(value => Number.parseFloat(value) / 100),
            }));
            return true;
        }, {timeout: 30_000}, marker);
        // This is the visible editor completion, with no checkpoint observation or pause before the cut.
        process.kill(pid, 'SIGKILL');
        const crashed = session;
        await crashed.browser.disconnect();
        await stopSingleSession(crashed.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        session = null;
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        console.info('TEXT_ACCEPTANCE_CUT', JSON.stringify({
            cut,
            acceptance,
            originalUnchanged: true,
        }));
        session = await startElectronE2ESession(sessionName, {
            clean: false,
            extraEnv,
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const recovered = await session.page.waitForFunction((text: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-annotation-kind="text-box"]'),
        ).some(entity => entity.textContent?.trim() === text), {timeout: 8_000}, marker).then(() => true, () => false);
        const dirty = await session.page.$('.editor-pane.is-active .tab.is-active.is-dirty').then(Boolean);
        console.info('TEXT_ACCEPTANCE_RESTART', JSON.stringify({
            cut,
            recovered,
            dirty,
            acceptance,
        }));
        console.info(await session.captureFailureArtifacts(`text-acceptance-${cut}`));
        expect(recovered).toBe(true);
        expect(dirty).toBe(true);
        await clickAsUser(session.page, '.zoom-controls-display');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLElement>('.zoom-dropdown .zoom-chip'))
            .find(chip => chip.textContent?.trim() === '100%'), undefined, {description: '100% recovered page zoom'});
        await waitForViewerInteractive(session.page, 30_000);
        const rectangle = await session.page.$$eval('.editor-pane.is-active [data-annotation-kind="text-box"]', (nodes, text) => {
            const entity = nodes.find(node => node.textContent?.trim() === text) as HTMLElement | undefined;
            return entity ? [
                entity.style.left,
                entity.style.top,
                entity.style.width,
                entity.style.height,
            ].map(value => Number.parseFloat(value) / 100) : null;
        }, marker);
        expect(rectangle).toEqual(acceptance?.rectangle);
        const paintedRectangle = await session.page.$$eval('.editor-pane.is-active [data-annotation-kind="text-box"]', (nodes, text) => {
            const entity = nodes.find(node => node.textContent?.trim() === text);
            const bounds = entity?.getBoundingClientRect();
            const layer = entity?.closest('.pdf-annotation-editor-layer')?.getBoundingClientRect();
            return bounds && layer ? [
                (bounds.left - layer.left) / layer.width,
                (bounds.top - layer.top) / layer.height,
                bounds.width / layer.width,
                bounds.height / layer.height,
            ] : null;
        }, marker);
        expect(paintedRectangle).toEqual(acceptance?.paintedRectangle);
        expect(readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(readdirSync(folder)).toEqual(['accepted-text.pdf']);
        await saveViaVisibleToolbarWithDeadline(session.page, 30_000, sourcePath);
        await expect.poll(() => readPdfTextAnnotationRecords(sourcePath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
        const pdf = await PDFDocument.load(readFileSync(sourcePath));
        const page = pdf.getPage(0);
        const annotation = page.node.Annots()?.asArray().map(entry => pdf.context.lookupMaybe(entry, PDFDict))
            .find(item => String(item?.get(PDFName.of('Subtype'))) === '/FreeText');
        const savedRectangle = annotation?.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map(value => Number(String(value)));
        const [
            left,
            top,
            width,
            height,
        ] = acceptance!.canonicalRectangle;
        const size = page.getSize();
        const expectedRectangle = [
            left! * size.width,
            (1 - top! - height!) * size.height,
            (left! + width!) * size.width,
            (1 - top!) * size.height,
        ];
        expect(savedRectangle?.map(Math.fround)).toEqual(expectedRectangle.map(Math.fround));

        // After the immediate-cut proof, a failed or superseded transaction stays editable until corrected.
        const savedBytes = readFileSync(sourcePath);
        const runtimeErrors: string[] = [];
        session.page.on('pageerror', error => runtimeErrors.push(String(error)));
        let linkedPane: string | undefined;
        if (cut === 3) {
            await splitActiveTabFromTabMenu(session.page, 'right');
            const panes = await session.page.$$eval('.editor-pane', nodes => nodes.map(node => (node as HTMLElement).dataset.editorPaneId));
            linkedPane = panes[0];
            await waitForViewerInteractive(session.page, 30_000);
        }

        const pendingMarker = `Pending protected text ${cut}`;
        if (cut === 2) {
            await session.page.evaluate(() => {
                const workspace = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle();
                const capture = workspace?.captureCanonicalAnnotationRecovery;
                if (!workspace || !capture) throw new Error('The recovery capture is missing');
                Reflect.set(window, '__restoreTextCapture', () => {workspace.captureCanonicalAnnotationRecovery = capture;});
                workspace.captureCanonicalAnnotationRecovery = () => {throw new Error('Text checkpoint capture rejected');};
            });
        }
        writeFileSync(`${gate}.arm`, '');
        const pendingId = await createCanonicalTextBoxWithPointer(session.page, pendingMarker, {
            x: 0.3,
            y: 0.45,
        });
        let pendingRectangle = await session.page.$eval(`.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"][data-annotation-id="${pendingId}"]`, entity => {
            if (!(entity instanceof HTMLElement)) throw new Error('The text box is missing');
            return [
                entity.style.left,
                entity.style.top,
                entity.style.width,
                entity.style.height,
            ];
        });
        if (cut !== 2) {
            await expect.poll(() => existsSync(`${gate}.held`), {timeout: 30_000}).toBe(true);
            expect(await session.page.$('.editor-pane.is-active [contenteditable="true"]').then(Boolean)).toBe(true);
            expect(readFileSync(sourcePath)).toEqual(savedBytes);
            if (cut === 3) {
                await session.page.keyboard.type(' newest');
                pendingRectangle = await session.page.$eval(`.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"][data-annotation-id="${pendingId}"]`, entity => {
                    if (!(entity instanceof HTMLElement)) throw new Error('The text box is missing');
                    return [
                        entity.style.left,
                        entity.style.top,
                        entity.style.width,
                        entity.style.height,
                    ];
                });
                if (!linkedPane) throw new Error('The linked draft view is missing');
                await activatePaneByTab(session.page, linkedPane);
                await clickFoundAsUser(session.page, (input: {
                    pane: string;
                    id: string
                }) => Array.from(
                    document.querySelectorAll<HTMLElement>(`.editor-pane[data-editor-pane-id="${input.pane}"] .pdf-annotation-editor-layer [data-annotation-kind="text-box"]`),
                ).find(entity => entity.dataset.annotationId === input.id), {
                    pane: linkedPane,
                    id: pendingId,
                }, {
                    count: 2,
                    description: 'Linked view text editor',
                });
                expect(await session.page.$(`.editor-pane[data-editor-pane-id="${linkedPane}"] [contenteditable="true"]`).then(Boolean)).toBe(false);
            }
            await clickVisibleToolbarButton(session.page, 'Save');
            expect(readFileSync(sourcePath)).toEqual(savedBytes);
            expect(existsSync(`${gate}.displaced`)).toBe(false);
            writeFileSync(`${gate}.release`, '');
        }
        const expectedText = cut === 3 ? `${pendingMarker} newest` : pendingMarker;
        const cause = cut === 1 ? 'ENOSPC' : cut === 2 ? 'Text checkpoint capture rejected' : 'changed while recovery protection was pending';
        if (cut !== 3) await session.page.waitForFunction((text: string) => Array.from(document.querySelectorAll('.app-toast-failure'))
            .some(toast => toast.textContent?.includes(text)), {timeout: 30_000}, cause);
        await session.page.waitForFunction((text: string) => Array.from(document.querySelectorAll<HTMLElement>('.editor-pane [contenteditable="true"]'))
            .some(editor => editor.textContent?.trim() === text), {timeout: 30_000}, expectedText);
        expect(await session.page.$('.editor-pane.is-active .tab.is-active.is-dirty').then(Boolean)).toBe(true);
        expect(readFileSync(sourcePath)).toEqual(savedBytes);
        expect(existsSync(`${gate}.displaced`)).toBe(false);
        expect(await session.page.$$eval('.app-toast-failure', toasts => toasts.length)).toBe(cut === 3 ? 0 : 1);
        const retainedRectangle = await session.page.$$eval('.editor-pane .pdf-annotation-editor-layer [data-annotation-kind="text-box"].is-editing', (nodes, id) => {
            const entity = nodes.find(node => (node as HTMLElement).dataset.annotationId === id) as HTMLElement | undefined;
            return entity ? [
                entity.style.left,
                entity.style.top,
                entity.style.width,
                entity.style.height,
            ] : null;
        }, pendingId);
        expect(retainedRectangle).toEqual(pendingRectangle);
        console.info('TEXT_PROTECTION_FAULT', JSON.stringify({
            cut,
            cause,
            expectedText,
            originalUnchanged: true,
            published: false,
        }));
        console.info(await session.captureFailureArtifacts(`text-protection-${cut}`));
        if (cut === 2) await session.page.evaluate(() => {
            const restore = Reflect.get(window, '__restoreTextCapture');
            if (typeof restore !== 'function') throw new Error('The capture restoration is missing');
            restore();
        });
        rmSync(`${gate}.arm`);
        const retainedGeometry = await session.page.evaluate((id: string, text: string) => {
            const draft = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.()?.drafts.find(candidate => candidate.annotationId === id);
            if (!draft?.geometry || draft.text !== text) throw new Error('The retained text draft lost its geometry');
            return draft.geometry;
        }, pendingId, expectedText);
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(() => readPdfTextAnnotationRecords(sourcePath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([
                expect.objectContaining({contents: marker}),
                expect.objectContaining({contents: expectedText}),
            ]));
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {hidden: true});
        const savedRecord = (await readPdfTextAnnotationRecords(sourcePath)).find(record => record.contents === expectedText);
        const [
            objectNumber,
            generationNumber,
        ] = savedRecord!.ref.split(' ').map(Number);
        const correctedPdf = await PDFDocument.load(readFileSync(sourcePath));
        const correctedAnnotation = correctedPdf.context.lookupMaybe(PDFRef.of(objectNumber!, generationNumber!), PDFDict);
        const correctedRectangle = correctedAnnotation?.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map(value => Number(String(value)));
        const correctedSize = correctedPdf.getPage(0).getSize();
        expect(correctedRectangle?.map(Math.fround)).toEqual([
            retainedGeometry.left * correctedSize.width,
            (1 - retainedGeometry.top - retainedGeometry.height) * correctedSize.height,
            (retainedGeometry.left + retainedGeometry.width) * correctedSize.width,
            (1 - retainedGeometry.top) * correctedSize.height,
        ].map(Math.fround));
        if (cut === 3) {
            expect(await session.page.$$eval('.app-toast-failure', toasts => toasts.length)).toBe(0);
            expect(runtimeErrors).toEqual([]);
            await session.stop();
            session = await startElectronE2ESession(sessionName, {
                clean: false,
                initialOpenPaths: [sourcePath],
                extraEnv,
            });
            session.page.on('pageerror', error => runtimeErrors.push(String(error)));
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            await session.page.waitForFunction((text: string) => Array.from(
                document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-annotation-kind="text-box"]'),
            ).some(entity => entity.textContent?.trim() === text), {timeout: 30_000}, expectedText);
            expect(await session.page.$$eval('.app-toast-failure', toasts => toasts.length)).toBe(0);
            expect(runtimeErrors).toEqual([]);
        }
    }, 180_000);

    // C1/T4/A4/C2: disposing a linked viewer or refusing its tool cannot erase protected work.
    it.each([
        'close-accepted',
        'close-rejected',
        'tool-rejected',
    ] as const)('retains the document text transaction through %s', async scenario => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-view-disposal-'));
        const sourcePath = join(outputDirectory, 'linked-text.pdf');
        copyFileSync(await createMultiPageTextFixturePdf(`linked-text-${scenario}-${Date.now()}.pdf`, 3), sourcePath);
        const originalBytes = readFileSync(sourcePath);
        const {
            gate, hook,
        } = writeTextProtectionHoldHook(outputDirectory, 'ENOSPC: linked text protection failed');
        session = await startElectronE2ESession(`e2e-linked-text-${scenario}-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [sourcePath],
            extraEnv: {
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(hook)}`,
                EVB_RECORD_SESSION: '1',
            },
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        if (scenario !== 'tool-rejected') {
            await splitActiveTabFromTabMenu(session.page, 'right');
            await waitForViewerInteractive(session.page, 30_000);
        }
        await clickAsUser(session.page, '.zoom-controls-display');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLElement>('.zoom-dropdown .zoom-chip'))
            .find(chip => chip.textContent?.trim() === '100%'), undefined, {description: '100% linked text zoom'});
        await waitForViewerInteractive(session.page, 30_000);
        await session.page.evaluate(() => {
            const errors: string[] = [];
            Reflect.set(window, '__closingTextErrors', errors);
            window.addEventListener('unhandledrejection', event => {errors.push(String(event.reason));});
        });
        writeFileSync(`${gate}.arm`, '');
        if (scenario !== 'close-accepted') writeFileSync(`${gate}.reject`, '');
        const marker = `Retained linked transaction ${scenario}`;
        const annotationId = await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.3,
            y: 0.4,
        });
        await expect.poll(() => existsSync(`${gate}.held`), {timeout: 30_000}).toBe(true);
        const geometry = await session.page.evaluate((id: string) => {
            const entity = document.querySelector<HTMLElement>(`.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${id}"]`);
            const bounds = entity?.getBoundingClientRect();
            const draft = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.()?.drafts.find(candidate => candidate.annotationId === id);
            if (!draft?.geometry || !bounds?.width || !bounds.height) throw new Error('The pending text has no displayed draft geometry');
            return draft.geometry;
        }, annotationId);
        expect(readFileSync(sourcePath)).toEqual(originalBytes);
        expect(await session.page.$('.editor-pane.is-active [contenteditable="true"]').then(Boolean)).toBe(true);
        if (scenario === 'tool-rejected') {
            await clickAsUser(session.page, '.editor-pane.is-active .notes-panel .tool-button[data-tool="rectangle"]');
        } else {
            const tabId = await session.page.$eval('.editor-pane.is-active .tab.is-active', tab => tab.getAttribute('data-tab-id'));
            await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
            await session.page.waitForFunction((id: string | null) => !Array.from(document.querySelectorAll('.tab[data-tab-id]'))
                .some(tab => tab.getAttribute('data-tab-id') === id), {timeout: 30_000}, tabId);
            expect(await session.page.$('[role="dialog"]').then(Boolean)).toBe(false);
            await clickAsUser(session.page, '.editor-pane .tab[data-tab-id]');
            await waitForViewerInteractive(session.page, 30_000);
        }
        writeFileSync(`${gate}.release`, '');
        if (scenario === 'close-accepted') {
            await session.page.waitForFunction((text: string) => Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
            )).some(entity => entity.textContent?.trim() === text && !entity.classList.contains('is-editing')), {timeout: 30_000}, marker);
        } else {
            await session.page.waitForFunction(() => Array.from(document.querySelectorAll('.app-toast-failure'))
                .some(toast => toast.textContent?.includes('ENOSPC')), {timeout: 30_000});
            const retained = await session.page.evaluate((id: string) => ({
                draft: (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.()?.drafts.find(candidate => candidate.annotationId === id),
                tool: document.querySelector('.editor-pane.is-active .notes-panel .tool-button.is-active')?.getAttribute('data-tool'),
                errors: Reflect.get(window, '__closingTextErrors') as string[],
            }), annotationId);
            console.info('CLOSING_TEXT_FAULT', JSON.stringify({
                scenario,
                retained,
                geometry,
            }));
            expect.soft(retained.draft?.text).toBe(marker);
            expect.soft(retained.draft?.geometry).toEqual(geometry);
            expect.soft(retained.errors).toEqual([]);
            if (scenario === 'tool-rejected') expect.soft(retained.tool).toBe('text');
            expect(await session.page.$$eval('.app-toast-failure', toasts => toasts.length)).toBe(1);
            if (scenario === 'close-rejected') {
                await clickAsUser(session.page, `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`, {count: 2});
            }
            await session.page.waitForFunction((text: string) => Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active [contenteditable="true"]',
            )).some(editor => editor.textContent?.trim() === text), {timeout: 30_000}, marker);
        }
        expect(await session.page.$('.editor-pane.is-active .tab.is-active.is-dirty').then(Boolean)).toBe(true);
        expect(readFileSync(sourcePath)).toEqual(originalBytes);
        console.info(await session.captureFailureArtifacts(`closing-text-${scenario}-retained`));
        rmSync(`${gate}.arm`);
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(() => readPdfTextAnnotationRecords(sourcePath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {hidden: true});
        const saved = await PDFDocument.load(readFileSync(sourcePath));
        const freeText = saved.getPage(0).node.Annots()?.asArray().map(entry => saved.context.lookupMaybe(entry, PDFDict))
            .find(item => String(item?.get(PDFName.of('Subtype'))) === '/FreeText');
        const savedRectangle = freeText?.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map(value => Number(String(value)));
        const size = saved.getPage(0).getSize();
        expect(savedRectangle?.map(Math.fround)).toEqual([
            geometry.left * size.width,
            (1 - geometry.top - geometry.height) * size.height,
            (geometry.left + geometry.width) * size.width,
            (1 - geometry.top) * size.height,
        ].map(Math.fround));
        console.info('CLOSING_TEXT_SAVED', JSON.stringify({
            scenario,
            marker,
            savedRectangle,
            geometry,
        }));
        console.info(await session.captureFailureArtifacts(`closing-text-${scenario}-saved`));
    }, 180_000);

    it.each([
        [
            'double-click',
            'ENOSPC',
        ],
        [
            'Enter',
            'ENOSPC',
        ],
        [
            'double-click',
            'supersession',
        ],
        [
            'Enter',
            'supersession',
        ],
    ] as const)('refuses another viewer sidebar %s handoff after %s', async (action, reason) => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-sidebar-handoff-'));
        const sourcePath = join(outputDirectory, 'sidebar-text.pdf');
        copyFileSync(await createMultiPageTextFixturePdf(`sidebar-handoff-${Date.now()}.pdf`, 3), sourcePath);
        const originalBytes = readFileSync(sourcePath);
        const {
            gate, hook,
        } = writeTextProtectionHoldHook(outputDirectory, 'ENOSPC: sidebar text protection failed');
        session = await startElectronE2ESession(`e2e-sidebar-handoff-${action}-${reason}-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [sourcePath],
            extraEnv: {
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(hook)}`,
                EVB_RECORD_SESSION: '1',
            },
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await splitActiveTabFromTabMenu(session.page, 'right');
        await waitForViewerInteractive(session.page, 30_000);
        const panes = await session.page.$$eval('.editor-pane', nodes => nodes.map(node => (node as HTMLElement).dataset.editorPaneId));
        const targetPane = panes[0]!;
        const ownerPane = panes[1]!;
        await clickAsUser(session.page, '.zoom-controls-display');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLElement>('.zoom-dropdown .zoom-chip'))
            .find(chip => chip.textContent?.trim() === '100%'), undefined, {description: '100% sidebar handoff zoom'});
        const runtimeErrors: string[] = [];
        session.page.on('console', message => {
            if (message.text().includes('[renderer-guard]')) runtimeErrors.push(message.text());
        });
        session.page.on('pageerror', error => runtimeErrors.push(String(error)));
        writeFileSync(`${gate}.arm`, '');
        if (reason === 'ENOSPC') writeFileSync(`${gate}.reject`, '');
        const marker = `Retained sidebar ${action} ${reason}`;
        const annotationId = await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.3,
            y: 0.4,
        });
        await expect.poll(() => existsSync(`${gate}.held`), {timeout: 30_000}).toBe(true);
        if (reason === 'supersession') await session.page.keyboard.type(' newest');
        const expectedText = reason === 'supersession' ? `${marker} newest` : marker;
        const geometry = await session.page.evaluate((id: string) => {
            const draft = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.()?.drafts.find(candidate => candidate.annotationId === id);
            if (!draft?.geometry) throw new Error('The pending sidebar text has no displayed geometry');
            return draft.geometry;
        }, annotationId);
        await activatePaneByTab(session.page, targetPane);
        await openDocumentSidebarTab(session.page, 'annotations');
        const row = `.editor-pane[data-editor-pane-id="${targetPane}"] .note-item[data-annotation-id="${annotationId}"] .note-item-content`;
        await clickAsUser(session.page, row, {count: action === 'double-click' ? 2 : 1});
        if (action === 'Enter') await session.page.keyboard.press('Enter');
        expect(await session.page.$(`.editor-pane[data-editor-pane-id="${targetPane}"] [contenteditable="true"]`).then(Boolean)).toBe(false);
        expect(readFileSync(sourcePath)).toEqual(originalBytes);
        writeFileSync(`${gate}.release`, '');
        await session.page.waitForFunction((input: {
            pane: string;
            text: string
        }) => {
            const editor = document.querySelector<HTMLElement>(`.editor-pane[data-editor-pane-id="${input.pane}"] [contenteditable="true"]`);
            return editor?.textContent?.trim() === input.text && document.activeElement === editor;
        }, {timeout: 30_000}, {
            pane: ownerPane,
            text: expectedText,
        });
        const feedback = await session.page.$$eval('.app-toast-failure', toasts => toasts.map(toast => ({
            text: toast.textContent,
            id: toast.querySelector('.app-toast-error-id')?.textContent,
        })));
        const targetPdfRendered = await session.page.$(`.editor-pane[data-editor-pane-id="${targetPane}"] .page_container[data-page="1"]`).then(Boolean);
        console.info('SIDEBAR_HANDOFF_REFUSED', JSON.stringify({
            action,
            reason,
            expectedText,
            geometry,
            feedback,
            targetPdfRendered,
            runtimeErrors,
        }));
        console.info(await session.captureFailureArtifacts(`sidebar-${action}-${reason}-retained`));
        expect.soft(feedback).toHaveLength(reason === 'ENOSPC' ? 1 : 0);
        expect.soft(targetPdfRendered).toBe(true);
        expect.soft(runtimeErrors).toEqual([]);
        if (reason === 'ENOSPC') {
            const retainedCause = feedback.find(item => item.text?.includes('ENOSPC'));
            expect.soft(retainedCause?.text).toContain('Latest edits are not protected');
            expect(retainedCause?.id).toMatch(/Error ID: [0-9a-f]{8}/u);
            await clickFoundAsUser(session.page, () => {
                const toast = Array.from(document.querySelectorAll('.app-toast-failure')).find(item => item.textContent?.includes('ENOSPC'));
                return Array.from(toast?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(button => button.textContent?.includes('Copy details'));
            }, undefined, {description: 'Copy the existing sidebar protection cause'});
            await session.page.waitForFunction(() => Array.from(document.querySelectorAll('.app-toast-failure'))
                .some(toast => toast.textContent?.includes('ENOSPC') && toast.textContent.includes('Copied')), {timeout: 30_000});
            const copied = await session.page.evaluate(() => navigator.clipboard.readText());
            expect(copied).toContain('ENOSPC');
            expect(copied).toContain(retainedCause!.id!.replace('Error ID: ', ''));
        }
        expect(await session.page.$(`.editor-pane[data-editor-pane-id="${targetPane}"] [contenteditable="true"]`).then(Boolean)).toBe(false);
        expect(await session.page.$('.tab.is-active.is-dirty').then(Boolean)).toBe(true);
        expect(readFileSync(sourcePath)).toEqual(originalBytes);
        rmSync(`${gate}.arm`);
        await activatePaneByTab(session.page, ownerPane);
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(() => readPdfTextAnnotationRecords(sourcePath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([expect.objectContaining({contents: expectedText})]));
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {hidden: true});
        const saved = await PDFDocument.load(readFileSync(sourcePath));
        const freeText = saved.getPage(0).node.Annots()?.asArray().map(entry => saved.context.lookupMaybe(entry, PDFDict))
            .find(item => String(item?.get(PDFName.of('Subtype'))) === '/FreeText');
        const savedRectangle = freeText?.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map(value => Number(String(value)));
        const size = saved.getPage(0).getSize();
        expect(savedRectangle?.map(Math.fround)).toEqual([
            geometry.left * size.width,
            (1 - geometry.top - geometry.height) * size.height,
            (geometry.left + geometry.width) * size.width,
            (1 - geometry.top) * size.height,
        ].map(Math.fround));
        console.info('SIDEBAR_HANDOFF_SAVED', JSON.stringify({
            action,
            reason,
            expectedText,
            savedRectangle,
            geometry,
        }));
        console.info(await session.captureFailureArtifacts(`sidebar-${action}-${reason}-saved`));
    }, 180_000);

    it.each([
        1,
        2,
    ])('keeps the newest local text editor through an older linked handoff: cut %s', async cut => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-newest-editor-'));
        const sourcePath = join(outputDirectory, 'newest-editor.pdf');
        copyFileSync(await createMultiPageTextFixturePdf(`newest-editor-${cut}-${Date.now()}.pdf`, 3), sourcePath);
        const originalBytes = readFileSync(sourcePath);
        const {
            gate, hook,
        } = writeTextProtectionHoldHook(outputDirectory, 'ENOSPC: newest local editor protection failed');
        session = await startElectronE2ESession(`e2e-newest-editor-${cut}-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [sourcePath],
            extraEnv: {
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(hook)}`,
                EVB_RECORD_SESSION: '1',
            },
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await splitActiveTabFromTabMenu(session.page, 'right');
        await waitForViewerInteractive(session.page, 30_000);
        const panes = await session.page.$$eval('.editor-pane', nodes => nodes.map(node => (node as HTMLElement).dataset.editorPaneId));
        const targetPane = panes[0]!;
        const ownerPane = panes[1]!;
        await clickAsUser(session.page, '.zoom-controls-display');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLElement>('.zoom-dropdown .zoom-chip'))
            .find(chip => chip.textContent?.trim() === '100%'), undefined, {description: '100% newest editor zoom'});
        const localId = await createCanonicalTextBoxWithPointer(session.page, `Local Y ${cut}`, {
            x: 0.3,
            y: 0.3,
        });
        await session.page.waitForSelector('.editor-pane.is-active [contenteditable="true"]', {hidden: true});
        writeFileSync(`${gate}.arm`, '');
        const linkedText = `Linked X ${cut}`;
        const linkedId = await createCanonicalTextBoxWithPointer(session.page, linkedText, {
            x: 0.3,
            y: 0.6,
        });
        await expect.poll(() => existsSync(`${gate}.held`), {timeout: 30_000}).toBe(true);
        await activatePaneByTab(session.page, targetPane);
        await openDocumentSidebarTab(session.page, 'annotations');
        const row = (id: string) => `.editor-pane[data-editor-pane-id="${targetPane}"] .note-item[data-annotation-id="${id}"] .note-item-content`;
        await clickAsUser(session.page, row(linkedId), {count: 2});
        expect(await session.page.$(`.editor-pane[data-editor-pane-id="${targetPane}"] [contenteditable="true"]`).then(Boolean)).toBe(false);
        await clickAsUser(session.page, row(localId), {count: 2});
        const editor = `.editor-pane[data-editor-pane-id="${targetPane}"] [data-annotation-id="${localId}"] [contenteditable="true"]`;
        await session.page.waitForFunction((selector: string) => document.activeElement === document.querySelector(selector), {timeout: 30_000}, editor);
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await session.page.keyboard.down(modifier);
        try {
            await session.page.keyboard.press('A');
        } finally {
            await session.page.keyboard.up(modifier);
        }
        const newestText = `Newest Y ${cut}`;
        await session.page.keyboard.type(newestText);
        const geometry = await session.page.evaluate((id: string) => {
            const draft = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.()?.drafts.find(candidate => candidate.annotationId === id);
            if (!draft?.geometry) throw new Error('The newest local editor has no displayed geometry');
            return draft.geometry;
        }, localId);
        expect(readFileSync(sourcePath)).toEqual(originalBytes);
        writeFileSync(`${gate}.release`, '');
        await session.page.waitForSelector(`.editor-pane[data-editor-pane-id="${ownerPane}"] [data-annotation-id="${linkedId}"] [contenteditable="true"]`, {hidden: true});
        const retained = await session.page.evaluate((selector: string) => {
            const input = document.querySelector<HTMLElement>(selector);
            return {
                text: input?.textContent?.trim(),
                focused: document.activeElement === input,
                editing: Boolean(input),
            };
        }, editor);
        console.info('NEWEST_EDITOR_RETAINED', JSON.stringify({
            cut,
            retained,
            geometry,
        }));
        console.info(await session.captureFailureArtifacts(`newest-editor-${cut}-retained`));
        expect(retained).toEqual({
            text: newestText,
            focused: true,
            editing: true,
        });
        expect(await session.page.$$eval('.app-toast-failure', toasts => toasts.map(toast => toast.textContent))).toEqual([]);
        expect(await session.page.$('.editor-pane.is-active .tab.is-active.is-dirty').then(Boolean)).toBe(true);
        expect(readFileSync(sourcePath)).toEqual(originalBytes);
        rmSync(`${gate}.arm`);
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(() => readPdfTextAnnotationRecords(sourcePath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([
                expect.objectContaining({contents: newestText}),
                expect.objectContaining({contents: linkedText}),
            ]));
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {hidden: true});
        const saved = await PDFDocument.load(readFileSync(sourcePath));
        const freeText = saved.getPage(0).node.Annots()?.asArray().map(entry => saved.context.lookupMaybe(entry, PDFDict))
            .find(item => {
                const contents = item?.get(PDFName.of('Contents'));
                return (contents instanceof PDFHexString || contents instanceof PDFString) && contents.decodeText() === newestText;
            });
        const savedRectangle = freeText?.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map(value => Number(String(value)));
        const size = saved.getPage(0).getSize();
        expect(savedRectangle?.map(Math.fround)).toEqual([
            geometry.left * size.width,
            (1 - geometry.top - geometry.height) * size.height,
            (geometry.left + geometry.width) * size.width,
            (1 - geometry.top) * size.height,
        ].map(Math.fround));
        console.info('NEWEST_EDITOR_SAVED', JSON.stringify({
            cut,
            newestText,
            linkedText,
            savedRectangle,
            geometry,
        }));
        console.info(await session.captureFailureArtifacts(`newest-editor-${cut}-saved`));
    }, 180_000);

    // The main-process hook lets Save run to the cut, then holds it there until the kill.
    it.runIf(process.platform === 'linux' || process.platform === 'darwin').each([
        'displaced',
        'published',
    ] as const)('recovers the PDF and the edit when the app dies in Save at the %s original', async (cut) => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-save-crash-'));
        const sourcePath = join(outputDirectory, 'save-crash.pdf');
        copyFileSync(await createMultiPageTextFixturePdf(`save-crash-${cut}-${Date.now()}.pdf`, 3), sourcePath);
        const sourceBytes = readFileSync(sourcePath);
        const held = join(outputDirectory, 'save-held');
        const hook = join(outputDirectory, 'hold-save.cjs');
        writeFileSync(hook, `const fs = require('node:fs'), fsp = require('node:fs/promises');
if (process.type === 'browser') {
    const target = ${JSON.stringify(sourcePath)}, held = ${JSON.stringify(held)}, cut = ${JSON.stringify(cut)};
    const hold = () => { fs.writeFileSync(held, ''); return new Promise(() => {}); };
    const {rename, link} = fsp;
    fsp.rename = async (from, to) => { await rename(from, to); if (cut === 'displaced' && from === target && String(to).includes('.evb-transition-')) await hold(); };
    fsp.link = async (from, to) => { await link(from, to); if (cut === 'published' && to === target) await hold(); };
}`);
        const sessionName = `e2e-save-crash-${cut}-${Date.now()}`;
        session = await startElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: [sourcePath],
            extraEnv: {NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(hook)}`},
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const marker = `Save crash ${cut} ${Date.now()}`;
        await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.4,
            y: 0.31,
        });
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {visible: true});
        await clickVisibleToolbarButton(session.page, 'Save');
        await expect.poll(() => existsSync(held), {timeout: 60_000}).toBe(true);

        const crashed = session;
        const electronPid = getSessionInfo(crashed.name)?.electronPid;
        if (typeof electronPid !== 'number') throw new Error('The Electron main pid was missing');
        process.kill(electronPid, 'SIGKILL');
        await crashed.browser.disconnect().catch(() => undefined);
        await stopSingleSession(crashed.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        session = null;
        // At the displaced cut the PDF is gone until the restart puts it back; at the published one another program changes it.
        if (cut === 'published') appendFileSync(sourcePath, '\n% external change after crash\n');
        const onDiskBeforeRestart = cut === 'published' ? readFileSync(sourcePath) : null;

        session = await startElectronE2ESession(sessionName, {clean: false});
        await waitForPdfLoaded(session.page, 60_000);
        await session.page.waitForFunction((text: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]'),
        ).some(entity => entity.textContent?.trim() === text), {timeout: 60_000}, marker);
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {visible: true});
        if (cut === 'displaced') {
            expect(readFileSync(sourcePath)).toEqual(sourceBytes);
            expect(readdirSync(outputDirectory).filter(name => name.startsWith('save-crash'))).toEqual(['save-crash.pdf']);
            return;
        }
        await session.page.waitForFunction(() => document.body.textContent?.includes('during the save or later'), {timeout: 30_000});
        expect(readFileSync(sourcePath)).toEqual(onDiskBeforeRestart);
        expect(readFileSync(join(outputDirectory, 'save-crash (original).pdf'))).toEqual(sourceBytes);
        expect(readdirSync(outputDirectory).filter(name => name.startsWith('save-crash')).sort()).toEqual([
            'save-crash (original).pdf',
            'save-crash.pdf',
        ]);
    }, 240_000);

    // T2/A4: failed protection cannot start publication; correction preserves the accepted text and geometry.
    it.each([
        'ENOSPC',
        'capture-rejected',
    ] as const)('refuses Save before publication when its recovery protection fails: %s', async fault => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-save-protection-'));
        const folder = join(outputDirectory, ...Array.from({length: 6}, (_, index) => `recovery-component-${index}-${'x'.repeat(80)}`));
        mkdirSync(folder, {recursive: true});
        const sourcePath = join(folder, 'protected-source.pdf');
        const otherPath = join(folder, 'unrelated-source.pdf');
        const fixture = await createMultiPageTextFixturePdf(`save-protection-${fault}-${Date.now()}.pdf`, 3);
        copyFileSync(fixture, sourcePath);
        copyFileSync(fixture, otherPath);
        const sourceBytes = readFileSync(sourcePath);
        const gate = join(outputDirectory, 'gate');
        const hook = join(outputDirectory, 'protection-fault.cjs');
        writeFileSync(hook, `const fs=require('node:fs'),fsp=require('node:fs/promises');
if(process.type==='browser'){
 const target=${JSON.stringify(sourcePath)},gate=${JSON.stringify(gate)},fault=${JSON.stringify(fault)};
 const open=fsp.open,rename=fsp.rename;
 fsp.open=async(path,...args)=>{if(fault==='ENOSPC'&&fs.existsSync(gate+'.arm')&&String(path).includes('workspace-')){fs.writeFileSync(gate+'.rejected','');throw Object.assign(new Error('ENOSPC: recovery checkpoint volume is full'),{code:'ENOSPC'})}return open(path,...args)};
 fsp.rename=async(from,to)=>{await rename(from,to);if(fs.existsSync(gate+'.arm')&&String(from)===target&&String(to).includes('.evb-transition-')){fs.writeFileSync(gate+'.displaced','');await new Promise(()=>{})}};
 require('node:module').syncBuiltinESMExports();
}`);
        session = await startElectronE2ESession(`e2e-save-protection-${fault}-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [
                sourcePath,
                otherPath,
            ],
            extraEnv: {NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(hook)}`},
        });
        const clickTab = (fileName: string) => clickFoundAsUser(session!.page, (name: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane .tab[data-tab-id]'),
        ).find(tab => tab.querySelector('.tab-label')?.textContent?.includes(name)), fileName, {description: `${fileName} tab`});
        const rejectActiveCapture = async (cause: string) => session!.page.evaluate((message: string) => {
            const workspace = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle();
            const capture = workspace?.captureCanonicalAnnotationRecovery;
            if (!workspace || !capture) throw new Error('The document recovery capture is missing');
            Reflect.set(window, '__restoreProtectionCapture', () => {workspace.captureCanonicalAnnotationRecovery = capture;});
            workspace.captureCanonicalAnnotationRecovery = () => {
                Reflect.set(window, '__protectionCaptureRejected', true);
                throw new Error(message);
            };
        }, cause);
        await waitForPdfLoaded(session.page, 60_000);
        await clickTab(basename(sourcePath));
        await waitForActiveDocumentSource(session.page, sourcePath, 30_000);
        await waitForViewerInteractive(session.page, 30_000);
        const marker = `Accepted ${fault} protected text`;
        await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.3,
            y: 0.3,
        });
        await session.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {visible: true});
        await session.page.waitForFunction((text: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-annotation-kind="text-box"]'),
        ).some(entity => entity.textContent?.trim() === text && !entity.classList.contains('is-editing')), {timeout: 30_000}, marker);
        const rectangle = await session.page.evaluate((text: string) => {
            const recovery = (window as IE2EWindow).__evbTestApi?.getActiveWorkspaceHandle()?.captureCanonicalAnnotationRecovery?.();
            const entity = recovery?.entities.find(candidate => candidate.kind === 'text-box' && candidate.text === text);
            if (entity?.kind !== 'text-box') throw new Error('Accepted text has no canonical rectangle');
            return entity.rect;
        }, marker);
        if (fault === 'capture-rejected') await rejectActiveCapture('Accepted text recovery capture rejected');
        writeFileSync(`${gate}.arm`, '');
        await clickVisibleToolbarButton(session.page, 'Save');
        // Old code reaches displacement; fixed code reports failure without reaching that gate.
        await expect.poll(async () => existsSync(`${gate}.displaced`) || await session!.page.$('.app-toast-failure').then(Boolean), {timeout: 60_000}).toBe(true);
        const observation = {
            fault,
            displaced: existsSync(`${gate}.displaced`),
            rejectionInjected: fault === 'ENOSPC' ? existsSync(`${gate}.rejected`) : await session.page.evaluate(() => Reflect.get(window, '__protectionCaptureRejected') === true),
            originalUnchanged: existsSync(sourcePath) && readFileSync(sourcePath).equals(sourceBytes),
            dirty: await session.page.$('.editor-pane.is-active .tab.is-active.is-dirty').then(Boolean),
            rendered: await session.page.$$eval('.editor-pane.is-active [data-annotation-kind="text-box"]', (nodes, text) => nodes.some(node => node.textContent?.trim() === text), marker),
            cause: await session.page.$$eval('.app-toast-failure', nodes => nodes.map(node => node.textContent ?? '').join('\n')),
            beside: readdirSync(folder),
        };
        console.info('SAVE_PROTECTION_RESULT', JSON.stringify(observation));
        console.info(await session.captureFailureArtifacts(`save-protection-${fault}`));
        if (observation.displaced) {
            const crashed = session;
            const pid = getSessionInfo(crashed.name)?.electronPid;
            if (typeof pid !== 'number') throw new Error('The owned Electron main pid is missing');
            process.kill(pid, 'SIGKILL');
            await crashed.browser.disconnect();
            await stopSingleSession(crashed.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            session = null;
        }
        expect(observation.rejectionInjected).toBe(true);
        expect(observation.displaced).toBe(false);
        expect(observation.originalUnchanged).toBe(true);
        expect(observation.dirty).toBe(true);
        expect(observation.rendered).toBe(true);
        expect(observation.cause).toContain(fault === 'ENOSPC' ? 'ENOSPC' : 'Accepted text recovery capture rejected');
        expect(observation.beside.sort()).toEqual([
            'protected-source.pdf',
            'unrelated-source.pdf',
        ]);

        // Correct this document's cause, then leave a failing capture in a different dirty document.
        rmSync(`${gate}.arm`);
        if (fault === 'capture-rejected') await session!.page.evaluate(() => Reflect.get(window, '__restoreProtectionCapture')());
        await clickTab(basename(otherPath));
        await waitForActiveDocumentSource(session!.page, otherPath, 30_000);
        await waitForViewerInteractive(session!.page, 30_000);
        await createCanonicalTextBoxWithPointer(session!.page, 'Unrelated accepted text', {
            x: 0.3,
            y: 0.3,
        });
        await rejectActiveCapture('Unrelated document recovery capture rejected');
        await clickTab(basename(sourcePath));
        await waitForActiveDocumentSource(session!.page, sourcePath, 30_000);
        await waitForViewerInteractive(session!.page, 30_000);
        await clickVisibleToolbarButton(session!.page, 'Save');
        await expect.poll(() => readPdfTextAnnotationRecords(sourcePath), {timeout: 30_000})
            .toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
        await session!.page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty', {hidden: true});
        const pdf = await PDFDocument.load(readFileSync(sourcePath));
        const page = pdf.getPage(0);
        const freeText = page.node.Annots()?.asArray().map(entry => pdf.context.lookupMaybe(entry, PDFDict))
            .find(annotation => String(annotation?.get(PDFName.of('Subtype'))) === '/FreeText');
        const savedRectangle = freeText?.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map(value => Number(String(value)));
        const {
            width, height,
        } = page.getSize();
        const expectedRectangle = [
            rectangle.left * width,
            (1 - rectangle.top - rectangle.height) * height,
            (rectangle.left + rectangle.width) * width,
            (1 - rectangle.top) * height,
        ];
        expect(savedRectangle).toHaveLength(4);
        // PDF real numbers are f32; compare the exact persisted geometry at that precision.
        expect(savedRectangle!.map(Math.fround)).toEqual(expectedRectangle.map(Math.fround));
        expect(readFileSync(otherPath)).toEqual(sourceBytes);
        console.info(await session!.captureFailureArtifacts(`save-protection-${fault}-corrected`));
    }, 240_000);

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
            // Save through the shown view while the first view shows a different document.
            await clickTab(`.editor-pane[data-editor-pane-id="${restoredLeft}"]`, basename(otherPath));
            await activatePaneByTab(session.page, restoredRight!);
            await waitForActiveDocumentSource(session.page, sharedPath, 30_000);
            await waitForViewerInteractive(session.page, 30_000);
            await clickVisibleToolbarButton(session.page, 'Save');
            await expect.poll(() => readPdfTextAnnotationRecords(sharedPath), {timeout: 30_000})
                .toEqual(expect.arrayContaining([expect.objectContaining({contents: marker})]));
        } finally {
            await session?.stop();
            session = null;
        }
    }, 360_000);
});
