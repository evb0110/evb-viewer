import {createHash} from 'node:crypto';
import {
    copyFileSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import type {Page} from 'puppeteer-core';
import {delay} from 'es-toolkit/promise';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    readPdfTextAnnotationRecords,
    resolvePathFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    clickHistoryActionAcrossAnimationBoundaries,
    collectAnnotationOwnershipDebugState,
    waitForNoOpenNoteWindows,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForPdfLoaded,
    waitForViewerInteractive,
    waitForWorkspaceHistorySettled,
} from '@tests/e2e/electron/helpers/viewerCore';

const LEGACY_FIXTURE_ENV_VAR = 'EVB_LEGACY_NOTE_350_FIXTURE';
const REPORTED_FIXTURE_ENV_VAR = 'EVB_REPORTED_NOTE_350_FIXTURE';
const LEGACY_FIXTURE_REQUIRED_ENV_VAR = 'EVB_REQUIRE_LEGACY_NOTE_350_FIXTURE';
const REPORTED_FIXTURE_REQUIRED_ENV_VAR = 'EVB_REQUIRE_REPORTED_NOTE_350_FIXTURE';
const DEFAULT_LEGACY_FIXTURE_PATH = join(
    process.cwd(),
    'tests',
    'fixtures',
    'electron',
    'legacy-notes-minimal.pdf',
);
const DEFAULT_REPORTED_FIXTURE_PATH = join(
    process.cwd(),
    'tests',
    'fixtures',
    'electron',
    'reported-notes.pdf',
);
const legacyFixtureAvailability = resolvePathFixtureAvailability({
    label: '#350 legacy note',
    path: process.env[LEGACY_FIXTURE_ENV_VAR]?.trim() || DEFAULT_LEGACY_FIXTURE_PATH,
    requiredEnvVar: LEGACY_FIXTURE_REQUIRED_ENV_VAR,
});
const reportedFixtureAvailability = resolvePathFixtureAvailability({
    label: '#350 reported legacy note',
    path: process.env[REPORTED_FIXTURE_ENV_VAR]?.trim() || DEFAULT_REPORTED_FIXTURE_PATH,
    requiredEnvVar: REPORTED_FIXTURE_REQUIRED_ENV_VAR,
});
const LEGACY_FIXTURE_PATH = legacyFixtureAvailability.path ?? '';
const REPORTED_FIXTURE_PATH = reportedFixtureAvailability.path ?? '';
const evidenceFixtureAvailability = legacyFixtureAvailability.path && reportedFixtureAvailability.path
    ? legacyFixtureAvailability
    : {
        path: null,
        reason: [
            legacyFixtureAvailability,
            reportedFixtureAvailability,
        ]
            .filter(fixture => !fixture.path)
            .map(fixture => fixture.reason)
            .join('; '),
        required: legacyFixtureAvailability.required || reportedFixtureAvailability.required,
    };
const runLegacyFixtureDescribe = selectFixtureDescribe(describe, legacyFixtureAvailability);
const runEvidenceFixtureDescribe = selectFixtureDescribe(describe, evidenceFixtureAvailability);
const LEGACY_FIXTURE_SIZE = 3_153;
const LEGACY_FIXTURE_SHA256 = 'f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da';
const REPORTED_FIXTURE_SIZE = 2_833_504;
const REPORTED_FIXTURE_SHA256 = '8398f0bce24e1d229810f29dc7844aff68c1bbebb2d9e0527df0a801d1ccbd36';
const LEGACY_NOTE_ID = 'evb-note:uid:0:pdfjs_internal_editor_0:created:1788623295912';
const LEGACY_NEIGHBOR_ID = 'evb-note:uid:0:pdfjs_internal_editor_1:created:1788623295912';
const LEGACY_NOTE_TEXT = 'Legacy note 1';
const LEGACY_NEIGHBOR_TEXT = 'Legacy note 2';
const LEGACY_REPLY_ID = 'evb-note:reply:0';
const LEGACY_REPLY_TEXT = 'Legacy reply 1';
const REPORTED_NEIGHBOR_ID = 'evb-note:uid:0:pdfjs_internal_editor_1:created:1788625762237';
const REPORTED_NOTE_TEXT = 'sadfasd';
const REPORTED_NEIGHBOR_TEXT = 'adfas';
const TEST_TIMEOUT_MS = 180_000;
const READINESS_TIMEOUT_MS = 30_000;

interface IPageAnnotationGraphRecord {
    name: string | null;
    parent: string | null;
    popup: string | null;
    ref: string;
    replyTo: string | null;
    subtype: string | null;
}

function readPdfString(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return null;
}

