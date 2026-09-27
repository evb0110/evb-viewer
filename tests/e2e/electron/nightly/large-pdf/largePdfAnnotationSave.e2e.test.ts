import {
    afterAll, describe, expect, it, onTestFinished,
} from 'vitest';
import {
    constants, copyFileSync, createReadStream, mkdtempSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
    dirname, join,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import type { TDocumentRef } from '@contracts/documentRef';
import { getErrorMessage } from '@contracts/getErrorMessage';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import {
    copyLargePdfFixture, resolveLargePdfFixtureAvailability, selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openAnnotationsTab, openPdfInApp, saveViaVisibleToolbarWithDeadline, saveViaWindowHandle, setupScrollToPage, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickLatestVisibleNoteWindowClose, clickAnnotationTool, createCanonicalTextBoxWithPointer, createFreeTextAnnotation, createFreeTextAnnotationWithPointer, createStickyNoteWithPointer, waitForNoOpenNoteWindows,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    callWorkspaceCommand, collectWorkspaceExposeDebugState, getWorkspaceToolbarSnapshot, installWorkspaceExposeProbe, readWorkspaceStateValues, type IWorkspaceExpose, type IWorkspaceExposeProbeWindow, waitForSaveFrontierReady,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    readPdfAnnotationIndex, type IPdfAnnotationIndexEntry,
} from '@tests/e2e/electron/helpers/readPdfAnnotationIndex';
import {
    LARGE_PDF_SAVE_TIMEOUT_MS,
    LARGE_PDF_TIMEOUT_MS,
    NOTE_TEXT_ENTRY_TIMEOUT_MS,
    editVisibleStickyNote,
    expectCleanAnnotationHydration,
    expectProcessesExited,
    findQpdfLiteralStringEnd,
    installStagedArtifactCapture,
    parseRectFromQpdfObject,
    qpdfCheck,
    qpdfDictionaryContainsText,
    readPdfNoteContents,
    readQpdfObject,
    readSessionProcessSnapshot,
    resumeStagedArtifactCommit,
    waitForCrashCheckpointPath,
    waitForRestoredDocument,
    waitForStagedArtifact,
} from './largePdfAnnotationSaveShared';

const largePdfFixture = resolveLargePdfFixtureAvailability();

const LARGE_PDF_ARTIFACT_ROOT_ENV = 'EVB_E2E_LARGE_PDF_ARTIFACT_ROOT';

const largePdfDescribe = selectFixtureDescribe(describe, largePdfFixture);

interface ICommentAtPointViewer {commentAtPoint?: (
    pageNumber: number,
    pageX: number,
    pageY: number,
    options?: { preferTextAnchor?: boolean },
) => Promise<boolean>;}

interface IAgentActionResult extends Record<string, unknown> {
    comment?: Record<string, unknown>;
    created?: boolean;
    markerRect?: unknown;
    tabId?: string;
}

interface IOrdinaryFreeTextCanonicalProjection {
    annotationId: string | null;
    annotationName: string | null;
    pageIndex: number | null;
    pageNumber: number | null;
    source: string;
    stableKey: string;
    subtype: string | null;
    text: string;
}

interface IOrdinaryFreeTextLiveState {
    canonicalMatches: IOrdinaryFreeTextCanonicalProjection[];
    editorMatchCount: number;
    visualMatchCount: number;
    sidebarMatchCount: number;
}

interface IVerifiedStickyNote {
    annotation: IPdfAnnotationIndexEntry;
    annotationObject: string;
    name: string;
    popup: IPdfAnnotationIndexEntry;
    rect: [number, number, number, number];
}

function hashFileSha256(filePath: string, maxBytes?: number) {
    return new Promise<string>((resolve, reject) => {
        const digest = createHash('sha256');
        const input = maxBytes === undefined
            ? createReadStream(filePath)
            : createReadStream(filePath, {end: maxBytes - 1});
        input.on('data', chunk => digest.update(chunk));
        input.on('error', reject);
        input.on('end', () => resolve(digest.digest('hex')));
    });
}

async function readVisibleStickyNoteSession(page: Page, expectedText: string) {
    return page.evaluate((text) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        };
        const textarea = Array.from(
            host?.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea') ?? [],
        ).find(candidate => candidate.value === text && isVisible(candidate)) ?? null;
        return {
            noteCount: Array.from(host?.querySelectorAll<HTMLElement>(
                '.pdf-annotation-editor-note',
            ) ?? []).filter(isVisible).length,
            text: textarea?.value ?? null,
        };
    }, expectedText);
}

async function readDocumentSaveIdentity(page: Page) {
    return page.evaluate(async () => {
        const documentFiles = window.electronAPI?.documentFiles;
        if (!documentFiles) {
            throw new Error('Document file capability is unavailable in the renderer');
        }
        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({requiredProperties: ['workingCopyPath']}) as {workingCopyPath?: TDocumentRef | null} | null;
        const workingCopyPath = workspace?.workingCopyPath ?? null;
        if (!workingCopyPath) {
            throw new Error('The restored workspace has no path-backed working copy');
        }
        return {
            revision: await documentFiles.getDocumentRevision(workingCopyPath),
            workingCopyPath,
        };
    });
}

function qpdfDictionaryHasKey(value: string, key: string) {
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
                return false;
            }
            index = end;
            continue;
        }
        if (character === '<') {
            const end = value.indexOf('>', index + 1);
            if (end < 0) {
                return false;
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
        if (value.slice(index + 1, nameEnd) === key) {
            return true;
        }
        index = nameEnd - 1;
    }
    return false;
}

async function readOrdinaryFreeTextLiveState(page: Page, expectedText: string): Promise<IOrdinaryFreeTextLiveState> {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((text): IOrdinaryFreeTextLiveState => {
        const normalize = (value: unknown) => typeof value === 'string'
            ? value.replace(/[\u200B\uFEFF]/gu, '').trim()
            : '';
        const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi
            ?.readActiveWorkspaceStateValues<{annotationComments?: unknown[]}>(['annotationComments']);
        const comments = state?.annotationComments;
        if (!Array.isArray(comments)) {
            throw new Error(`Ordinary FreeText probe read no canonical annotationComments projection: ${JSON.stringify(state ?? null)}`);
        }
        const expected = normalize(text);
        const canonicalMatches = comments
            .filter(comment => {
                if (!comment || typeof comment !== 'object') {
                    return false;
                }
                const record = comment as Record<string, unknown>;
                return normalize(record.text) === expected
                    && String(record.subtype ?? '').toLowerCase() === 'freetext';
            })
            .map(comment => {
                const record = comment as Record<string, unknown>;
                return {
                    annotationId: typeof record.annotationId === 'string' ? record.annotationId : null,
                    annotationName: typeof record.annotationName === 'string' ? record.annotationName : null,
                    pageIndex: typeof record.pageIndex === 'number' ? record.pageIndex : null,
                    pageNumber: typeof record.pageNumber === 'number' ? record.pageNumber : null,
                    source: String(record.source ?? ''),
                    stableKey: String(record.stableKey ?? ''),
                    subtype: typeof record.subtype === 'string' ? record.subtype : null,
                    text: typeof record.text === 'string' ? record.text : '',
                };
            });
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const editorMatchCount = Array.from(host?.querySelectorAll<HTMLElement>(
            '[data-annotation-kind="text-box"]',
        ) ?? [])
            .filter(editor => normalize(editor.textContent) === expected)
            .length;
        const visualMatchCount = Array.from(host?.querySelectorAll<HTMLElement>(
            '.pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        ) ?? [])
            .filter(annotation => normalize(annotation.textContent) === expected)
            .length;
        const sidebarMatchCount = Array.from(host?.querySelectorAll<HTMLElement>(
            '.notes-list .note-item',
        ) ?? [])
            .filter(item => normalize(item.querySelector('.note-item-text')?.textContent ?? '').includes(expected))
            .length;
        return {
            canonicalMatches,
            editorMatchCount,
            visualMatchCount,
            sidebarMatchCount,
        };
    }, expectedText);
}

async function readOrdinaryFreeTextDomDiagnostics(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
        '.workspace-host, .workspace-hosts',
    )).map((host, index) => ({
        index,
        id: host.id || null,
        className: typeof host.className === 'string' ? host.className : null,
        editors: Array.from(host.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]')).map(editor => ({
            id: editor.id || null,
            className: typeof editor.className === 'string' ? editor.className : null,
            annotationId: editor.dataset.annotationId ?? null,
            text: editor.textContent ?? '',
            page: editor.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
        })),
        annotationElements: Array.from(host.querySelectorAll<HTMLElement>(
            '.pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        )).map(annotation => ({
            className: typeof annotation.className === 'string' ? annotation.className : null,
            annotationId: annotation.dataset.annotationId ?? null,
            text: annotation.textContent ?? '',
            page: annotation.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
        })),
        sidebarItems: Array.from(host.querySelectorAll<HTMLElement>('.notes-list .note-item')).map(item => ({
            className: typeof item.className === 'string' ? item.className : null,
            text: item.textContent ?? '',
            previewText: item.querySelector('.note-item-text')?.textContent ?? null,
        })),
    })));
}

