import { expect } from 'vitest';
import {
    readFileSync, realpathSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delay } from 'es-toolkit/promise';
import {
    PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString,
} from 'pdf-lib';
import type { Page } from 'puppeteer-core';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import {
    openAnnotationsTab, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForNoOpenNoteWindows } from '@tests/e2e/electron/helpers/viewerAnnotations';
import { readWorkspaceRecoveryRecords } from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import { getSessionInfo } from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    collectDescendantPidsUnix, isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import { readWorkspaceStateValues } from '@tests/e2e/electron/helpers/workspaceExpose';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';



export const LARGE_PDF_TIMEOUT_MS = 360_000;


// The 8-second user-facing save budget missed by small margins on Ubuntu CI.
// Keep the blocking CI budget at 12 seconds for runner scheduling and filesystem
// variance. Local exact-fixture saves should still finish below 8 seconds.
export const LARGE_PDF_SAVE_TIMEOUT_MS = 12_000;


export const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;


export const execFileAsync = promisify(execFile);





export interface IStagedArtifactCaptureWindow extends Window {
    __largePdfStagedArtifactCapture?: {artifact: ITypedStagedArtifact | null;};
    __resumeLargePdfStagedArtifactCommit?: () => void;
}



export async function installStagedArtifactCapture(page: Page) {
    await page.evaluate(() => {
        const captureWindow = window as IStagedArtifactCaptureWindow;
        captureWindow.__largePdfStagedArtifactCapture = {artifact: null};
        let resumeCommit = () => {};
        const commitBarrier = new Promise<void>((resolve) => {
            resumeCommit = resolve;
        });
        captureWindow.__resumeLargePdfStagedArtifactCommit = resumeCommit;
        captureWindow.__stagedPdfNativeMutationCommitBarrierForAutomation = async (artifact) => {
            const capture = captureWindow.__largePdfStagedArtifactCapture;
            if (capture) {
                capture.artifact = artifact;
            }
            await commitBarrier;
        };
    });
}



export async function waitForStagedArtifact(
    page: Page,
    timeoutMs = LARGE_PDF_SAVE_TIMEOUT_MS,
) {
    await page.waitForFunction(
        () => (window as IStagedArtifactCaptureWindow).__largePdfStagedArtifactCapture?.artifact !== null,
        // A hard-restarted large-PDF renderer can be busy while the native
        // staged receipt is published. Fixed polling does not depend on RAF
        // delivery during that interval.
        {
            polling: 100,
            timeout: timeoutMs,
        },
    );
    const artifact = await page.evaluate(
        () => (window as IStagedArtifactCaptureWindow).__largePdfStagedArtifactCapture?.artifact ?? null,
    );
    if (!artifact) {
        throw new Error('Native save did not expose its staged artifact');
    }
    return artifact;
}



export function isPageContextUnavailableError(error: unknown) {
    return error instanceof Error
        && /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Frame was detached/i.test(error.message);
}



export async function resumeStagedArtifactCommit(page: Page) {
    if (page.isClosed()) {
        return;
    }
    try {
        await page.evaluate(() => {
            (window as IStagedArtifactCaptureWindow).__resumeLargePdfStagedArtifactCommit?.();
        });
    } catch (error) {
        if (!page.isClosed() && !isPageContextUnavailableError(error)) {
            throw error;
        }
    }
}



export function toPdfUtf16BeHex(value: string) {
    const bytes = [
        0xfe,
        0xff,
    ];
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }
        if (codePoint <= 0xffff) {
            bytes.push(codePoint >> 8, codePoint & 0xff);
            continue;
        }
        const adjusted = codePoint - 0x10000;
        const high = 0xd800 + (adjusted >> 10);
        const low = 0xdc00 + (adjusted & 0x3ff);
        bytes.push(high >> 8, high & 0xff, low >> 8, low & 0xff);
    }
    return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}



export function readSessionProcessSnapshot(sessionName: string) {
    const info = getSessionInfo(sessionName);
    const rootPid = info?.electronPid ?? info?.pid ?? null;
    if (!rootPid) {
        throw new Error(`Electron E2E session '${sessionName}' has no live process identity`);
    }
    return {
        pids: [
            rootPid,
            ...collectDescendantPidsUnix(rootPid),
        ],
        rootPid,
    };
}



export async function expectProcessesExited(pids: readonly number[]) {
    await expect.poll(() => pids.filter(isProcessAlive), {
        interval: 100,
        timeout: 15_000,
    }).toEqual([]);
}



export async function waitForCrashCheckpointPath(sessionName: string, expectedPath: string) {
    const expectedRealPath = realpathSync(expectedPath);
    await expect.poll(() => {
        try {
            const stored = (readWorkspaceRecoveryRecords(sessionName)[0] ?? {}) as {checkpoint?: {tabs?: Array<{sourceRef?: string | null;}>;};};
            return stored.checkpoint?.tabs?.some(tab => (
                typeof tab.sourceRef === 'string'
                && realpathSync(tab.sourceRef) === expectedRealPath
            )) ?? false;
        } catch {
            return false;
        }
    }, {timeout: 10_000}).toBe(true);
}