async function readFirstPageAnnotationGraph(filePath: string): Promise<IPageAnnotationGraphRecord[]> {
    const document = await PDFDocument.load(readFileSync(filePath), {updateMetadata: false});
    const annots = document.getPage(0).node.Annots();
    if (!(annots instanceof PDFArray)) {
        return [];
    }

    return Array.from({length: annots.size()}, (_, index) => {
        const ref = annots.get(index);
        if (!(ref instanceof PDFRef)) {
            return null;
        }
        const dict = document.context.lookupMaybe(ref, PDFDict);
        if (!(dict instanceof PDFDict)) {
            return null;
        }
        const readRef = (key: string) => {
            const value = dict.get(PDFName.of(key));
            return value instanceof PDFRef ? String(value) : null;
        };
        return {
            name: readPdfString(dict.get(PDFName.of('NM'))),
            parent: readRef('Parent'),
            popup: readRef('Popup'),
            ref: String(ref),
            replyTo: readRef('IRT'),
            subtype: dict.get(PDFName.of('Subtype'))?.toString() ?? null,
        };
    }).filter((record): record is IPageAnnotationGraphRecord => record !== null);
}

async function expectLegacyFixtureShape(
    filePath: string,
    expectedSize: number,
    expectedSha256: string,
    expectedNoteId = LEGACY_NOTE_ID,
) {
    expect(statSync(filePath).size).toBe(expectedSize);
    expect(createHash('sha256').update(readFileSync(filePath)).digest('hex')).toBe(expectedSha256);

    const graph = await readFirstPageAnnotationGraph(filePath);
    const noteParents = graph.filter(record => record.subtype === '/FreeText');
    expect(noteParents).toHaveLength(2);
    expect(noteParents.map(record => record.name)).toContain(expectedNoteId);
    expect(noteParents.every(record => (
        record.popup !== null
        && graph.some(candidate => (
            candidate.ref === record.popup
            && candidate.subtype === '/Popup'
            && candidate.parent === record.ref
        ))
    ))).toBe(true);
    expect(graph.filter(record => record.replyTo !== null)).toHaveLength(0);
    return graph;
}

function copyFreshPdf(sourcePath: string, label: string) {
    const directory = mkdtempSync(join(tmpdir(), `evb-legacy-note-350-${label}-`));
    const destination = join(directory, 'document.pdf');
    copyFileSync(sourcePath, destination);
    onTestFinished(() => rmSync(directory, {
        force: true,
        recursive: true,
    }));
    return destination;
}

async function createLegacyReplyFixture(sourcePath: string) {
    const destination = copyFreshPdf(sourcePath, 'reply');
    const document = await PDFDocument.load(readFileSync(destination), {updateMetadata: false});
    const page = document.getPage(0);
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) {
        throw new Error('Legacy reply fixture has no page annotation array');
    }
    const targetEntry = Array.from({length: annots.size()}, (_, index) => annots.get(index))
        .find((entry): entry is PDFRef => {
            if (!(entry instanceof PDFRef)) {
                return false;
            }
            const annotation = document.context.lookupMaybe(entry, PDFDict);
            return annotation instanceof PDFDict
                && readPdfString(annotation.get(PDFName.of('NM'))) === LEGACY_NOTE_ID;
        });
    if (!(targetEntry instanceof PDFRef)) {
        throw new Error(`Legacy reply fixture cannot find ${LEGACY_NOTE_ID}`);
    }

    const replyRef = document.context.nextRef();
    document.context.assign(replyRef, document.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Text'),
        P: page.ref,
        Rect: [
            120,
            460,
            140,
            480,
        ],
        NM: PDFHexString.fromText(LEGACY_REPLY_ID),
        Contents: PDFHexString.fromText(LEGACY_REPLY_TEXT),
        IRT: targetEntry,
        RT: PDFName.of('R'),
        T: PDFHexString.fromText('Legacy reply author'),
        M: PDFString.of('D:20260905210000Z'),
    }));
    const nextAnnots = Array.from({length: annots.size()}, (_, index) => annots.get(index));
    nextAnnots.push(replyRef);
    page.node.set(PDFName.of('Annots'), document.context.obj(nextAnnots));
    writeFileSync(destination, await document.save({
        addDefaultPage: false,
        useObjectStreams: false,
    }));
    return destination;
}

async function readCanonicalComments(page: Page) {
    return page.evaluate(() => {
        const api = (window as Window & {__evbTestApi?: {readActiveWorkspaceStateValues: <TValues extends Record<string, unknown>>(names: string[]) => TValues;};}).__evbTestApi;
        const state = api?.readActiveWorkspaceStateValues<{annotationComments?: Array<{
            annotationId?: string | null;
            annotationName?: string | null;
            appAnnotationId?: string;
            hasNote?: boolean;
            id: string;
            replies?: Array<Record<string, unknown>>;
            source: string;
            stableKey: string;
            subtype?: string | null;
            text: string;
        }>;}>(['annotationComments']);
        return (state?.annotationComments ?? [])
            .filter(comment => comment.hasNote === true)
            .map(comment => ({
                annotationId: comment.annotationId ?? null,
                annotationName: comment.annotationName ?? null,
                appAnnotationId: comment.appAnnotationId,
                hasNote: true,
                id: comment.id,
                replies: (comment.replies ?? []).map(reply => ({...reply})),
                source: comment.source,
                stableKey: comment.stableKey,
                subtype: comment.subtype ?? null,
                text: comment.text,
            }));
    });
}