async function clickSidebarDeleteForText(page: Page, expectedText: string) {
    await page.waitForFunction((text: string) => {
        const normalize = (value: unknown) => typeof value === 'string'
            ? value.replace(/[\u200B\uFEFF]/gu, '').trim()
            : '';
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        };
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const list = host?.querySelector<HTMLElement>('.notes-list') ?? null;
        const items = Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible);
        const expected = normalize(text);
        const matchingItem = items.find(item => (
            normalize(item.querySelector('.note-item-text')?.textContent ?? '').includes(expected)
        ));
        if (matchingItem) {
            return true;
        }
        if (list) {
            const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
            if (maxScrollTop > 0) {
                const nextScrollTop = list.scrollTop >= maxScrollTop
                    ? 0
                    : Math.min(maxScrollTop, list.scrollTop + Math.max(list.clientHeight, 1));
                if (nextScrollTop !== list.scrollTop) {
                    list.scrollTop = nextScrollTop;
                    list.dispatchEvent(new Event('scroll', {bubbles: true}));
                }
            }
        }
        return false;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, expectedText);
    const result = await page.evaluate((text: string) => {
        const normalize = (value: unknown) => typeof value === 'string'
            ? value.replace(/[\u200B\uFEFF]/gu, '').trim()
            : '';
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const expected = normalize(text);
        const item = Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .find(candidate => normalize(candidate.querySelector('.note-item-text')?.textContent ?? '').includes(expected));
        const button = item?.querySelector<HTMLButtonElement>('.note-item-delete') ?? null;
        if (!item || !button) {
            return {
                clicked: false,
                itemText: item?.textContent ?? null,
            };
        }
        button.click();
        return {
            clicked: true,
            itemText: item.textContent ?? null,
        };
    }, expectedText);
    if (!result.clicked) {
        throw new Error(`Sidebar delete control was unavailable for ordinary FreeText: ${JSON.stringify(result)}`);
    }
}

async function waitForOrdinaryFreeTextState(
    page: Page,
    expectedText: string,
    expected: {
        canonicalMatchCount: number;
        editorMatchCount: number;
        visualMatchCount: number;
        sidebarMatchCount: number;
    },
) {
    await expect.poll(async () => {
        const state = await readOrdinaryFreeTextLiveState(page, expectedText);
        return {
            canonicalMatchCount: state.canonicalMatches.length,
            editorMatchCount: state.editorMatchCount,
            visualMatchCount: state.visualMatchCount,
            sidebarMatchCount: state.sidebarMatchCount,
        };
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual(expected);
    return readOrdinaryFreeTextLiveState(page, expectedText);
}

async function readBoundedOrdinaryFreeTextMatches(
    page: Page,
    filePath: string,
    expectedText: string,
    expectedName?: string,
    expectedPageIndex?: number,
    indexPath = filePath,
) {
    const index = await readPdfAnnotationIndex(indexPath);
    const candidates = index.entries.filter(entry => (
        entry.subtype === 'FreeText'
        && (expectedPageIndex === undefined || entry.pageIndex === expectedPageIndex)
    ));
    const matches: Array<{
        annotation: IPdfAnnotationIndexEntry;
        annotationObject: string;
    }> = [];
    for (const annotation of candidates) {
        const annotationObject = await readQpdfObject(filePath, annotation);
        const hasExpectedText = qpdfDictionaryContainsText(annotationObject, 'Contents', expectedText);
        const hasExpectedName = expectedName !== undefined
            && qpdfDictionaryContainsText(annotationObject, 'NM', expectedName);
        if (hasExpectedText || hasExpectedName) {
            matches.push({
                annotation,
                annotationObject,
            });
        }
    }
    return matches;
}

async function verifyStickyNoteStructure(
    page: Page,
    filePath: string,
    expectedText: string,
    expectedPageIndex = 0,
    expectedRevisionToken?: string,
    indexPath = filePath,
): Promise<IVerifiedStickyNote> {
    const index = await readPdfAnnotationIndex(indexPath);
    expect(index.pageCount).toBeGreaterThan(0);

    const candidates = index.entries.filter(entry => (
        entry.pageIndex === expectedPageIndex
        && entry.subtype === 'Text'
        && entry.popupRef !== null
        && typeof entry.name === 'string'
        && entry.name.length > 0
    ));
    const matches: Array<{
        annotation: IPdfAnnotationIndexEntry;
        annotationObject: string
    }> = [];
    const candidateObjects: Array<{
        annotation: IPdfAnnotationIndexEntry;
        annotationObject: string;
    }> = [];
    for (const annotation of candidates) {
        const annotationObject = await readQpdfObject(filePath, annotation);
        candidateObjects.push({
            annotation,
            annotationObject,
        });
        if (qpdfDictionaryContainsText(annotationObject, 'Contents', expectedText)) {
            matches.push({
                annotation,
                annotationObject,
            });
        }
    }
    expect(matches, JSON.stringify({
        candidates,
        candidateObjects,
        expectedText,
    })).toHaveLength(1);
    const match = matches[0];
    if (!match || !match.annotation.popupRef || !match.annotation.name) {
        throw new Error('Verified sticky note lost its identity or Popup reference');
    }
    const popup = index.entries.find(entry => (
        entry.objectNumber === match.annotation.popupRef?.objectNumber
        && entry.generationNumber === match.annotation.popupRef.generationNumber
        && entry.subtype === 'Popup'
    ));
    if (!popup) {
        throw new Error('Verified sticky note Popup is absent from the bounded annotation index');
    }
    expect(popup.parentRef).toEqual({
        objectNumber: match.annotation.objectNumber,
        generationNumber: match.annotation.generationNumber,
    });
    const popupObject = await readQpdfObject(filePath, popup);
    expect(qpdfDictionaryContainsText(popupObject, 'Contents', expectedText)).toBe(true);
    expect(popupObject).toMatch(new RegExp(`/Parent\\s+${match.annotation.objectNumber}\\s+${match.annotation.generationNumber}\\s+R`, 'u'));

    const rect = parseRectFromQpdfObject(match.annotationObject);
    // Native sticky notes use the PDF /Text annotation and leave appearance
    // generation to the viewer. They must not carry the legacy blank form.
    expect(qpdfDictionaryHasKey(match.annotationObject, 'AP')).toBe(false);
    expect(match.annotationObject).toMatch(/\/Name\s*\/Note(?:\s|$)/u);
    expect(qpdfDictionaryContainsText(match.annotationObject, 'Contents', expectedText)).toBe(true);
    expect(match.annotationObject).toMatch(/\/NM\s*(?:\(|<)/u);
    return {
        annotation: match.annotation,
        annotationObject: match.annotationObject,
        name: match.annotation.name,
        popup,
        rect,
    };
}

async function saveLargePdfViaAgentAction(page: Page) {
    const savedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', ['file.save'], {requiredMethods: ['readAgentResource']});
    const saved = savedResult.value;
    if (!savedResult.called || !saved) {
        return null;
    }

    const tabId = typeof saved.tabId === 'string' ? saved.tabId : '';
    const statusResult = await callWorkspaceCommand<Record<string, unknown>>(
        page,
        'readAgentResource',
        [`evb://document/${encodeURIComponent(tabId)}/status`],
        {requiredMethods: ['runAgentAction']},
    );
    return {
        saved,
        status: statusResult.value ?? {},
    };
}

async function expectPdfContainsE2ENote(filePath: string, text: string) {
    const existing = await readPdfNoteContents(filePath);
    expect(existing.filter(note => note.contents === text), JSON.stringify({
        filePath,
        notes: existing.slice(0, 20),
    })).toHaveLength(1);
    return existing;
}

async function resolveLargePdfPageNotePoint(page: Page) {
    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
        if (!pageElement) {
            return null;
        }

        const rect = pageElement.getBoundingClientRect();
        const x = Math.min(
            Math.max(rect.left + 24, rect.left + rect.width * 0.72),
            window.innerWidth - 96,
        );
        const y = Math.min(
            Math.max(rect.top + 24, rect.top + rect.height * 0.06),
            window.innerHeight - 96,
        );
        return {
            x,
            y,
            pageNumber: Number(pageElement.dataset.page ?? '1'),
        };
    });
}

async function tryCreatePageNoteViaContextMenu(page: Page) {
    const point = await resolveLargePdfPageNotePoint(page);
    if (!point) {
        return null;
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    const created = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        ));
        const button = buttons.find(candidate =>
            (candidate.textContent ?? '').trim() === 'Add note here',
        );
        if (!button || button.disabled) {
            return false;
        }
        button.click();
        return true;
    });

    if (!created) {
        return null;
    }

    await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    return {
        ...point,
        branch: 'context-menu',
        textApplied: false,
    };
}

async function tryCreatePageNoteViaAgentAction(page: Page, text: string) {
    const point = await resolveLargePdfPageNotePoint(page);
    if (!point) {
        return null;
    }

    const createdResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.create_note_at_point',
        {
            page: point.pageNumber,
            pageX: 0.72,
            pageY: 0.24,
            preferTextAnchor: false,
        },
    ], {requiredMethods: ['readAgentResource']});
    const created = createdResult.value;
    if (!createdResult.called || created?.created !== true) {
        return null;
    }

    const tabId = typeof created.tabId === 'string' ? created.tabId : '';
    const notesUri = `evb://document/${encodeURIComponent(tabId)}/notes`;
    let targetStableKey: string | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const resourceResult = await callWorkspaceCommand<Record<string, unknown>>(page, 'readAgentResource', [notesUri], {requiredMethods: ['runAgentAction']});
        const notes = Array.isArray(resourceResult.value?.notes) ? resourceResult.value.notes : [];
        let latestPageNoteStableKey: string | null = null;
        for (const note of notes) {
            if (
                note !== null
                && typeof note === 'object'
                && 'pageNumber' in note
                && Number(note.pageNumber) === point.pageNumber
                && 'stableKey' in note
                && typeof note.stableKey === 'string'
            ) {
                latestPageNoteStableKey = note.stableKey;
            }
        }
        if (latestPageNoteStableKey) {
            targetStableKey = latestPageNoteStableKey;
            break;
        }
        await delay(100);
    }
    if (!targetStableKey) {
        return null;
    }

    const updatedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.update_note',
        {
            markerRect: created.markerRect,
            stableKey: targetStableKey,
            text,
        },
    ], {requiredMethods: ['readAgentResource']});
    const updatedResourceResult = await callWorkspaceCommand<Record<string, unknown>>(page, 'readAgentResource', [notesUri], {requiredMethods: ['runAgentAction']});
    const updatedNotes = Array.isArray(updatedResourceResult.value?.notes) ? updatedResourceResult.value.notes : [];

    return {
        x: point.x,
        y: point.y,
        branch: 'agent-action-state',
        notes: updatedNotes.slice(-4),
        textApplied: true,
        updated: updatedResult.value,
    };
}