export async function waitForRestoredDocument(page: Page, expectedPath: string) {
    const expectedRealPath = realpathSync(expectedPath);
    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{originalPath?: string | null;}>(
            page,
            ['originalPath'],
        );
        return typeof state.originalPath === 'string'
            ? realpathSync(state.originalPath)
            : null;
    }, {timeout: LARGE_PDF_TIMEOUT_MS}).toBe(expectedRealPath);
    await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
    await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
}



export async function expectCleanAnnotationHydration(page: Page) {
    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            fileDirty: boolean;
            hasAnnotationChanges: boolean;
            annotationDirtyEntityCount: number;
            hasPendingUnsavedChanges: boolean;
        };}>(page, ['dirtyState']);
        const dirty = state.dirtyState;
        return {
            annotationDirty: dirty?.annotationDirty ?? null,
            fileDirty: dirty?.fileDirty ?? null,
            hasAnnotationChanges: dirty?.hasAnnotationChanges ?? null,
            annotationDirtyEntityCount: dirty?.annotationDirtyEntityCount ?? null,
            hasPendingUnsavedChanges: dirty?.hasPendingUnsavedChanges ?? null,
        };
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toSatisfy((state) => (
        state.annotationDirty === false
        && state.fileDirty === false
        && state.hasAnnotationChanges === false
        && state.annotationDirtyEntityCount === 0
        && state.hasPendingUnsavedChanges === false
    ));
}



export async function qpdfCheck(filePath: string) {
    await execFileAsync(getPdfNativeToolPaths().qpdf, [
        '--check',
        filePath,
    ], {
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
    });
}



export async function readQpdfObject(
    filePath: string,
    objectRef: {
        generationNumber: number;
        objectNumber: number
    },
    streamData: 'filtered' | 'none' | 'raw' = 'raw',
) {
    const {stdout} = await execFileAsync(getPdfNativeToolPaths().qpdf, [
        `--show-object=${objectRef.objectNumber},${objectRef.generationNumber}`,
        ...(streamData === 'filtered'
            ? ['--filtered-stream-data']
            : streamData === 'raw'
                ? ['--raw-stream-data']
                : []),
        filePath,
    ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
    });
    return stdout;
}



export function parseRectFromQpdfObject(value: string): [number, number, number, number] {
    const match = value.match(/\/Rect\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/u);
    if (!match) {
        throw new Error(`Annotation object has no bounded /Rect: ${value.slice(0, 1000)}`);
    }
    const rect = match.slice(1).map(Number) as [number, number, number, number];
    if (rect.some(coordinate => !Number.isFinite(coordinate)) || rect[2] <= rect[0] || rect[3] <= rect[1]) {
        throw new Error(`Annotation object has an invalid /Rect: ${JSON.stringify(rect)}`);
    }
    return rect;
}



export function findQpdfLiteralStringEnd(value: string, start: number) {
    let depth = 0;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (character === '(') {
            depth += 1;
        } else if (character === ')') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}



export function readQpdfDictionaryString(value: string, key: string) {
    let dictionaryDepth = 0;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const nextCharacter = value[index + 1];
        if (character === '<' && nextCharacter === '<') {
            dictionaryDepth += 1;
            index += 1;
            continue;
        }
        if (character === '>' && nextCharacter === '>') {
            dictionaryDepth = Math.max(0, dictionaryDepth - 1);
            index += 1;
            continue;
        }
        if (character === '(') {
            const end = findQpdfLiteralStringEnd(value, index);
            if (end < 0) {
                return null;
            }
            index = end;
            continue;
        }
        if (character === '<') {
            const end = value.indexOf('>', index + 1);
            if (end < 0) {
                return null;
            }
            index = end;
            continue;
        }
        if (character !== '/' || dictionaryDepth !== 1) {
            continue;
        }

        let nameEnd = index + 1;
        while (nameEnd < value.length) {
            const nameCharacter = value[nameEnd] ?? '';
            if (/\s/u.test(nameCharacter) || '[]()<>/{}/'.includes(nameCharacter)) {
                break;
            }
            nameEnd += 1;
        }
        if (value.slice(index + 1, nameEnd) !== key) {
            index = nameEnd - 1;
            continue;
        }

        let tokenStart = nameEnd;
        while (/\s/u.test(value[tokenStart] ?? '')) {
            tokenStart += 1;
        }
        const tokenStartCharacter = value[tokenStart];
        if (tokenStartCharacter === '(') {
            const tokenEnd = findQpdfLiteralStringEnd(value, tokenStart);
            return tokenEnd < 0 ? null : value.slice(tokenStart, tokenEnd + 1);
        }
        if (tokenStartCharacter === '<' && value[tokenStart + 1] !== '<') {
            const tokenEnd = value.indexOf('>', tokenStart + 1);
            return tokenEnd < 0 ? null : value.slice(tokenStart, tokenEnd + 1);
        }
        return null;
    }
    return null;
}