async function readRawAnnotationComments(page: Page) {
    return page.evaluate(() => {
        const api = (window as Window & {__evbTestApi?: {readActiveWorkspaceStateValues: <TValues extends Record<string, unknown>>(names: string[]) => TValues;};}).__evbTestApi;
        const state = api?.readActiveWorkspaceStateValues<{
            annotationComments?: Array<Record<string, unknown>>;
            annotationCommentsStatus?: string;
        }>([
            'annotationComments',
            'annotationCommentsStatus',
        ]);
        return {
            comments: (state?.annotationComments ?? []).map(comment => ({
                keys: Object.keys(comment),
                appAnnotationId: comment.appAnnotationId ?? null,
                annotationId: comment.annotationId ?? null,
                hasNote: comment.hasNote ?? null,
                id: comment.id ?? null,
                source: comment.source ?? null,
                stableKey: comment.stableKey ?? null,
                subtype: comment.subtype ?? null,
                text: comment.text ?? null,
            })),
            status: state?.annotationCommentsStatus ?? null,
        };
    });
}

async function readSidebarDeleteDiagnostics(page: Page, expectedText: string) {
    return page.evaluate((text: string) => {
        const describe = (element: Element | null) => element instanceof HTMLElement
            ? {
                className: element.className,
                disabled: element instanceof HTMLButtonElement ? element.disabled : null,
                text: element.textContent?.trim() ?? '',
                tagName: element.tagName,
            }
            : null;
        return Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .notes-list .note-item',
        )).map(item => {
            const itemText = item.querySelector('.note-item-text')?.textContent?.trim() ?? '';
            const button = item.querySelector<HTMLButtonElement>('.note-item-delete');
            const rect = button?.getBoundingClientRect();
            const x = rect ? rect.left + rect.width / 2 : 0;
            const y = rect ? rect.top + rect.height / 2 : 0;
            return {
                button: describe(button ?? null),
                buttonComputed: button ? {
                    opacity: getComputedStyle(button).opacity,
                    pointerEvents: getComputedStyle(button).pointerEvents,
                } : null,
                buttonRect: rect ? {
                    bottom: rect.bottom,
                    height: rect.height,
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    width: rect.width,
                } : null,
                expectedTextMatches: itemText.includes(text),
                hit: rect ? describe(document.elementFromPoint(x, y)) : null,
                itemText,
                itemRect: (() => {
                    const itemRect = item.getBoundingClientRect();
                    return {
                        bottom: itemRect.bottom,
                        height: itemRect.height,
                        left: itemRect.left,
                        right: itemRect.right,
                        top: itemRect.top,
                        width: itemRect.width,
                    };
                })(),
            };
        });
    }, expectedText);
}

async function waitForCanonicalNoteCount(page: Page, expectedCount: number) {
    const startedAt = Date.now();
    let notes = await readCanonicalComments(page);
    while (Date.now() - startedAt < READINESS_TIMEOUT_MS) {
        if (notes.length === expectedCount) {
            return notes;
        }
        await delay(100);
        notes = await readCanonicalComments(page);
    }
    throw new Error(`Canonical note count did not become ${expectedCount}: ${JSON.stringify({
        filtered: notes,
        raw: await readRawAnnotationComments(page),
        sidebar: await readSidebarDeleteDiagnostics(page, LEGACY_NOTE_TEXT),
        ownership: await collectAnnotationOwnershipDebugState(page),
    })}`);
}

async function waitForCanonicalNoteText(page: Page, annotationId: string, expectedText: string) {
    const startedAt = Date.now();
    let notes = await readCanonicalComments(page);
    while (Date.now() - startedAt < READINESS_TIMEOUT_MS) {
        const target = notes.find(note => note.appAnnotationId === annotationId);
        if (target?.text === expectedText) {
            return target;
        }
        await delay(100);
        notes = await readCanonicalComments(page);
    }
    throw new Error(`Canonical note text did not become ${JSON.stringify(expectedText)}: ${JSON.stringify({
        notes,
        raw: await readRawAnnotationComments(page),
    })}`);
}

async function expectCanonicalNoteSet(
    page: Page,
    targetText: string,
    targetPresent = true,
    neighborId = LEGACY_NEIGHBOR_ID,
    neighborText = LEGACY_NEIGHBOR_TEXT,
) {
    const notes = await waitForCanonicalNoteCount(page, targetPresent ? 2 : 1);
    const target = notes.find(note => note.appAnnotationId === LEGACY_NOTE_ID);
    const neighbor = notes.find(note => note.appAnnotationId === neighborId);

    expect(neighbor).toMatchObject({
        annotationName: null,
        appAnnotationId: neighborId,
        source: 'pdf',
        subtype: 'Text',
        text: neighborText,
    });
    expect(neighbor?.annotationId).toMatch(/^\d+ \d+ R$/u);
    expect(neighbor?.id).toBe(neighbor?.annotationId);
    expect(neighbor?.stableKey).toBe(`ann:0:${neighbor?.annotationId}`);
    expect(neighbor?.replies ?? []).toHaveLength(0);

    if (!targetPresent) {
        expect(target).toBeUndefined();
        return notes;
    }

    expect(target).toMatchObject({
        annotationName: null,
        appAnnotationId: LEGACY_NOTE_ID,
        source: 'pdf',
        subtype: 'Text',
        text: targetText,
    });
    expect(target?.annotationId).toMatch(/^\d+ \d+ R$/u);
    expect(target?.id).toBe(target?.annotationId);
    expect(target?.stableKey).toBe(`ann:0:${target?.annotationId}`);
    expect(target?.replies ?? []).toHaveLength(0);
    expect(target?.stableKey).not.toBe(neighbor?.stableKey);
    return notes;
}