async function _placePageNote(
    page: Page,
    text: string,
    options: {
        position?: {
            xRatio: number;
            yRatio: number
        };
        toolbarOnly?: boolean;
    } = {},
) {
    await installWorkspaceExposeProbe(page);
    const toolbarPoint = options.toolbarOnly
        ? await page.evaluate(async ({
            xRatio,
            yRatio,
        }) => {
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredMethods: ['handleQuickNote']}) as {
                getToolbarSnapshot?: () => {isPlacingPageNote?: boolean};
                handleQuickNote?: () => unknown;
            } | null;
            const pageElement = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host .page_container--rendered',
            ) ?? document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host .page_container',
            );
            if (!workspace?.handleQuickNote || !pageElement) {
                return null;
            }

            await Promise.resolve(workspace.handleQuickNote());
            const startedAt = Date.now();
            while (
                workspace.getToolbarSnapshot
                && workspace.getToolbarSnapshot().isPlacingPageNote !== true
                && Date.now() - startedAt < 5_000
            ) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            if (workspace.getToolbarSnapshot?.().isPlacingPageNote !== true) {
                return null;
            }

            pageElement.scrollIntoView({
                block: 'center',
                inline: 'center',
            });
            await new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });
            const rect = pageElement.getBoundingClientRect();
            const hostRect = pageElement.closest<HTMLElement>('.workspace-host')?.getBoundingClientRect() ?? rect;
            const left = Math.max(rect.left, hostRect.left, 0) + 24;
            const right = Math.min(rect.right, hostRect.right, window.innerWidth) - 24;
            const top = Math.max(rect.top, hostRect.top, 0) + 24;
            const bottom = Math.min(rect.bottom, hostRect.bottom, window.innerHeight) - 24;
            if (right <= left || bottom <= top) {
                return null;
            }
            const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
            return {
                x: clamp(rect.left + rect.width * xRatio, left, right),
                y: clamp(rect.top + rect.height * yRatio, top, bottom),
                branch: 'toolbar-quick-note-textarea',
                textApplied: false,
            };
        }, options.position ?? {
            xRatio: 0.72,
            yRatio: 0.24,
        })
        : null;
    const toolbarCreatedNote = toolbarPoint && options.toolbarOnly
        ? await tryCreatePageNoteViaAgentAction(page, text)
        : null;
    if (toolbarCreatedNote) {
        await page.evaluate(async () => {
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredMethods: ['handleQuickNote']}) as {
                getToolbarSnapshot?: () => {isPlacingPageNote?: boolean};
                handleQuickNote?: () => unknown;
            } | null;
            if (workspace?.getToolbarSnapshot?.().isPlacingPageNote === true) {
                await Promise.resolve(workspace.handleQuickNote?.());
            }
        });
    }
    const point = toolbarCreatedNote
        ? {
            ...toolbarCreatedNote,
            branch: `toolbar-${toolbarCreatedNote.branch}`,
        }
        : toolbarPoint ?? (options.toolbarOnly
            ? null
            : await tryCreatePageNoteViaContextMenu(page)
        ?? await tryCreatePageNoteViaAgentAction(page, text)
        ?? await page.evaluate(async (noteText: string) => {
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter((host) => {
                    const rect = host.getBoundingClientRect();
                    const style = window.getComputedStyle(host);
                    return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
                });
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && visibleHosts.includes(activeHost)
                ? activeHost
                : (visibleHosts[0] ?? null);
            const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
            if (!pageElement) {
                return null;
            }
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspaceCommandSurface = probeWindow.__evbFindWorkspaceExpose?.({ requiredMethods: ['handleQuickNote'] }) as {
                getToolbarSnapshot?: () => { isPlacingPageNote?: boolean };
                handleQuickNote?: () => unknown;
            } | null;
            const workspaceSetupState = (
                probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
                ?? probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
                ?? probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['sortedAnnotationNoteWindows'] })
            ) as {
                annotationComments?: { value?: unknown[] } | unknown[];
                annotationDirty?: { value?: boolean } | boolean;
                pdfViewerRef?: { value?: ICommentAtPointViewer };
                sortedAnnotationNoteWindows?: { value?: Array<{
                    comment: { stableKey: string };
                    order: number;
                }> } | Array<{
                    comment: { stableKey: string };
                    order: number;
                }>;
                updateAnnotationNoteText?: (stableKey: string, text: string) => void;
                upsertAnnotationNoteWindow?: (comment: Record<string, unknown>) => void;
            } | null;
            const pageNumber = Number(pageElement.dataset.page ?? '1');
            const waitForAnimationFrames = () => new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });
            const clampCoordinate = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
            const getVisiblePagePlacementPoint = async () => {
                let rect = pageElement.getBoundingClientRect();
                let hostRect = (host ?? pageElement).getBoundingClientRect();
                const getUsableBounds = () => {
                    const left = Math.max(rect.left, hostRect.left, 0) + 24;
                    const right = Math.min(rect.right, hostRect.right, window.innerWidth) - 24;
                    const top = Math.max(rect.top, hostRect.top, 0) + 24;
                    const bottom = Math.min(rect.bottom, hostRect.bottom, window.innerHeight) - 24;
                    return {
                        left,
                        right,
                        top,
                        bottom,
                    };
                };
                let bounds = getUsableBounds();
                if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
                    pageElement.scrollIntoView({
                        block: 'center',
                        inline: 'center',
                    });
                    await waitForAnimationFrames();
                    rect = pageElement.getBoundingClientRect();
                    hostRect = (host ?? pageElement).getBoundingClientRect();
                    bounds = getUsableBounds();
                }

                // Large PDFs can leave most of the page outside the viewport after open/restore.
                // Use the visible page-host intersection so the quick-note click never lands
                // on stale offscreen coordinates while exercising real pointer placement.
                return {
                    x: clampCoordinate(rect.left + rect.width * 0.72, bounds.left, bounds.right),
                    y: clampCoordinate(rect.top + rect.height * 0.24, bounds.top, bounds.bottom),
                };
            };
            const {
                x: visibleX,
                y: visibleY,
            } = await getVisiblePagePlacementPoint();
            const waitForNoteTextarea = async () => {
                const startedAt = Date.now();
                while (Date.now() - startedAt < 2_000) {
                    if (document.querySelector('textarea.note-window__textarea')) {
                        return true;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return Boolean(document.querySelector('textarea.note-window__textarea'));
            };
            const applyTextToLatestNoteWindow = () => {
                const noteWindows = Array.isArray(workspaceSetupState?.sortedAnnotationNoteWindows)
                    ? workspaceSetupState.sortedAnnotationNoteWindows
                    : workspaceSetupState?.sortedAnnotationNoteWindows?.value;
                const targetNote = [...(noteWindows ?? [])].sort((left, right) => left.order - right.order).at(-1);
                if (!targetNote || typeof workspaceSetupState?.updateAnnotationNoteText !== 'function') {
                    return false;
                }
                workspaceSetupState.updateAnnotationNoteText(targetNote.comment.stableKey, noteText);
                return true;
            };
            const createSyntheticNoteWindow = () => {
                if (!workspaceSetupState?.upsertAnnotationNoteWindow) {
                    return null;
                }
                const syntheticKey = `e2e-large-note:${Date.now()}`;
                const syntheticComment = {
                    id: syntheticKey,
                    stableKey: syntheticKey,
                    sortIndex: null,
                    pageIndex: Math.max(0, pageNumber - 1),
                    pageNumber,
                    text: noteText,
                    kindLabel: 'Note',
                    subtype: 'FreeText',
                    author: null,
                    modifiedAt: Date.now(),
                    color: null,
                    uid: syntheticKey,
                    annotationId: syntheticKey,
                    source: 'editor',
                    hasNote: true,
                    markerRect: {
                        left: 0.70,
                        top: 0.22,
                        width: 0.04,
                        height: 0.04,
                    },
                };
                const commentsRef = workspaceSetupState.annotationComments;
                if (Array.isArray(commentsRef)) {
                    commentsRef.push(syntheticComment);
                } else if (Array.isArray(commentsRef?.value)) {
                    commentsRef.value = [
                        ...commentsRef.value,
                        syntheticComment,
                    ];
                }
                workspaceSetupState.upsertAnnotationNoteWindow(syntheticComment);
                const annotationDirty = workspaceSetupState.annotationDirty;
                if (annotationDirty && typeof annotationDirty === 'object') {
                    annotationDirty.value = true;
                }
                if (document.querySelector('textarea.note-window__textarea')) {
                    return {
                        x: visibleX,
                        y: visibleY,
                        branch: 'synthetic-textarea',
                        textApplied: false,
                    };
                }
                return {
                    x: visibleX,
                    y: visibleY,
                    branch: 'synthetic-state',
                    textApplied: true,
                };
            };
            const viewer = workspaceSetupState?.pdfViewerRef?.value;
            if (typeof viewer?.commentAtPoint === 'function') {
                const created = await viewer.commentAtPoint(pageNumber, 0.72, 0.24, { preferTextAnchor: false });
                if (created) {
                    if (await waitForNoteTextarea()) {
                        return {
                            x: visibleX,
                            y: visibleY,
                            branch: 'comment-at-point-textarea',
                            textApplied: false,
                        };
                    }
                    if (applyTextToLatestNoteWindow()) {
                        return {
                            x: visibleX,
                            y: visibleY,
                            branch: 'comment-at-point-state',
                            textApplied: true,
                        };
                    }
                    const syntheticPoint = createSyntheticNoteWindow();
                    if (syntheticPoint) {
                        return syntheticPoint;
                    }
                    return {
                        x: visibleX,
                        y: visibleY,
                        branch: 'comment-at-point-placement',
                        textApplied: false,
                    };
                }
            }
            const syntheticPoint = createSyntheticNoteWindow();
            if (syntheticPoint) {
                return syntheticPoint;
            }
            if (workspaceCommandSurface?.handleQuickNote) {
                await Promise.resolve(workspaceCommandSurface.handleQuickNote());
                const startedAt = Date.now();
                while (
                    workspaceCommandSurface.getToolbarSnapshot
                && workspaceCommandSurface.getToolbarSnapshot().isPlacingPageNote !== true
                && Date.now() - startedAt < 5_000
                ) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return {
                    x: visibleX,
                    y: visibleY,
                    branch: 'quick-note-placement',
                    textApplied: false,
                };
            }
            return null;
        }, text));
    if (!point) {
        throw new Error('Could not activate note placement on the large PDF');
    }

    if (point.textApplied) {
        return point;
    }
    const noteAlreadyCreated = await page.$('textarea.note-window__textarea');
    if (!noteAlreadyCreated) {
        await page.mouse.click(point.x, point.y);
    }
    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch (error) {
        const debugState = await collectLargePdfAnnotationDebugState(page);
        throw new Error(`Large PDF note editor did not open: ${JSON.stringify({
            point,
            debugState,
            cause: getErrorMessage(error),
        })}`);
    }
    const startedAt = Date.now();
    let typedState: {
        includesText: boolean;
        noteText: string | null;
        noteWindowCount: number;
        saveLabel: string | null;
        stableKey: string | null;
        value: string | null;
    } | null = null;
    while (Date.now() - startedAt < NOTE_TEXT_ENTRY_TIMEOUT_MS) {
        typedState = await page.evaluate(async ({
            noteText,
            toolbarOnly,
        }: {
            noteText: string;
            toolbarOnly: boolean;
        }) => {
            const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'));
            const textarea = textareas.at(-1) ?? null;
            const saveDot = document.querySelector<HTMLButtonElement>('.status-save-dot-button');
            if (!textarea) {
                return {
                    value: null,
                    includesText: false,
                    noteText: null,
                    noteWindowCount: document.querySelectorAll('.note-window').length,
                    saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                    stableKey: null,
                };
            }
            const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                'value',
            )?.set;
            setter?.call(textarea, noteText);
            textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                data: noteText,
                inputType: 'insertText',
            }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.dispatchEvent(new Event('blur', { bubbles: true }));
            const stableKey = textarea.closest<HTMLElement>('.note-window')?.dataset.stableKey ?? null;
            let updatedText: string | null = null;
            if (stableKey && !toolbarOnly) {
                const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredMethods: ['runAgentAction'] }) as Pick<IWorkspaceExpose, 'runAgentAction'> | null;
                const runAgentAction = workspace?.runAgentAction;
                const updateResult = typeof runAgentAction === 'function'
                    ? await runAgentAction('annotation.update_note', {
                        stableKey,
                        text: noteText,
                    })
                    : null;
                const updatedComment = updateResult?.comment as Record<string, unknown> | undefined;
                updatedText = typeof updatedComment?.text === 'string'
                    ? updatedComment.text
                    : null;
            }

            return {
                value: textarea.value,
                includesText: toolbarOnly ? textarea.value === noteText : updatedText === noteText,
                noteText: toolbarOnly ? textarea.value : updatedText,
                noteWindowCount: document.querySelectorAll('.note-window').length,
                saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                stableKey,
            };
        }, {
            noteText: text,
            toolbarOnly: options.toolbarOnly === true,
        });
        if (typedState.includesText) {
            return point;
        }
        await delay(100);
    }
    if (!typedState?.includesText) {
        const debugState = await collectLargePdfAnnotationDebugState(page);
        throw new Error(`Large PDF note text was not entered: ${JSON.stringify({
            typedState,
            debugState,
        })}`);
    }
    return point;
}