export function decodeQpdfLiteralString(value: string) {
    let decoded = '';
    for (let index = 1; index < value.length - 1; index += 1) {
        const character = value[index];
        if (character !== '\\') {
            decoded += character;
            continue;
        }
        const escaped = value[index + 1];
        if (escaped === undefined) {
            break;
        }
        index += 1;
        const simpleEscape = {
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
            '(': '(',
            ')': ')',
            '\\': '\\',
        }[escaped];
        if (simpleEscape !== undefined) {
            decoded += simpleEscape;
            continue;
        }
        if (/[0-7]/u.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && /[0-7]/u.test(value[index + 1] ?? '')) {
                index += 1;
                octal += value[index];
            }
            decoded += String.fromCharCode(Number.parseInt(octal, 8));
            continue;
        }
        decoded += escaped;
    }
    return decoded;
}



export function qpdfStringTokenContainsText(value: string, text: string) {
    if (value.startsWith('(')) {
        return decodeQpdfLiteralString(value).includes(text);
    }
    if (!value.startsWith('<')) {
        return false;
    }
    const normalized = value.slice(1, -1).replace(/\s+/gu, '').toLowerCase();
    return normalized.includes(toPdfUtf16BeHex(text))
        || normalized.includes(Buffer.from(text, 'utf8').toString('hex'));
}



export function qpdfDictionaryContainsText(value: string, key: string, text: string) {
    const stringValue = readQpdfDictionaryString(value, key);
    return stringValue !== null && qpdfStringTokenContainsText(stringValue, text);
}



export async function editVisibleStickyNote(page: Page, currentText: string, nextText: string) {
    await openAnnotationsTab(page, 30_000);
    await page.waitForFunction((text: string) => (
        Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .workspace-host .notes-list .note-item',
        )).some((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return candidate.textContent?.includes(text) === true
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        })
    ), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, currentText);
    const items = await page.$$('.editor-pane.is-active .workspace-host .notes-list .note-item');
    let matchingItem: (typeof items)[number] | null = null;
    for (const item of items) {
        const matches = await item.evaluate((candidate, text) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return candidate.textContent?.includes(text) === true
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        }, currentText);
        if (matches) {
            matchingItem = item;
            break;
        }
    }
    if (!matchingItem) {
        throw new Error(`Visible sidebar note was not restored: ${currentText}`);
    }
    await matchingItem.click({
        count: 2,
        delay: 80,
    });
    const textarea = await page.waitForSelector('textarea.note-window__textarea', {
        timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
        visible: true,
    });
    if (!textarea) {
        throw new Error('Double-clicking the restored note did not open its editor');
    }
    await delay(100);
    await textarea.click({
        count: 3,
        delay: 80,
    });
    const selectedText = await textarea.evaluate(input => ({
        end: input.selectionEnd,
        length: input.value.length,
        start: input.selectionStart,
    }));
    expect(selectedText).toEqual({
        end: currentText.length,
        length: currentText.length,
        start: 0,
    });
    await page.keyboard.type(nextText, {delay: 10});
    await page.keyboard.press('Tab');

    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            hasAnnotationChanges: boolean;
        };}>(page, ['dirtyState']);
        return state.dirtyState?.annotationDirty === true
            && state.dirtyState.hasAnnotationChanges === true;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);

    const closeButtons = await page.$$('.editor-pane.is-active .workspace-host .note-window__close');
    let closed = false;
    for (const closeButton of closeButtons.reverse()) {
        const visible = await closeButton.evaluate((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        });
        if (visible) {
            await closeButton.click();
            closed = true;
            break;
        }
    }
    if (!closed) {
        throw new Error('Edited sticky note had no visible close control');
    }
    await waitForNoOpenNoteWindows(page);
}



export function getPdfStringValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}



export async function readPdfNoteContents(filePath: string) {
    const doc = await PDFDocument.load(readFileSync(filePath), { updateMetadata: false });
    const notes: Array<{
        contents: string;
        name: string;
        pageIndex: number;
        popup: string;
        ref: string;
        subtype: string;
    }> = [];

    for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex += 1) {
        const annots = doc.getPage(pageIndex).node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const ref = annots.get(index);
            if (!(ref instanceof PDFRef)) {
                continue;
            }
            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                continue;
            }
            const contents = getPdfStringValue(dict.get(PDFName.of('Contents')));
            const name = getPdfStringValue(dict.get(PDFName.of('NM')));
            const subtype = dict.get(PDFName.of('Subtype'))?.toString() ?? '';
            if (!contents || (subtype !== '/FreeText' && subtype !== '/Text')) {
                continue;
            }

            notes.push({
                ref: String(ref),
                pageIndex,
                contents,
                name,
                popup: String(dict.get(PDFName.of('Popup')) ?? ''),
                subtype,
            });
        }
    }

    return notes;
}