async function expectCanonicalLegacyReply(page: Page) {
    const notes = await waitForCanonicalNoteCount(page, 2);
    const target = notes.find(note => note.appAnnotationId === LEGACY_NOTE_ID);
    const neighbor = notes.find(note => note.appAnnotationId === LEGACY_NEIGHBOR_ID);
    expect(target).toMatchObject({
        appAnnotationId: LEGACY_NOTE_ID,
        source: 'pdf',
        subtype: 'Text',
        text: LEGACY_NOTE_TEXT,
    });
    expect(target?.replies).toEqual([expect.objectContaining({contents: LEGACY_REPLY_TEXT})]);
    expect(neighbor).toMatchObject({
        appAnnotationId: LEGACY_NEIGHBOR_ID,
        text: LEGACY_NEIGHBOR_TEXT,
    });
    expect(neighbor?.replies ?? []).toHaveLength(0);
    return target;
}

async function readEntityCenter(page: Page, annotationId: string) {
    return page.evaluate((expectedId: string) => {
        const entity = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="note"]',
        )).find(candidate => candidate.dataset.annotationId === expectedId);
        if (!entity) {
            return null;
        }
        const rect = entity.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, annotationId);
}

async function waitForEntityCenter(page: Page, annotationId: string) {
    const startedAt = Date.now();
    let point = await readEntityCenter(page, annotationId);
    while (Date.now() - startedAt < READINESS_TIMEOUT_MS) {
        if (point) {
            return point;
        }
        await delay(100);
        point = await readEntityCenter(page, annotationId);
    }
    throw new Error(`Canonical note entity did not become visible: ${annotationId}`);
}

async function waitForEntityPointerPoint(page: Page, annotationId: string) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < READINESS_TIMEOUT_MS) {
        const point = await page.evaluate((expectedId: string) => {
            const entity = Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="note"]',
            )).find(candidate => candidate.dataset.annotationId === expectedId);
            if (!entity) {
                return null;
            }
            const rect = entity.getBoundingClientRect();
            const candidates = [
                [
                    rect.left + 1,
                    rect.top + rect.height / 2,
                ],
                [
                    rect.right - 1,
                    rect.top + rect.height / 2,
                ],
                [
                    rect.left + rect.width / 2,
                    rect.top + 1,
                ],
                [
                    rect.left + rect.width / 2,
                    rect.bottom - 1,
                ],
                [
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2,
                ],
            ];
            const hit = candidates.find(([
                x,
                y,
            ]) => document.elementFromPoint(x!, y!) === entity);
            const [
                x,
                y,
            ] = hit ?? candidates.at(-1)!;
            return {
                x: Number(x),
                y: Number(y),
            };
        }, annotationId);
        if (point) {
            return point;
        }
        await delay(100);
    }
    throw new Error(`Canonical note entity did not become pointer-hit-testable: ${annotationId}`);
}

async function readSidebarButtonCenter(page: Page, noteText: string, selector: string) {
    return page.evaluate(({
        expectedText,
        buttonSelector,
    }) => {
        const button = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .notes-list .note-item',
        )).map(item => ({
            button: item.querySelector<HTMLButtonElement>(buttonSelector),
            text: item.querySelector('.note-item-text')?.textContent ?? '',
        })).find(candidate => {
            if (!candidate.button || !candidate.text.includes(expectedText)) {
                return false;
            }
            const rect = candidate.button.getBoundingClientRect();
            return rect.width > 0
                && rect.height > 0
                && rect.bottom > 0
                && rect.right > 0
                && rect.top < window.innerHeight
                && rect.left < window.innerWidth;
        })?.button;
        if (!button) {
            return null;
        }
        const rect = button.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, {
        buttonSelector: selector,
        expectedText: noteText,
    });
}

async function waitForSidebarButtonCenter(page: Page, noteText: string, selector: string) {
    const startedAt = Date.now();
    let point = await readSidebarButtonCenter(page, noteText, selector);
    while (Date.now() - startedAt < READINESS_TIMEOUT_MS) {
        if (point) {
            return point;
        }
        await delay(100);
        point = await readSidebarButtonCenter(page, noteText, selector);
    }
    throw new Error(`Sidebar control did not become visible for ${noteText}: ${selector}`);
}