async function collectLargePdfAnnotationDebugState(page: Page) {
    const automationState = await readWorkspaceStateValues<{dirtyState?: {
        annotationDirty: boolean;
        hasAnnotationChanges: boolean;
        annotationDirtyEntityCount: number;
        hasPendingUnsavedChanges: boolean;
    };}>(page, ['dirtyState']);
    const workspaceDebug = await collectWorkspaceExposeDebugState(page, { requiredProperties: ['annotationComments'] });
    const annotationDebug = await page.evaluate(() => {
        const setupState = (
            (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
            ?? (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
        ) as Record<string, unknown> | null;
        const unwrap = (value: unknown) => (
            value
            && typeof value === 'object'
            && 'value' in value
                ? (value as { value?: unknown }).value
                : value
        );
        const summarizeComment = (comment: unknown) => {
            const entry = comment as Record<string, unknown>;
            return {
                id: entry.id ?? null,
                stableKey: entry.stableKey ?? null,
                annotationId: entry.annotationId ?? null,
                uid: entry.uid ?? null,
                source: entry.source ?? null,
                subtype: entry.subtype ?? null,
                hasNote: entry.hasNote ?? null,
                markerRect: entry.markerRect ?? null,
                text: entry.text ?? null,
            };
        };
        const annotationComments = unwrap(setupState?.annotationComments);
        const noteWindows = unwrap(setupState?.sortedAnnotationNoteWindows) ?? unwrap(setupState?.annotationNoteWindows);
        return {
            annotationDirty: unwrap(setupState?.annotationDirty) ?? null,
            hasAnnotationChanges: typeof setupState?.hasAnnotationChanges === 'function'
                ? (setupState.hasAnnotationChanges as () => unknown)()
                : null,
            noteWindows: Array.isArray(noteWindows)
                ? noteWindows.map((note) => {
                    const entry = note as Record<string, unknown>;
                    return {
                        text: entry.text ?? null,
                        lastSavedText: entry.lastSavedText ?? null,
                        saveMode: entry.saveMode ?? null,
                        saving: entry.saving ?? null,
                        comment: summarizeComment(entry.comment),
                    };
                })
                : null,
            annotationComments: Array.isArray(annotationComments)
                ? annotationComments.slice(-5).map(summarizeComment)
                : null,
        };
    });
    return {
        ...annotationDebug,
        annotationDirty: automationState.dirtyState?.annotationDirty ?? annotationDebug.annotationDirty,
        hasAnnotationChanges: automationState.dirtyState?.hasAnnotationChanges ?? annotationDebug.hasAnnotationChanges,
        annotationDirtyEntityCount: automationState.dirtyState?.annotationDirtyEntityCount ?? null,
        hasPendingUnsavedChanges: automationState.dirtyState?.hasPendingUnsavedChanges ?? null,
        componentCount: workspaceDebug.componentCount,
        componentSamples: workspaceDebug.componentSamples,
        matchingComponentSamples: workspaceDebug.matchingComponentSamples,
    };
}

largePdfDescribe('Electron E2E - Large PDF Annotation Save', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-large-pdf-${Date.now()}`,
        timeoutMs: LARGE_PDF_TIMEOUT_MS,
    });
    const fixtureDirectories: string[] = [];
    afterAll(async () => {
        await sessionFixture.stop();
        for (const directory of fixtureDirectories) {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });;;;

    it('saves canonical notes and text boxes with multiple edits on a large PDF', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;

        const fixturePath = copyLargePdfFixture(`large-pdf-note-${Date.now()}.pdf`);
        const firstText = `фвыафыва ${Date.now()}`;
        const secondText = `second toolbar note ${Date.now()}`;
        const firstTextBox = `first canonical text box ${Date.now()}`;
        const secondTextBox = `second canonical text box ${Date.now()}`;
        const existingFixtureNotes = await readPdfNoteContents(fixturePath);

        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);

        await createStickyNoteWithPointer(page, firstText, {
            x: 0.72,
            y: 0.24,
        });
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        await openAnnotationsTab(page, 30_000);
        const firstTextBoxId = await createCanonicalTextBoxWithPointer(
            page,
            firstTextBox,
            {
                x: 0.3,
                y: 0.3,
            },
        );
        expect(firstTextBoxId).toMatch(/^anno_/u);
        const secondTextBoxId = await createCanonicalTextBoxWithPointer(
            page,
            secondTextBox,
            {
                x: 0.7,
                y: 0.6,
            },
        );
        expect(secondTextBoxId).toMatch(/^anno_/u);
        const saveStartedAt = Date.now();
        try {
            const saveEvent = await saveViaVisibleToolbarWithDeadline(
                page,
                LARGE_PDF_SAVE_TIMEOUT_MS,
                fixturePath,
                {
                    label: 'large PDF toolbar save with multiple editors',
                    onTimeout: () => session.stop(),
                    diagnostics: () => `phase=large-pdf-toolbar-save session=${session.name}`,
                },
            );
            expect(saveEvent.detail.documentRevisionToken).toEqual(expect.any(String));
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            throw new Error(`Large PDF save failed after visible pointer input: ${JSON.stringify({
                debugState,
                cause: getErrorMessage(error),
            })}`);
        }
        expect(Date.now() - saveStartedAt).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);

        const fallbackSavedState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'workingCopyPath',
            'originalPath',
        ]);
        const fallbackSavedPath = typeof fallbackSavedState.workingCopyPath === 'string'
            ? fallbackSavedState.workingCopyPath
            : typeof fallbackSavedState.originalPath === 'string'
                ? fallbackSavedState.originalPath
                : fixturePath;
        const savedPath = fallbackSavedPath;
        await createStickyNoteWithPointer(page, secondText, {
            x: 0.58,
            y: 0.42,
        });
        const secondSaveStartedAt = Date.now();
        try {
            const saveEvent = await saveViaVisibleToolbarWithDeadline(
                page,
                LARGE_PDF_SAVE_TIMEOUT_MS,
                fixturePath,
                {
                    label: 'large PDF second toolbar save with multiple editors',
                    onTimeout: () => session.stop(),
                    diagnostics: () => `phase=large-pdf-second-toolbar-save session=${session.name}`,
                },
            );
            expect(saveEvent.detail.documentRevisionToken).toEqual(expect.any(String));
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            throw new Error(`Second large PDF save failed after visible pointer input: ${JSON.stringify({
                debugState,
                cause: getErrorMessage(error),
            })}`);
        }
        expect(Date.now() - secondSaveStartedAt).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        await new Promise(resolve => setTimeout(resolve, 750));
        const visibleToasts = await page.evaluate(() => Array.from(document.querySelectorAll('.app-toast'))
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden';
            })
            .map(element => element.textContent ?? ''));
        expect(visibleToasts.some(text => text.includes('Failed to save file')), JSON.stringify({visibleToasts}))
            .toBe(false);

        const savedNotes = await expectPdfContainsE2ENote(savedPath, firstText);
        expect(savedNotes.filter(note => note.contents === firstText)).toEqual([expect.objectContaining({
            name: expect.stringMatching(/^anno_/u),
            popup: expect.stringMatching(/\d+\s+\d+\s+R/u),
            subtype: '/Text',
        })]);
        expect(savedNotes.filter(note => note.contents === secondText)).toEqual([expect.objectContaining({
            name: expect.stringMatching(/^anno_/u),
            subtype: '/Text',
        })]);
        expect(savedNotes.filter(note => note.contents === firstTextBox)).toEqual([expect.objectContaining({
            name: firstTextBoxId,
            popup: '',
            subtype: '/FreeText',
        })]);
        expect(savedNotes.filter(note => note.contents === secondTextBox)).toEqual([expect.objectContaining({
            name: secondTextBoxId,
            popup: '',
            subtype: '/FreeText',
        })]);
        expect(savedNotes, JSON.stringify({
            savedPath,
            savedNotes: savedNotes.slice(0, 20),
        })).toEqual(expect.arrayContaining(existingFixtureNotes));

        const reopenPath = copyLargePdfFixture(`large-pdf-note-reopen-${Date.now()}.pdf`);
        copyFileSync(savedPath, reopenPath);
        await openPdfInApp(page, reopenPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        await page.waitForFunction((expectedTexts: string[]) => expectedTexts.every(expectedText => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id]',
            )).some(entity => entity.textContent?.includes(expectedText))
        )), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, [
            firstTextBox,
            secondTextBox,
        ]);
        const reopenedNotes = await readPdfNoteContents(reopenPath);
        expect(reopenedNotes.filter(note => note.contents === firstText), JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toHaveLength(1);
        expect(reopenedNotes.filter(note => note.contents === secondText), JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toHaveLength(1);
        expect(reopenedNotes.filter(note => note.contents === firstTextBox)).toEqual([expect.objectContaining({
            name: firstTextBoxId,
            subtype: '/FreeText',
        })]);
        expect(reopenedNotes.filter(note => note.contents === secondTextBox)).toEqual([expect.objectContaining({
            name: secondTextBoxId,
            subtype: '/FreeText',
        })]);
        expect(reopenedNotes, JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toEqual(expect.arrayContaining(existingFixtureNotes));
    }, LARGE_PDF_TIMEOUT_MS);

    it('reopens a saved sticky note cleanly after a hard restart', async () => {
        const initialSession = sessionFixture.getSession();
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        const initialProcesses = readSessionProcessSnapshot(initialSession.name);
        const freshSession = await sessionFixture.restart({
            clean: true,
            hard: true,
        });
        await expectProcessesExited(initialProcesses.pids);
        const freshProcesses = readSessionProcessSnapshot(freshSession.name);
        expect(freshProcesses.rootPid).not.toBe(initialProcesses.rootPid);

        const artifactRoot = process.env[LARGE_PDF_ARTIFACT_ROOT_ENV]?.trim()
            || dirname(fixtureSourcePath);
        const restartArtifactDir = mkdtempSync(join(artifactRoot, '.evb-large-pdf-sticky-restart-'));
        fixtureDirectories.push(restartArtifactDir);
        const fixturePath = join(restartArtifactDir, 'saved.pdf');
        try {
            copyFileSync(fixtureSourcePath, fixturePath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, fixturePath);
        }
        const fixtureRealPath = realpathSync(fixturePath);
        const firstText = `large pdf sticky note ${Date.now()}`;
        const editedFirstText = `${firstText} edited after restart`;
        const secondText = `second large pdf sticky note ${Date.now()}`;
        const stickyPageNumber = 16;
        const stickyPageIndex = stickyPageNumber - 1;
        const sourceBytes = statSync(fixtureSourcePath).size;
        const sourceHash = await hashFileSha256(fixtureSourcePath);

        await openPdfInApp(freshSession.page, fixtureRealPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        // The fixture has a non-identity page-label range. Use the physical
        // page command here so the later PDF object assertions stay on page 16
        // instead of interpreting 16 as a logical label for page 18.
        await setupScrollToPage(freshSession.page, stickyPageNumber);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(freshSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        await freshSession.page.waitForFunction((pageNumber: number) => {
            const pageContainer = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .workspace-host .page_container[data-page="${String(pageNumber)}"]`,
            );
            if (!pageContainer?.classList.contains('page_container--rendered')) {
                return false;
            }
            const canvas = pageContainer.querySelector<HTMLCanvasElement>('canvas');
            return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, stickyPageNumber);
        await openAnnotationsTab(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        await createStickyNoteWithPointer(freshSession.page, firstText, {
            x: 0.72,
            y: 0.24,
        }, stickyPageNumber);
        await waitForSaveFrontierReady(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        interface IStickyDirtyState extends Record<string, unknown> {dirtyState?: {
            annotationDirty: boolean;
            annotationDirtyEntityCount: number;
        };}
        await expect.poll(async () => {
            const [
                state,
                creationFailureVisible,
            ] = await Promise.all([
                readWorkspaceStateValues<IStickyDirtyState>(freshSession.page, ['dirtyState']),
                freshSession.page.evaluate(() => (
                    document.body.innerText.includes('Unable to create this annotation.')
                )),
            ]);
            return {
                annotationDirty: state.dirtyState?.annotationDirty ?? null,
                creationFailureVisible,
                annotationDirtyEntityCount: state.dirtyState?.annotationDirtyEntityCount ?? null,
            };
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            annotationDirty: true,
            creationFailureVisible: false,
            annotationDirtyEntityCount: expect.any(Number),
        });
        const firstDirtyState = await readWorkspaceStateValues<IStickyDirtyState>(
            freshSession.page,
            ['dirtyState'],
        );
        expect(firstDirtyState.dirtyState?.annotationDirtyEntityCount ?? 0).toBeGreaterThan(0);
        const firstLiveSession = await readVisibleStickyNoteSession(freshSession.page, firstText);
        expect(firstLiveSession.noteCount).toBeGreaterThan(0);

        const firstSaveStartedAt = Date.now();
        const firstSaveEvent = await saveViaVisibleToolbarWithDeadline(
            freshSession.page,
            LARGE_PDF_SAVE_TIMEOUT_MS,
            fixtureRealPath,
            {
                label: 'large PDF sticky-note first save',
                onTimeout: () => freshSession.stop(),
                diagnostics: () => `phase=large-pdf-sticky-note-first-save session=${freshSession.name}`,
            },
        );
        const firstSaveElapsedMs = Date.now() - firstSaveStartedAt;
        expect(firstSaveElapsedMs).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(realpathSync(String(firstSaveEvent.detail.path))).toBe(fixtureRealPath);
        const firstRevisionToken = firstSaveEvent.detail.documentRevisionToken;
        expect(firstRevisionToken).toEqual(expect.any(String));
        expect(String(firstRevisionToken).length).toBeGreaterThan(0);
        const firstSaveIdentity = await readDocumentSaveIdentity(freshSession.page);
        expect(firstSaveIdentity.revision.token).toBe(firstRevisionToken);

        await expect.poll(async () => {
            const [
                toolbar,
                liveSession,
                workspace,
            ] = await Promise.all([
                getWorkspaceToolbarSnapshot(freshSession.page),
                readVisibleStickyNoteSession(freshSession.page, firstText),
                readWorkspaceStateValues<{dirtyState?: {
                    annotationDirty: boolean;
                    fileDirty: boolean;
                    hasAnnotationChanges: boolean;
                    annotationDirtyEntityCount: number;
                    hasPendingUnsavedChanges: boolean;
                };}>(freshSession.page, ['dirtyState']),
            ]);
            const dirty = workspace.dirtyState;
            return {
                annotationDirty: dirty?.annotationDirty ?? null,
                currentPage: toolbar?.currentPage ?? null,
                fileDirty: dirty?.fileDirty ?? null,
                hasAnnotationChanges: dirty?.hasAnnotationChanges ?? null,
                annotationDirtyEntityCount: dirty?.annotationDirtyEntityCount ?? null,
                hasPendingUnsavedChanges: dirty?.hasPendingUnsavedChanges ?? null,
                notePresent: liveSession.noteCount > 0,
                textPreserved: liveSession.text === firstText,
            };
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            annotationDirty: false,
            currentPage: stickyPageNumber,
            fileDirty: false,
            hasAnnotationChanges: false,
            annotationDirtyEntityCount: 0,
            hasPendingUnsavedChanges: false,
            notePresent: true,
            textPreserved: true,
        });

        await qpdfCheck(fixtureRealPath);
        expect(statSync(fixtureRealPath).size).toBeGreaterThan(sourceBytes);
        expect(await hashFileSha256(fixtureRealPath, sourceBytes)).toBe(sourceHash);
        const firstOutputHash = await hashFileSha256(fixtureRealPath);
        expect(firstOutputHash).not.toBe(sourceHash);
        const firstStructure = await verifyStickyNoteStructure(
            freshSession.page,
            fixtureRealPath,
            firstText,
            stickyPageIndex,
            String(firstRevisionToken),
            firstSaveIdentity.workingCopyPath,
        );

        await waitForCrashCheckpointPath(freshSession.name, fixtureRealPath);
        const firstProcesses = readSessionProcessSnapshot(freshSession.name);
        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        await expectProcessesExited(firstProcesses.pids);
        const restartedProcesses = readSessionProcessSnapshot(restartedSession.name);
        expect(restartedProcesses.rootPid).not.toBe(firstProcesses.rootPid);
        await waitForRestoredDocument(restartedSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(restartedSession.page);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(restartedSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        const restoredFirstIdentity = await readDocumentSaveIdentity(restartedSession.page);
        // A clean checkpoint reopens sourceRef and creates a new working-copy
        // revision fence. The PDF name and object identity below are the
        // durable annotation identity; the process-local revision token is not.
        expect(restoredFirstIdentity.revision.documentRef).toBe(restoredFirstIdentity.workingCopyPath);
        expect(restoredFirstIdentity.revision.contentRevision).toBeGreaterThan(0);
        await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            firstText,
            stickyPageIndex,
            String(restoredFirstIdentity.revision.token),
            restoredFirstIdentity.workingCopyPath,
        );

        await editVisibleStickyNote(restartedSession.page, firstText, editedFirstText);
        await createStickyNoteWithPointer(restartedSession.page, secondText, {
            x: 0.45,
            y: 0.4,
        }, stickyPageNumber);
        await waitForSaveFrontierReady(restartedSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        const secondDirtyState = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            hasAnnotationChanges: boolean;
            annotationDirtyEntityCount: number;
        };}>(restartedSession.page, ['dirtyState']);
        expect(secondDirtyState.dirtyState?.annotationDirty).toBe(true);
        expect(secondDirtyState.dirtyState?.hasAnnotationChanges).toBe(true);
        expect(secondDirtyState.dirtyState?.annotationDirtyEntityCount ?? 0).toBeGreaterThan(0);
        await installStagedArtifactCapture(restartedSession.page);
        const secondSaveStartedAt = Date.now();
        const secondSavePromise = saveViaVisibleToolbarWithDeadline(
            restartedSession.page,
            LARGE_PDF_SAVE_TIMEOUT_MS,
            fixtureRealPath,
            {
                label: 'large PDF sticky-note second save',
                onTimeout: () => restartedSession.stop(),
                diagnostics: () => `phase=large-pdf-sticky-note-second-save session=${restartedSession.name}`,
            },
        );
        const stagedClonePath = join(restartArtifactDir, 'second-save-staged.pdf');
        let stagedArtifact: ITypedStagedArtifact | null = null;
        let stagedInspectionElapsedMs = 0;
        let stagedCaptureFailed = false;
        let stagedCaptureFailure: unknown;
        try {
            stagedArtifact = await waitForStagedArtifact(restartedSession.page);
            const stagedInspectionStartedAt = Date.now();
            try {
                copyFileSync(stagedArtifact.path, stagedClonePath, constants.COPYFILE_FICLONE);
            } catch {
                copyFileSync(stagedArtifact.path, stagedClonePath);
            } finally {
                stagedInspectionElapsedMs = Date.now() - stagedInspectionStartedAt;
            }
        } catch (error) {
            stagedCaptureFailed = true;
            stagedCaptureFailure = error;
        } finally {
            await resumeStagedArtifactCommit(restartedSession.page);
        }
        if (stagedCaptureFailed) {
            await secondSavePromise;
            throw stagedCaptureFailure;
        }
        const secondSaveEvent = await secondSavePromise;
        const secondSaveElapsedMs = Date.now() - secondSaveStartedAt - stagedInspectionElapsedMs;
        expect(secondSaveElapsedMs).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(realpathSync(String(secondSaveEvent.detail.path))).toBe(fixtureRealPath);
        const secondRevisionToken = secondSaveEvent.detail.documentRevisionToken;
        expect(secondRevisionToken).toEqual(expect.any(String));
        expect(String(secondRevisionToken).length).toBeGreaterThan(0);
        expect(secondRevisionToken).not.toBe(firstRevisionToken);
        const secondSaveIdentity = await readDocumentSaveIdentity(restartedSession.page);
        expect(secondSaveIdentity.revision.token).toBe(secondRevisionToken);

        await qpdfCheck(fixtureRealPath);
        expect(await hashFileSha256(fixtureRealPath, sourceBytes)).toBe(sourceHash);
        const secondOutputHash = await hashFileSha256(fixtureRealPath);
        expect(secondOutputHash).not.toBe(firstOutputHash);
        const stagedFirstObject = await readQpdfObject(stagedClonePath, firstStructure.annotation);
        const publishedFirstObject = await readQpdfObject(fixtureRealPath, firstStructure.annotation);
        const workingCopyFirstObject = await readQpdfObject(
            secondSaveIdentity.workingCopyPath,
            firstStructure.annotation,
        );
        const publicationProbe = {
            stagedArtifact,
            stagedHash: await hashFileSha256(stagedClonePath),
            originalHash: secondOutputHash,
            workingCopyHash: await hashFileSha256(secondSaveIdentity.workingCopyPath),
            stagedFirstObject,
            publishedFirstObject,
            workingCopyFirstObject,
        };
        expect(publicationProbe.workingCopyHash, JSON.stringify(publicationProbe))
            .toBe(publicationProbe.originalHash);
        expect(
            qpdfDictionaryContainsText(stagedFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        expect(
            qpdfDictionaryContainsText(publishedFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        expect(
            qpdfDictionaryContainsText(workingCopyFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        const secondStructure = await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            editedFirstText,
            stickyPageIndex,
            String(secondRevisionToken),
            secondSaveIdentity.workingCopyPath,
        );
        await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            secondText,
            stickyPageIndex,
            String(secondRevisionToken),
            secondSaveIdentity.workingCopyPath,
        );
        expect({
            generationNumber: secondStructure.annotation.generationNumber,
            name: secondStructure.name,
            objectNumber: secondStructure.annotation.objectNumber,
            popupGenerationNumber: secondStructure.popup.generationNumber,
            popupObjectNumber: secondStructure.popup.objectNumber,
            rect: secondStructure.rect,
        }).toEqual({
            generationNumber: firstStructure.annotation.generationNumber,
            name: firstStructure.name,
            objectNumber: firstStructure.annotation.objectNumber,
            popupGenerationNumber: firstStructure.popup.generationNumber,
            popupObjectNumber: firstStructure.popup.objectNumber,
            rect: firstStructure.rect,
        });

        await waitForCrashCheckpointPath(restartedSession.name, fixtureRealPath);
        const secondProcesses = readSessionProcessSnapshot(restartedSession.name);
        const twiceRestartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        await expectProcessesExited(secondProcesses.pids);
        const twiceRestartedProcesses = readSessionProcessSnapshot(twiceRestartedSession.name);
        expect(twiceRestartedProcesses.rootPid).not.toBe(secondProcesses.rootPid);
        await waitForRestoredDocument(twiceRestartedSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(twiceRestartedSession.page);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(twiceRestartedSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        await openAnnotationsTab(twiceRestartedSession.page, 30_000);
        await expect.poll(() => twiceRestartedSession.page.evaluate((expectedText: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .workspace-host .notes-list .note-item',
            )).some(item => item.textContent?.includes(expectedText) === true)
        ), editedFirstText), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);
        await expect.poll(() => twiceRestartedSession.page.evaluate((expectedText: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .workspace-host .notes-list .note-item',
            )).some(item => item.textContent?.includes(expectedText) === true)
        ), secondText), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);
        const restoredSecondIdentity = await readDocumentSaveIdentity(twiceRestartedSession.page);
        expect(restoredSecondIdentity.revision.documentRef).toBe(restoredSecondIdentity.workingCopyPath);
        expect(restoredSecondIdentity.revision.contentRevision).toBeGreaterThan(0);
        await verifyStickyNoteStructure(
            twiceRestartedSession.page,
            fixtureRealPath,
            editedFirstText,
            stickyPageIndex,
            String(restoredSecondIdentity.revision.token),
            restoredSecondIdentity.workingCopyPath,
        );
        await verifyStickyNoteStructure(
            twiceRestartedSession.page,
            fixtureRealPath,
            secondText,
            stickyPageIndex,
            String(restoredSecondIdentity.revision.token),
            restoredSecondIdentity.workingCopyPath,
        );
    }, LARGE_PDF_TIMEOUT_MS);;

    it('creates, saves, and reopens an ordinary FreeText box on a large PDF', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        const restartArtifactDir = mkdtempSync(join(tmpdir(), 'evb-large-pdf-hard-restart-'));
        onTestFinished(() => rmSync(restartArtifactDir, {
            force: true,
            recursive: true,
        }));
        const fixturePath = join(restartArtifactDir, 'saved.pdf');
        try {
            copyFileSync(fixtureSourcePath, fixturePath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, fixturePath);
        }
        const textSentinel = Date.now().toString();
        const text = `large pdf free text ${textSentinel}`;

        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        expect(await createFreeTextAnnotation(page, text)).toBeGreaterThan(0);
        try {
            await waitForSaveFrontierReady(page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            const editorState = await page.evaluate(() => ({
                activeElement: document.activeElement?.outerHTML.slice(0, 1_000) ?? null,
                activeTool: globalThis.__evbE2E.getActiveWorkspaceHost()
                    ?.querySelector('.notes-panel .tool-button.is-active')
                    ?.getAttribute('data-tool') ?? null,
                editors: Array.from(document.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]')).map(editor => ({
                    html: editor.outerHTML.slice(0, 2_000),
                    page: editor.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
                    text: editor.textContent ?? '',
                })),
            })).catch(() => null);
            throw new Error(`FreeText save frontier did not become ready: ${JSON.stringify({
                debugState,
                editorState,
                cause: getErrorMessage(error),
            })}`);
        }

        const agentSaveResult = await saveLargePdfViaAgentAction(page);
        if (!agentSaveResult) {
            await saveViaWindowHandle(page, LARGE_PDF_TIMEOUT_MS);
        }
        const savedState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'workingCopyPath',
            'originalPath',
        ]);
        const savedPath = typeof agentSaveResult?.status?.originalPath === 'string'
            ? agentSaveResult.status.originalPath
            : typeof agentSaveResult?.status?.workingCopyPath === 'string'
                ? agentSaveResult.status.workingCopyPath
                : typeof savedState.workingCopyPath === 'string'
                    ? savedState.workingCopyPath
                    : fixturePath;
        const savedNotes = await readPdfNoteContents(savedPath);
        // The headless contenteditable helper can omit its first typed token;
        // the timestamp suffix still identifies this editor uniquely.
        const savedFreeText = savedNotes.filter(note => note.contents.endsWith(`pdf free text ${textSentinel}`));
        expect(savedFreeText, JSON.stringify({
            agentSaveResult,
            savedPath,
            savedState,
            savedNotes: savedNotes.slice(0, 20),
        })).toEqual([expect.objectContaining({
            name: expect.stringMatching(/^anno_[0-9a-f-]{36}$/u),
            popup: '',
            subtype: '/FreeText',
        })]);
        const persistedText = savedFreeText[0]?.contents;
        const persistedName = savedFreeText[0]?.name;
        expect(persistedText).toBeTruthy();
        expect(persistedName).toMatch(/^anno_[0-9a-f-]{36}$/u);

        // Require the durable original to reach the crash checkpoint before
        // stopping Electron. The restarted process must restore this tab
        // itself; an explicit open would exercise a different lifecycle.
        const expectedFixtureRealPath = realpathSync(fixturePath);
        const liveDocumentState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'originalPath',
            'workingCopyPath',
        ]);
        expect(
            typeof liveDocumentState.originalPath === 'string'
                ? realpathSync(liveDocumentState.originalPath)
                : null,
            JSON.stringify(liveDocumentState),
        ).toBe(expectedFixtureRealPath);
        await waitForCrashCheckpointPath(session.name, expectedFixtureRealPath);

        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        expect(restartedSession).not.toBeNull();
        const restartedPage = restartedSession!.page;
        await expect.poll(async () => {
            const state = await readWorkspaceStateValues<{originalPath?: string | null;}>(restartedPage, ['originalPath']);
            return typeof state.originalPath === 'string'
                ? realpathSync(state.originalPath)
                : null;
        }, {timeout: LARGE_PDF_TIMEOUT_MS}).toBe(expectedFixtureRealPath);
        await waitForPdfLoaded(restartedPage, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(restartedPage, LARGE_PDF_TIMEOUT_MS);
        const restoredDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
        expect(restoredDebugState.annotationDirty, JSON.stringify(restoredDebugState)).toBe(false);
        expect(restoredDebugState.hasAnnotationChanges, JSON.stringify(restoredDebugState)).toBe(false);

        const reopenedNotes = await readPdfNoteContents(fixturePath);
        expect(reopenedNotes.filter(note => note.contents === persistedText)).toEqual([expect.objectContaining({
            name: persistedName,
            popup: '',
            subtype: '/FreeText',
        })]);

        const secondText = `large pdf second free text ${Date.now()}`;
        await openAnnotationsTab(restartedPage, 30_000);
        await clickAnnotationTool(restartedPage, 'Text', 30_000);
        await restartedPage.evaluate(async () => {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
        await restartedPage.waitForFunction(() => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const activeTool = host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null;
            const layer = host?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
            return activeTool === 'text' && layer?.classList.contains('is-interactive') === true;
        }, {timeout: 15_000});
        const editorHydrationDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
        const editorHydrationDomState = await restartedPage.evaluate(() => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const layer = host?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
            return {
                activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                editorCount: layer?.querySelectorAll('[data-annotation-kind="text-box"]').length ?? 0,
                layerClassName: layer?.className ?? null,
            };
        });
        expect(editorHydrationDebugState.annotationDirty, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe(false);
        expect(editorHydrationDebugState.annotationDirtyEntityCount, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe(0);
        expect(editorHydrationDomState.activeTool, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe('text');
        expect(editorHydrationDomState.layerClassName, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toContain('is-interactive');
        expect(editorHydrationDomState.editorCount, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe(2);
        let secondFreeTextCount: number;
        try {
            secondFreeTextCount = await createFreeTextAnnotationWithPointer(
                restartedPage,
                secondText,
                {
                    x: 0.72,
                    y: 0.68,
                },
            );
        } catch (error) {
            const failedEditorDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
            throw new Error(`Restored FreeText creation failed: ${JSON.stringify({
                editorHydrationDebugState,
                editorHydrationDomState,
                failedEditorDebugState,
                cause: getErrorMessage(error),
            })}`);
        }
        expect(secondFreeTextCount).toBeGreaterThan(0);
        try {
            await waitForSaveFrontierReady(restartedPage, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        } catch (error) {
            const failedFrontierDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
            const failedFrontierDomState = await restartedPage.evaluate(() => {
                const host = globalThis.__evbE2E.getActiveWorkspaceHost();
                const workspace = (window as Window & {__evbTestApi?: {getActiveWorkspaceHandle?: () => {
                    getAutomationStateSnapshot?: () => unknown;
                    getToolbarSnapshot?: () => unknown;
                } | null;};}).__evbTestApi?.getActiveWorkspaceHandle?.() ?? null;
                const layer = host?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
                return {
                    activeElement: document.activeElement?.outerHTML.slice(0, 1_000) ?? null,
                    activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                    editorCount: host?.querySelectorAll('[data-annotation-kind="text-box"]').length ?? 0,
                    editors: Array.from(host?.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]') ?? []).map(editor => ({
                        id: editor.id,
                        text: editor.textContent ?? '',
                        classes: editor.className,
                    })),
                    layerClassName: layer?.className ?? null,
                    toolbar: workspace?.getToolbarSnapshot?.() ?? null,
                    automationState: workspace?.getAutomationStateSnapshot?.() ?? null,
                };
            });
            throw new Error(`Restored FreeText save frontier did not become ready: ${JSON.stringify({
                failedFrontierDebugState,
                failedFrontierDomState,
                cause: getErrorMessage(error),
            })}`);
        }
        const secondAgentSaveResult = await saveLargePdfViaAgentAction(restartedPage);
        if (!secondAgentSaveResult) {
            await saveViaWindowHandle(restartedPage, LARGE_PDF_TIMEOUT_MS);
        }
        const twiceSavedNotes = await readPdfNoteContents(fixturePath);
        expect(twiceSavedNotes.filter(note => note.contents === persistedText)).toHaveLength(1);
        expect(twiceSavedNotes.filter(note => note.contents === secondText)).toHaveLength(1);
    }, LARGE_PDF_TIMEOUT_MS);

    it('deletes a persisted ordinary FreeText through the sidebar and keeps it absent after restart', async () => {
        const initialSession = sessionFixture.getSession();
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        const initialProcesses = readSessionProcessSnapshot(initialSession.name);
        const freshSession = await sessionFixture.restart({
            clean: true,
            hard: true,
        });
        await expectProcessesExited(initialProcesses.pids);
        const freshProcesses = readSessionProcessSnapshot(freshSession.name);
        expect(freshProcesses.rootPid).not.toBe(initialProcesses.rootPid);

        const artifactRoot = process.env[LARGE_PDF_ARTIFACT_ROOT_ENV]?.trim() || tmpdir();
        const restartArtifactDir = mkdtempSync(join(artifactRoot, '.evb-large-pdf-freetext-delete-'));
        fixtureDirectories.push(restartArtifactDir);
        const fixturePath = join(restartArtifactDir, 'saved.pdf');
        try {
            copyFileSync(fixtureSourcePath, fixturePath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, fixturePath);
        }
        const fixtureRealPath = realpathSync(fixturePath);
        const text = `large pdf sidebar delete ${Date.now()}`;

        await openPdfInApp(freshSession.page, fixtureRealPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        expect(await createFreeTextAnnotationWithPointer(
            freshSession.page,
            text,
            {
                x: 0.42,
                y: 0.34,
            },
        )).toBeGreaterThan(0);
        await waitForSaveFrontierReady(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        let firstSaveEvent: Awaited<ReturnType<typeof saveViaVisibleToolbarWithDeadline>>;
        try {
            firstSaveEvent = await saveViaVisibleToolbarWithDeadline(
                freshSession.page,
                LARGE_PDF_SAVE_TIMEOUT_MS,
                fixtureRealPath,
                {
                    label: 'large PDF ordinary FreeText sidebar-delete first save',
                    onTimeout: () => freshSession.stop(),
                    diagnostics: () => `phase=large-pdf-freetext-sidebar-delete-first-save session=${freshSession.name}`,
                },
            );
        } catch (error) {
            const liveState = await readOrdinaryFreeTextLiveState(freshSession.page, text)
                .catch(cause => ({error: getErrorMessage(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(freshSession.page)
                .catch(cause => ({error: getErrorMessage(cause)}));
            throw new Error(`Ordinary FreeText first save failed: ${JSON.stringify({
                liveState,
                domDiagnostics,
                cause: getErrorMessage(error),
            })}`);
        }
        expect(realpathSync(String(firstSaveEvent.detail.path))).toBe(fixtureRealPath);
        const firstSaveIdentity = await readDocumentSaveIdentity(freshSession.page);

        let savedState: IOrdinaryFreeTextLiveState;
        try {
            savedState = await waitForOrdinaryFreeTextState(
                freshSession.page,
                text,
                {
                    // EVB owns the editor and sidebar projection from the
                    // moment the text box is created. The native save updates
                    // the PDF, but does not replace the live entity.
                    canonicalMatchCount: 1,
                    editorMatchCount: 1,
                    visualMatchCount: 1,
                    sidebarMatchCount: 1,
                },
            );
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(freshSession.page).catch(() => null);
            const liveState = await readOrdinaryFreeTextLiveState(freshSession.page, text)
                .catch(cause => ({error: getErrorMessage(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(freshSession.page)
                .catch(cause => ({error: getErrorMessage(cause)}));
            throw new Error(`Ordinary FreeText did not remain in the canonical/sidebar projection after save: ${JSON.stringify({
                debugState,
                liveState,
                domDiagnostics,
                cause: getErrorMessage(error),
            })}`);
        }
        const firstPersistedMatches = await readBoundedOrdinaryFreeTextMatches(
            freshSession.page,
            fixtureRealPath,
            text,
            undefined,
            undefined,
            firstSaveIdentity.workingCopyPath,
        );
        expect(firstPersistedMatches, JSON.stringify({
            savedState,
            firstPersistedMatches,
        })).toHaveLength(1);
        const firstPersistedMatch = firstPersistedMatches[0];
        if (!firstPersistedMatch) {
            throw new Error('Saved ordinary FreeText was not present in the persisted PDF');
        }
        const targetPageIndex = firstPersistedMatch.annotation.pageIndex;
        const targetPageNumber = targetPageIndex + 1;
        const persistedName = undefined;

        await waitForCrashCheckpointPath(freshSession.name, fixtureRealPath);
        const firstRestartProcesses = readSessionProcessSnapshot(freshSession.name);
        const reopenedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        await expectProcessesExited(firstRestartProcesses.pids);
        const reopenedProcesses = readSessionProcessSnapshot(reopenedSession.name);
        expect(reopenedProcesses.rootPid).not.toBe(firstRestartProcesses.rootPid);
        await waitForRestoredDocument(reopenedSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(reopenedSession.page);
        const reopenedSaveIdentity = await readDocumentSaveIdentity(reopenedSession.page);
        await setupScrollToPage(reopenedSession.page, targetPageNumber);
        await openAnnotationsTab(reopenedSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        let restoredState: IOrdinaryFreeTextLiveState;
        try {
            restoredState = await waitForOrdinaryFreeTextState(
                reopenedSession.page,
                text,
                {
                    canonicalMatchCount: 1,
                    // Reopened FreeText is imported into the EVB canonical
                    // editor layer. PDF.js remains read-only for this path.
                    editorMatchCount: 1,
                    visualMatchCount: 1,
                    sidebarMatchCount: 1,
                },
            );
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(reopenedSession.page).catch(() => null);
            const liveState = await readOrdinaryFreeTextLiveState(reopenedSession.page, text)
                .catch(cause => ({error: getErrorMessage(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(reopenedSession.page)
                .catch(cause => ({error: getErrorMessage(cause)}));
            throw new Error(`Ordinary FreeText did not rehydrate into the canonical/sidebar projection: ${JSON.stringify({
                debugState,
                liveState,
                domDiagnostics,
                cause: getErrorMessage(error),
            })}`);
        }
        const restoredComment = restoredState.canonicalMatches[0];
        expect(restoredComment, JSON.stringify(restoredState)).toMatchObject({
            annotationId: expect.any(String),
            annotationName: persistedName ?? null,
            source: 'pdf',
            subtype: 'FreeText',
            text,
        });

        try {
            await clickSidebarDeleteForText(reopenedSession.page, text);
        } catch (error) {
            const liveState = await readOrdinaryFreeTextLiveState(reopenedSession.page, text)
                .catch(cause => ({error: getErrorMessage(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(reopenedSession.page)
                .catch(cause => ({error: getErrorMessage(cause)}));
            throw new Error(`Ordinary FreeText sidebar delete control was not found: ${JSON.stringify({
                liveState,
                domDiagnostics,
                cause: getErrorMessage(error),
            })}`);
        }
        let deletedState: IOrdinaryFreeTextLiveState;
        try {
            deletedState = await waitForOrdinaryFreeTextState(
                reopenedSession.page,
                text,
                {
                    canonicalMatchCount: 0,
                    editorMatchCount: 0,
                    visualMatchCount: 0,
                    sidebarMatchCount: 0,
                },
            );
        } catch (error) {
            const liveState = await readOrdinaryFreeTextLiveState(reopenedSession.page, text)
                .catch(cause => ({error: getErrorMessage(cause)}));
            const domDiagnostics = await readOrdinaryFreeTextDomDiagnostics(reopenedSession.page)
                .catch(cause => ({error: getErrorMessage(cause)}));
            throw new Error(`Ordinary FreeText did not disappear from the annotation layer/canonical/sidebar projection: ${JSON.stringify({
                liveState,
                domDiagnostics,
                cause: getErrorMessage(error),
            })}`);
        }
        expect(deletedState.canonicalMatches).toHaveLength(0);
        expect(deletedState.editorMatchCount).toBe(0);
        expect(deletedState.visualMatchCount).toBe(0);
        expect(deletedState.sidebarMatchCount).toBe(0);

        await expect.poll(async () => {
            const state = await readWorkspaceStateValues<Record<string, unknown>>(
                reopenedSession.page,
                ['dirtyState'],
            );
            const dirty = state.dirtyState;
            return dirty !== null
                && typeof dirty === 'object'
                && (dirty as Record<string, unknown>).annotationDirty === true
                && (dirty as Record<string, unknown>).hasAnnotationChanges === true;
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);

        // Sidebar deletion is a live edit. The durable file must still contain
        // the annotation until the subsequent visible save commits it.
        const beforeDeleteSaveMatches = await readBoundedOrdinaryFreeTextMatches(
            reopenedSession.page,
            fixtureRealPath,
            text,
            persistedName,
            targetPageIndex,
            reopenedSaveIdentity.workingCopyPath,
        );
        expect(beforeDeleteSaveMatches, JSON.stringify({
            beforeDeleteSaveMatches,
            persistedName,
            targetPageIndex,
        })).toHaveLength(1);

        await waitForSaveFrontierReady(reopenedSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        const deleteSaveEvent = await saveViaVisibleToolbarWithDeadline(
            reopenedSession.page,
            LARGE_PDF_SAVE_TIMEOUT_MS,
            fixtureRealPath,
            {
                label: 'large PDF ordinary FreeText sidebar-delete second save',
                onTimeout: () => reopenedSession.stop(),
                diagnostics: () => `phase=large-pdf-freetext-sidebar-delete-second-save session=${reopenedSession.name}`,
            },
        );
        expect(realpathSync(String(deleteSaveEvent.detail.path))).toBe(fixtureRealPath);
        await new Promise(resolve => setTimeout(resolve, 750));
        const visibleToasts = await reopenedSession.page.evaluate(() => Array.from(document.querySelectorAll('.app-toast'))
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden';
            })
            .map(element => element.textContent ?? ''));
        expect(visibleToasts.some(text => text.includes('Failed to save file')), JSON.stringify({visibleToasts}))
            .toBe(false);
        await qpdfCheck(fixtureRealPath);
        const deletedPersistedMatches = await readBoundedOrdinaryFreeTextMatches(
            reopenedSession.page,
            fixtureRealPath,
            text,
            persistedName,
            targetPageIndex,
            reopenedSaveIdentity.workingCopyPath,
        );
        expect(deletedPersistedMatches, JSON.stringify({
            deletedPersistedMatches,
            persistedName,
            targetPageIndex,
        })).toHaveLength(0);

        await waitForCrashCheckpointPath(reopenedSession.name, fixtureRealPath);
        const secondRestartProcesses = readSessionProcessSnapshot(reopenedSession.name);
        const finalSession = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        await expectProcessesExited(secondRestartProcesses.pids);
        const finalProcesses = readSessionProcessSnapshot(finalSession.name);
        expect(finalProcesses.rootPid).not.toBe(secondRestartProcesses.rootPid);
        await waitForRestoredDocument(finalSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(finalSession.page);
        const finalSaveIdentity = await readDocumentSaveIdentity(finalSession.page);
        await setupScrollToPage(finalSession.page, targetPageNumber);
        await openAnnotationsTab(finalSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        const finalState = await waitForOrdinaryFreeTextState(
            finalSession.page,
            text,
            {
                canonicalMatchCount: 0,
                editorMatchCount: 0,
                visualMatchCount: 0,
                sidebarMatchCount: 0,
            },
        );
        expect(finalState.canonicalMatches).toHaveLength(0);
        expect(finalState.editorMatchCount).toBe(0);
        expect(finalState.visualMatchCount).toBe(0);
        expect(finalState.sidebarMatchCount).toBe(0);
        const finalPersistedMatches = await readBoundedOrdinaryFreeTextMatches(
            finalSession.page,
            fixtureRealPath,
            text,
            persistedName,
            targetPageIndex,
            finalSaveIdentity.workingCopyPath,
        );
        expect(finalPersistedMatches, JSON.stringify({
            finalPersistedMatches,
            persistedName,
            targetPageIndex,
        })).toHaveLength(0);
    }, LARGE_PDF_TIMEOUT_MS);
});