async function readNoteWindowButtonCenter(page: Page, annotationId: string, selector: string) {
    return page.evaluate(({
        expectedId,
        buttonSelector,
    }) => {
        const windowElement = Array.from(document.querySelectorAll<HTMLElement>('.note-window'))
            .find(candidate => candidate.dataset.annotationId === expectedId);
        const button = windowElement?.querySelector<HTMLButtonElement>(buttonSelector);
        if (!button) {
            return null;
        }
        const rect = button.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, {
        buttonSelector: selector,
        expectedId: annotationId,
    });
}

async function waitForNoteWindowButtonCenter(page: Page, annotationId: string, selector: string) {
    const startedAt = Date.now();
    let point = await readNoteWindowButtonCenter(page, annotationId, selector);
    while (Date.now() - startedAt < READINESS_TIMEOUT_MS) {
        if (point) {
            return point;
        }
        await delay(100);
        point = await readNoteWindowButtonCenter(page, annotationId, selector);
    }
    throw new Error(`Note-window control did not become visible for ${annotationId}: ${selector}`);
}

async function openNoteWindowWithPointer(page: Page, annotationId: string) {
    const point = await waitForEntityCenter(page, annotationId);
    await page.mouse.click(point.x, point.y, {
        count: 2,
        delay: 80,
    });
    await page.waitForFunction((expectedId: string) => Array.from(
        document.querySelectorAll<HTMLElement>('.note-window'),
    ).some(candidate => candidate.dataset.annotationId === expectedId), {timeout: READINESS_TIMEOUT_MS}, annotationId);
}

async function expectSelectedEntity(page: Page, annotationId: string) {
    const startedAt = Date.now();
    let state = await collectAnnotationOwnershipDebugState(page);
    while (Date.now() - startedAt < READINESS_TIMEOUT_MS) {
        if (state.canonicalEntities.some(entity => entity.id === annotationId && entity.selected)) {
            return;
        }
        await delay(100);
        state = await collectAnnotationOwnershipDebugState(page);
    }
    const hitTest = await page.evaluate((expectedId: string) => {
        const entity = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="note"]',
        )).find(candidate => candidate.dataset.annotationId === expectedId);
        if (!entity) {
            return null;
        }
        const rect = entity.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const describe = (element: Element | null) => element instanceof HTMLElement
            ? {
                annotationId: element.dataset.annotationId ?? null,
                className: element.className,
                pointerEvents: getComputedStyle(element).pointerEvents,
                tagName: element.tagName,
            }
            : null;
        return {
            activeElement: describe(document.activeElement),
            entity: {
                className: entity.className,
                pointerEvents: getComputedStyle(entity).pointerEvents,
                rect: {
                    bottom: rect.bottom,
                    height: rect.height,
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    width: rect.width,
                },
            },
            hit: describe(hit),
            layer: describe(entity.closest('.pdf-annotation-editor-layer')),
        };
    }, annotationId);
    throw new Error(`Canonical note was not selected: ${annotationId}: ${JSON.stringify({
        state,
        hitTest,
    })}`);
}

async function editOpenNoteWithPointer(page: Page, nextText: string) {
    const textarea = await page.waitForSelector('textarea.note-window__textarea', {
        timeout: READINESS_TIMEOUT_MS,
        visible: true,
    });
    if (!textarea) {
        throw new Error('Open legacy note did not expose its textarea');
    }
    await textarea.click();
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier);
    await page.keyboard.press('A');
    await page.keyboard.up(modifier);
    await page.keyboard.type(nextText, {delay: 10});
    await page.keyboard.press('Tab');
    const closePoint = await waitForNoteWindowButtonCenter(page, LEGACY_NOTE_ID, '.note-window__close');
    await page.mouse.click(closePoint.x, closePoint.y);
}

async function expectSavedLegacyPair(
    filePath: string,
    targetText: string,
    targetSubtype: '/Text' | '/FreeText',
    targetPresent = true,
    neighborId = LEGACY_NEIGHBOR_ID,
    neighborText = LEGACY_NEIGHBOR_TEXT,
) {
    const records = await readPdfTextAnnotationRecords(filePath);
    const targetRecords = records.filter(record => record.name === LEGACY_NOTE_ID);
    const neighborRecords = records.filter(record => record.name === neighborId);

    if (targetPresent) {
        expect(targetRecords).toEqual([expect.objectContaining({
            contents: targetText,
            popup: expect.any(String),
            replyTo: null,
            subtype: targetSubtype,
        })]);
    } else {
        expect(targetRecords).toHaveLength(0);
    }
    expect(neighborRecords).toEqual([expect.objectContaining({
        contents: neighborText,
        popup: expect.any(String),
        replyTo: null,
        subtype: '/FreeText',
    })]);

    const graph = await readFirstPageAnnotationGraph(filePath);
    const targetGraph = graph.find(record => record.name === LEGACY_NOTE_ID);
    const neighborGraph = graph.find(record => record.name === neighborId);
    expect(neighborGraph).toMatchObject({subtype: '/FreeText'});
    expect(neighborGraph?.popup).not.toBeNull();
    expect(graph.filter(record => record.replyTo !== null)).toHaveLength(0);
    if (!targetPresent) {
        expect(targetGraph).toBeUndefined();
        return;
    }
    expect(targetGraph).toMatchObject({subtype: targetSubtype});
    expect(targetGraph?.popup).not.toBeNull();
    expect(graph.filter(record => record.parent === targetGraph?.ref)).toEqual([expect.objectContaining({subtype: '/Popup'})]);
}

async function expectLegacyReplyDeleted(filePath: string) {
    const records = await readPdfTextAnnotationRecords(filePath);
    expect(records.filter(record => (
        record.name === LEGACY_NOTE_ID
        || record.name === LEGACY_REPLY_ID
        || record.contents === LEGACY_REPLY_TEXT
    ))).toHaveLength(0);
    expect(records.filter(record => record.name === LEGACY_NEIGHBOR_ID)).toEqual([expect.objectContaining({
        contents: LEGACY_NEIGHBOR_TEXT,
        popup: expect.any(String),
        replyTo: null,
        subtype: '/FreeText',
    })]);
    const graph = await readFirstPageAnnotationGraph(filePath);
    expect(graph.some(record => record.name === LEGACY_NOTE_ID)).toBe(false);
    expect(graph.some(record => record.name === LEGACY_REPLY_ID)).toBe(false);
    expect(graph.filter(record => record.replyTo !== null)).toHaveLength(0);
    expect(graph.some(record => record.name === LEGACY_NEIGHBOR_ID && record.subtype === '/FreeText')).toBe(true);
}

runEvidenceFixtureDescribe('Fixture evidence - #350 legacy saved notes', () => {
    it('keeps the recovered minimal and reported fixtures structurally distinct and intact', async () => {
        const minimalGraph = await expectLegacyFixtureShape(
            LEGACY_FIXTURE_PATH,
            LEGACY_FIXTURE_SIZE,
            LEGACY_FIXTURE_SHA256,
        );
        const reportedGraph = await expectLegacyFixtureShape(
            REPORTED_FIXTURE_PATH,
            REPORTED_FIXTURE_SIZE,
            REPORTED_FIXTURE_SHA256,
        );
        expect(minimalGraph.filter(record => record.subtype === '/FreeText')).toHaveLength(2);
        expect(reportedGraph.filter(record => record.subtype === '/FreeText')).toHaveLength(2);
        expect(reportedGraph.some(record => record.name === LEGACY_NOTE_ID)).toBe(true);
        expect(reportedGraph.filter(record => record.name?.startsWith('evb-note:uid:0:pdfjs_internal_editor_')).length).toBe(2);
    });
});

runLegacyFixtureDescribe('Electron E2E - #350 legacy saved notes', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-legacy-note-350-${Date.now()}`});

    it('preserves legacy note identity through pointer selection, deletion, edit migration, and reopen', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Legacy note #350 Electron E2E session failed to start');
        }

        await expectLegacyFixtureShape(LEGACY_FIXTURE_PATH, LEGACY_FIXTURE_SIZE, LEGACY_FIXTURE_SHA256);
        const fixturePath = copyFreshPdf(LEGACY_FIXTURE_PATH, 'initial');

        await openPdfInApp(session.page, fixturePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openAnnotationsTab(session.page);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT);

        const initialTarget = (await readCanonicalComments(session.page))
            .find(note => note.appAnnotationId === LEGACY_NOTE_ID);
        const initialNeighbor = (await readCanonicalComments(session.page))
            .find(note => note.appAnnotationId === LEGACY_NEIGHBOR_ID);
        expect(initialTarget?.annotationId).toMatch(/^\d+ \d+ R$/u);
        expect(initialTarget?.id).toBe(initialTarget?.annotationId);
        expect(initialTarget?.stableKey).toBe(`ann:0:${initialTarget?.annotationId}`);
        expect(initialNeighbor?.annotationId).toMatch(/^\d+ \d+ R$/u);

        const targetPoint = await waitForEntityPointerPoint(session.page, LEGACY_NOTE_ID);
        await session.page.mouse.click(targetPoint.x, targetPoint.y);
        await expectSelectedEntity(session.page, LEGACY_NOTE_ID);
        const selectedDom = await session.page.evaluate((expectedId: string) => {
            const entity = Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="note"]',
            )).find(candidate => candidate.dataset.annotationId === expectedId);
            return entity
                ? {
                    annotationId: entity.dataset.annotationId ?? null,
                    stableKey: entity.dataset.stableKey ?? null,
                    selected: entity.classList.contains('is-selected'),
                }
                : null;
        }, LEGACY_NOTE_ID);
        expect(selectedDom).toEqual({
            annotationId: LEGACY_NOTE_ID,
            selected: true,
            stableKey: initialTarget?.stableKey,
        });

        const sidebarTargetPoint = await waitForSidebarButtonCenter(
            session.page,
            LEGACY_NOTE_TEXT,
            '.note-item-content',
        );
        await session.page.mouse.click(sidebarTargetPoint.x, sidebarTargetPoint.y);
        await expectSelectedEntity(session.page, LEGACY_NOTE_ID);
        expect(await session.page.evaluate((expectedText: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active .notes-list .note-item'),
        ).some(item => (
            item.classList.contains('is-active')
            && item.querySelector('.note-item-text')?.textContent?.includes(expectedText)
        )), LEGACY_NOTE_TEXT)).toBe(true);

        const sidebarDeletePoint = await waitForSidebarButtonCenter(
            session.page,
            LEGACY_NOTE_TEXT,
            '.note-item-delete',
        );
        await session.page.mouse.click(sidebarDeletePoint.x, sidebarDeletePoint.y);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT, false);
        expect(await readEntityCenter(session.page, LEGACY_NOTE_ID)).toBeNull();

        let undo = await clickHistoryActionAcrossAnimationBoundaries(session.page, 'Undo');
        expect(undo.at('synchronous').canonicalAnnotationCount).toBe(2);
        await waitForWorkspaceHistorySettled(session.page, READINESS_TIMEOUT_MS);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT);
        expect(await waitForEntityCenter(session.page, LEGACY_NOTE_ID)).toBeTruthy();

        const redo = await clickHistoryActionAcrossAnimationBoundaries(session.page, 'Redo');
        expect(redo.at('synchronous').canonicalAnnotationCount).toBe(1);
        await waitForWorkspaceHistorySettled(session.page, READINESS_TIMEOUT_MS);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT, false);

        undo = await clickHistoryActionAcrossAnimationBoundaries(session.page, 'Undo');
        expect(undo.at('synchronous').canonicalAnnotationCount).toBe(2);
        await waitForWorkspaceHistorySettled(session.page, READINESS_TIMEOUT_MS);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT);

        await openNoteWindowWithPointer(session.page, LEGACY_NOTE_ID);
        expect(await session.page.evaluate((expectedId: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.note-window'),
        ).some(windowElement => windowElement.dataset.annotationId === expectedId), LEGACY_NOTE_ID)).toBe(true);
        const popupDeletePoint = await waitForNoteWindowButtonCenter(
            session.page,
            LEGACY_NOTE_ID,
            '.note-window__delete',
        );
        await session.page.mouse.click(popupDeletePoint.x, popupDeletePoint.y);
        await waitForNoOpenNoteWindows(session.page);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT, false);

        await clickHistoryActionAcrossAnimationBoundaries(session.page, 'Undo');
        await waitForWorkspaceHistorySettled(session.page, READINESS_TIMEOUT_MS);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT);
        await clickHistoryActionAcrossAnimationBoundaries(session.page, 'Redo');
        await waitForWorkspaceHistorySettled(session.page, READINESS_TIMEOUT_MS);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT, false);
        await clickHistoryActionAcrossAnimationBoundaries(session.page, 'Undo');
        await waitForWorkspaceHistorySettled(session.page, READINESS_TIMEOUT_MS);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT);

        await openNoteWindowWithPointer(session.page, LEGACY_NOTE_ID);
        await editOpenNoteWithPointer(session.page, 'Legacy note 1 edited');
        await waitForNoOpenNoteWindows(session.page);
        await waitForCanonicalNoteText(session.page, LEGACY_NOTE_ID, 'Legacy note 1 edited');
        await expectCanonicalNoteSet(session.page, 'Legacy note 1 edited');
        const editedTarget = (await readCanonicalComments(session.page))
            .find(note => note.appAnnotationId === LEGACY_NOTE_ID);
        expect(editedTarget?.stableKey).toBe(initialTarget?.stableKey);
        expect(editedTarget?.annotationId).toBe(initialTarget?.annotationId);

        const saveEvent = await saveViaVisibleToolbar(session.page, READINESS_TIMEOUT_MS, fixturePath);
        expect(realpathSync(String(saveEvent.detail.path))).toBe(realpathSync(fixturePath));
        await expectSavedLegacyPair(fixturePath, 'Legacy note 1 edited', '/Text');

        const reopenOnePath = copyFreshPdf(fixturePath, 'reopen-one');
        await openPdfInApp(session.page, reopenOnePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openAnnotationsTab(session.page);
        await expectCanonicalNoteSet(session.page, 'Legacy note 1 edited');
        const reopenedTarget = (await readCanonicalComments(session.page))
            .find(note => note.appAnnotationId === LEGACY_NOTE_ID);
        expect(reopenedTarget?.stableKey).toBe(editedTarget?.stableKey);
        expect(reopenedTarget?.annotationId).toBe(editedTarget?.annotationId);
        await expectSavedLegacyPair(reopenOnePath, 'Legacy note 1 edited', '/Text');

        const reopenedDeletePoint = await waitForSidebarButtonCenter(
            session.page,
            'Legacy note 1 edited',
            '.note-item-delete',
        );
        await session.page.mouse.click(reopenedDeletePoint.x, reopenedDeletePoint.y);
        await expectCanonicalNoteSet(session.page, 'Legacy note 1 edited', false);
        await saveViaVisibleToolbar(session.page, READINESS_TIMEOUT_MS, reopenOnePath);
        await expectSavedLegacyPair(reopenOnePath, 'Legacy note 1 edited', '/Text', false);

        const reopenTwoPath = copyFreshPdf(reopenOnePath, 'reopen-two');
        await openPdfInApp(session.page, reopenTwoPath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openAnnotationsTab(session.page);
        await expectCanonicalNoteSet(session.page, 'Legacy note 1 edited', false);
        await expectSavedLegacyPair(reopenTwoPath, 'Legacy note 1 edited', '/Text', false);

        const reopenThreePath = copyFreshPdf(reopenTwoPath, 'reopen-three');
        await openPdfInApp(session.page, reopenThreePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openAnnotationsTab(session.page);
        await expectCanonicalNoteSet(session.page, 'Legacy note 1 edited', false);
        await expectSavedLegacyPair(reopenThreePath, 'Legacy note 1 edited', '/Text', false);
    }, TEST_TIMEOUT_MS);

    const runReportedFixtureTest = selectFixtureDescribe(it, reportedFixtureAvailability);

    runReportedFixtureTest('accepts the supplied reported-file legacy note through pointer deletion and reload', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Reported legacy note #350 Electron E2E session failed to start');
        }

        await expectLegacyFixtureShape(REPORTED_FIXTURE_PATH, REPORTED_FIXTURE_SIZE, REPORTED_FIXTURE_SHA256);
        const fixturePath = copyFreshPdf(REPORTED_FIXTURE_PATH, 'reported');
        await openPdfInApp(session.page, fixturePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openAnnotationsTab(session.page);
        await expectCanonicalNoteSet(
            session.page,
            REPORTED_NOTE_TEXT,
            true,
            REPORTED_NEIGHBOR_ID,
            REPORTED_NEIGHBOR_TEXT,
        );

        const targetPoint = await waitForEntityPointerPoint(session.page, LEGACY_NOTE_ID);
        await session.page.mouse.click(targetPoint.x, targetPoint.y);
        await expectSelectedEntity(session.page, LEGACY_NOTE_ID);

        const deletePoint = await waitForSidebarButtonCenter(
            session.page,
            REPORTED_NOTE_TEXT,
            '.note-item-delete',
        );
        await session.page.mouse.click(deletePoint.x, deletePoint.y);
        await expectCanonicalNoteSet(
            session.page,
            REPORTED_NOTE_TEXT,
            false,
            REPORTED_NEIGHBOR_ID,
            REPORTED_NEIGHBOR_TEXT,
        );
        await saveViaVisibleToolbar(session.page, READINESS_TIMEOUT_MS, fixturePath);
        await expectSavedLegacyPair(
            fixturePath,
            REPORTED_NOTE_TEXT,
            '/FreeText',
            false,
            REPORTED_NEIGHBOR_ID,
            REPORTED_NEIGHBOR_TEXT,
        );

        const reopenPath = copyFreshPdf(fixturePath, 'reported-reopen');
        await openPdfInApp(session.page, reopenPath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openAnnotationsTab(session.page);
        await expectCanonicalNoteSet(
            session.page,
            REPORTED_NOTE_TEXT,
            false,
            REPORTED_NEIGHBOR_ID,
            REPORTED_NEIGHBOR_TEXT,
        );
        await expectSavedLegacyPair(
            reopenPath,
            REPORTED_NOTE_TEXT,
            '/FreeText',
            false,
            REPORTED_NEIGHBOR_ID,
            REPORTED_NEIGHBOR_TEXT,
        );
    }, TEST_TIMEOUT_MS);

    it('removes the legacy popup and reply with the parent while preserving its neighbor', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Legacy reply #350 Electron E2E session failed to start');
        }

        const fixturePath = await createLegacyReplyFixture(LEGACY_FIXTURE_PATH);
        const graph = await readFirstPageAnnotationGraph(fixturePath);
        expect(graph.some(record => record.name === LEGACY_REPLY_ID && record.replyTo !== null)).toBe(true);

        await openPdfInApp(session.page, fixturePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openAnnotationsTab(session.page);
        await expectCanonicalLegacyReply(session.page);
        await session.page.waitForFunction((replyText: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active .notes-list .note-item'),
        ).some(item => item.querySelector('.note-item-reply-text')?.textContent?.includes(replyText)), {timeout: READINESS_TIMEOUT_MS}, LEGACY_REPLY_TEXT);

        const deletePoint = await waitForSidebarButtonCenter(
            session.page,
            LEGACY_NOTE_TEXT,
            '.note-item-delete',
        );
        await session.page.mouse.click(deletePoint.x, deletePoint.y);
        await waitForNoOpenNoteWindows(session.page);
        await expectCanonicalNoteSet(session.page, LEGACY_NOTE_TEXT, false);

        const saveEvent = await saveViaVisibleToolbar(session.page, READINESS_TIMEOUT_MS, fixturePath);
        expect(realpathSync(String(saveEvent.detail.path))).toBe(realpathSync(fixturePath));
        await expectLegacyReplyDeleted(fixturePath);
    }, TEST_TIMEOUT_MS);

});
