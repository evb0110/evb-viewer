import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    constants,
    copyFileSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {execFile} from 'node:child_process';
import {
    dirname,
    join,
} from 'node:path';
import {promisify} from 'node:util';
import type {
    IPdfAnnotationIndexEntry,
    IPdfEmbeddedShapeIndexEntry,
} from '@contracts/electronApiDocuments';
import {
    resolveLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clearTextSelection,
    clickAnnotationTool,
    clickLatestVisibleNoteWindowClose,
    createCanonicalTextBoxWithPointer,
    createCanonicalTextMarkup,
    createStickyNoteWithPointer,
    waitForNoOpenNoteWindows,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaVisibleToolbarWithDeadline,
    scrollViewerToPage,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {workspaceCrashCheckpointPath} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {
    readExactPdfFixtureIdentity,
    resolveExactPdfFixtureExpectation,
    validateExactPdfFixtureIdentity,
} from '@scripts/ci/stageExactPdfFixture';
import type {Page} from 'puppeteer-core';

const MATRIX_TIMEOUT_MS = 15 * 60_000;
const NATIVE_SAVE_TIMEOUT_MS = 120_000;
const ANNOTATION_INDEX_CHUNK_BYTES = 512 * 1_024;
const MATRIX_PAGE_NUMBER = 25;
const MATRIX_PAGE_INDEX = MATRIX_PAGE_NUMBER - 1;
const PLACED_IMAGE_PAGE_NUMBER = 31;
const PLACED_IMAGE_PAGE_INDEX = PLACED_IMAGE_PAGE_NUMBER - 1;
const ACTIVE_IMAGE_PLACEMENT_SELECTOR = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .pdf-image-placement';
const fixture = resolveLargePdfFixtureAvailability();
const exactFixtureExpectation = resolveExactPdfFixtureExpectation();
const largePdfDescribe = selectFixtureDescribe(describe, fixture);
const execFileAsync = promisify(execFile);
const PLACED_IMAGE_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAoAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AntWpOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/9k=',
    'base64',
);

type TCanonicalKind = 'note' | 'placed-image' | 'shape' | 'text-box' | 'text-markup';
type TCanonicalShapeTool = 'Circle' | 'Draw' | 'Line' | 'Rectangle' | 'Arrow';

interface ICanonicalEntitySnapshot {
    id: string;
    kind: TCanonicalKind;
    height: number;
    left: number;
    pageNumber: number;
    top: number;
    width: number;
}

interface IAnnotationRef {
    generationNumber: number;
    objectNumber: number;
}

function refKey(ref: Pick<IAnnotationRef, 'objectNumber' | 'generationNumber'>) {
    return `${ref.objectNumber}R${ref.generationNumber}`;
}

function toPdfUtf16BeHex(value: string) {
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

function qpdfObjectContainsText(value: string, text: string) {
    return value.includes(text) || value.toLowerCase().includes(toPdfUtf16BeHex(text));
}

function copyExactFixture(sourcePath: string) {
    const artifactDirectory = mkdtempSync(join(dirname(sourcePath), '.evb-issue-192-matrix-'));
    const targetPath = join(artifactDirectory, 'canonical-annotation-matrix.pdf');
    try {
        copyFileSync(sourcePath, targetPath, constants.COPYFILE_FICLONE);
    } catch {
        copyFileSync(sourcePath, targetPath);
    }
    onTestFinished(() => rmSync(artifactDirectory, {
        force: true,
        recursive: true,
    }));
    return realpathSync(targetPath);
}

async function waitForCrashCheckpoint(sessionName: string, expectedPath: string) {
    const expectedRealPath = realpathSync(expectedPath);
    const readMatchingCheckpointTab = () => {
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        if (!existsSync(checkpointPath)) {
            return null;
        }
        const stored = JSON.parse(String(readFileSync(checkpointPath))) as {checkpoint?: {tabs?: Array<{
            isDirty?: boolean;
            sourceRef?: string | null;
            workingCopyRef?: string | null;
        }>;};};
        return stored.checkpoint?.tabs?.find(tab => (
            tab.isDirty === false
            && typeof tab.sourceRef === 'string'
            && realpathSync(tab.sourceRef) === expectedRealPath
        )) ?? null;
    };
    await expect.poll(readMatchingCheckpointTab, {timeout: 60_000}).toMatchObject({isDirty: false});
    const checkpointTab = readMatchingCheckpointTab();
    if (!checkpointTab) {
        throw new Error(`Clean crash checkpoint disappeared before restart for ${expectedPath}`);
    }
    return checkpointTab;
}

async function readWorkingCopyPath(page: Page) {
    const state = await readWorkspaceStateValues<{workingCopyPath?: string | null}>(page, ['workingCopyPath']);
    if (typeof state.workingCopyPath !== 'string') {
        throw new Error(`Native annotation matrix has no working copy: ${JSON.stringify(state)}`);
    }
    return state.workingCopyPath;
}

async function readAnnotationIndex(page: Page, documentPath: string) {
    return page.evaluate(async (input: {
        chunkBytes: number;
        documentPath: string
    }) => {
        const files = window.electronAPI?.documentFiles;
        if (
            !files?.beginPdfAnnotationIndex
            || !files.readPdfAnnotationIndexChunk
            || !files.releasePdfAnnotationIndex
        ) {
            throw new Error('PDF annotation index APIs are unavailable');
        }
        const revision = await files.getDocumentRevision(input.documentPath);
        const session = await files.beginPdfAnnotationIndex(
            input.documentPath,
            {expectedDocumentRevisionToken: revision.token},
        );
        const entries: IPdfAnnotationIndexEntry[] = [];
        let offset = 0;
        let released = false;
        try {
            while (true) {
                const chunk = await files.readPdfAnnotationIndexChunk(
                    session.sessionId,
                    offset,
                    {chunkBytes: input.chunkBytes},
                );
                entries.push(...chunk.entries);
                if (chunk.done) {
                    break;
                }
                if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
                    throw new Error('Annotation index offset did not advance');
                }
                offset = chunk.nextOffset;
            }
        } finally {
            released = await files.releasePdfAnnotationIndex(session.sessionId);
        }
        if (!released) {
            throw new Error('Annotation index session was not released');
        }
        return {
            entries,
            revisionToken: revision.token,
        };
    }, {
        chunkBytes: ANNOTATION_INDEX_CHUNK_BYTES,
        documentPath,
    });
}

async function readShapeIndex(page: Page, documentPath: string) {
    return page.evaluate(async (input: {
        chunkBytes: number;
        documentPath: string
    }) => {
        const files = window.electronAPI?.documentFiles;
        if (
            !files?.beginPdfEmbeddedShapeIndex
            || !files.readPdfEmbeddedShapeIndexChunk
            || !files.releasePdfEmbeddedShapeIndex
        ) {
            throw new Error('PDF embedded-shape index APIs are unavailable');
        }
        const revision = await files.getDocumentRevision(input.documentPath);
        const session = await files.beginPdfEmbeddedShapeIndex(
            input.documentPath,
            {expectedDocumentRevisionToken: revision.token},
        );
        const entries: IPdfEmbeddedShapeIndexEntry[] = [];
        let offset = 0;
        let released = false;
        try {
            while (true) {
                const chunk = await files.readPdfEmbeddedShapeIndexChunk(
                    session.sessionId,
                    offset,
                    {chunkBytes: input.chunkBytes},
                );
                entries.push(...chunk.entries);
                if (chunk.done) {
                    break;
                }
                if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
                    throw new Error('Embedded-shape index offset did not advance');
                }
                offset = chunk.nextOffset;
            }
        } finally {
            released = await files.releasePdfEmbeddedShapeIndex(session.sessionId);
        }
        if (!released) {
            throw new Error('Embedded shape index session was not released');
        }
        return entries;
    }, {
        chunkBytes: ANNOTATION_INDEX_CHUNK_BYTES,
        documentPath,
    });
}

async function readObject(documentPath: string, ref: IAnnotationRef) {
    const {stdout} = await execFileAsync('qpdf', [
        `--show-object=${ref.objectNumber},${ref.generationNumber}`,
        '--raw-stream-data',
        documentPath,
    ], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
    });
    return stdout;
}

function diffAnnotationEntries(
    before: IPdfAnnotationIndexEntry[],
    after: IPdfAnnotationIndexEntry[],
) {
    const beforeRefs = new Set(before.map(refKey));
    return after.filter(entry => !beforeRefs.has(refKey(entry)));
}

function countAnnotationSubtype(entries: IPdfAnnotationIndexEntry[], subtype: string) {
    return entries.filter(entry => (
        entry.pageIndex === MATRIX_PAGE_INDEX
        && entry.subtype === subtype
    )).length;
}

function countAddedAnnotationSubtype(
    before: IPdfAnnotationIndexEntry[],
    after: IPdfAnnotationIndexEntry[],
    subtype: string,
) {
    return diffAnnotationEntries(before, after).filter(entry => (
        entry.pageIndex === MATRIX_PAGE_INDEX
        && entry.subtype === subtype
    )).length;
}

function pageShapes(entries: IPdfEmbeddedShapeIndexEntry[]) {
    return entries.filter(entry => entry.pageIndex === MATRIX_PAGE_INDEX);
}

function addedPageShapes(
    before: IPdfEmbeddedShapeIndexEntry[],
    after: IPdfEmbeddedShapeIndexEntry[],
) {
    const beforeRefs = new Set(pageShapes(before).map(refKey));
    return pageShapes(after).filter(entry => !beforeRefs.has(refKey(entry)));
}

async function readCanonicalEntities(page: Page, pageNumber: number) {
    return page.evaluate((targetPageNumber: number) => (
        Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]',
        ))
            .map((entity) => {
                const pageContainer = entity.closest<HTMLElement>('.page_container');
                const rect = entity.getBoundingClientRect();
                return {
                    id: entity.dataset.annotationId ?? '',
                    kind: entity.dataset.annotationKind ?? '',
                    height: rect.height,
                    left: rect.left,
                    pageNumber: Number(pageContainer?.dataset.page ?? 0),
                    top: rect.top,
                    width: rect.width,
                };
            })
            .filter(entity => entity.pageNumber === targetPageNumber)
    ), pageNumber) as Promise<ICanonicalEntitySnapshot[]>;
}

async function readTopmostCanonicalTextMarkupId(
    page: Page,
    pageNumber: number,
    annotationIds: readonly string[],
) {
    return page.evaluate((input: {
        annotationIds: string[];
        pageNumber: number;
    }) => {
        const ids = new Set(input.annotationIds);
        const pageContainer = document.querySelector<HTMLElement>(
            `.editor-pane.is-active .page_container[data-page="${input.pageNumber}"]`,
        );
        const entity = Array.from(pageContainer?.querySelectorAll<HTMLElement>(
            '[data-annotation-id][data-annotation-kind="text-markup"]',
        ) ?? []).find(candidate => {
            const rect = candidate.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
        if (!entity) {
            return null;
        }
        const rect = entity.getBoundingClientRect();
        const hitStack = document.elementsFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
        ).map(candidate => ({
            annotationId: candidate.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId ?? null,
            className: candidate.getAttribute('class'),
            kind: candidate.closest<HTMLElement>('[data-annotation-kind]')?.dataset.annotationKind ?? null,
            page: candidate.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
            tag: candidate.tagName,
        }));
        return hitStack.map(candidate => candidate.annotationId)
            .find(candidate => candidate !== null && ids.has(candidate))
            ?? null;
    }, {
        annotationIds: [...annotationIds],
        pageNumber,
    });
}

async function waitForNewCanonicalEntity(
    page: Page,
    pageNumber: number,
    kind: TCanonicalKind,
    beforeIds: ReadonlySet<string>,
) {
    await page.waitForFunction((input: {
        beforeIds: string[];
        kind: TCanonicalKind;
        pageNumber: number;
    }) => Array.from(document.querySelectorAll<HTMLElement>(
        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]',
    )).some((entity) => (
        entity.dataset.annotationKind === input.kind
        && !input.beforeIds.includes(entity.dataset.annotationId ?? '')
        && Number(entity.closest<HTMLElement>('.page_container')?.dataset.page ?? 0) === input.pageNumber
    )), {timeout: 20_000}, {
        beforeIds: [...beforeIds],
        kind,
        pageNumber,
    });
    const created = (await readCanonicalEntities(page, pageNumber))
        .find(entity => entity.kind === kind && !beforeIds.has(entity.id));
    if (!created) {
        throw new Error(`Canonical ${kind} entity did not appear on page ${pageNumber}`);
    }
    return created;
}

async function resolveEditorLayerPoints(
    page: Page,
    pageNumber: number,
    ratios: ReadonlyArray<{
        x: number;
        y: number
    }>,
) {
    await waitForViewerInteractive(page, 30_000);
    await page.waitForFunction((targetPageNumber: number) => Boolean(
        globalThis.__evbE2E.getActiveWorkspaceHost(
            `.page_container[data-page="${targetPageNumber}"]`,
        )?.querySelector(
            `.page_container[data-page="${targetPageNumber}"] .pdf-annotation-editor-layer`,
        ),
    ), {timeout: 30_000}, pageNumber);
    return page.evaluate(async (input: {
        pageNumber: number;
        ratios: ReadonlyArray<{
            x: number;
            y: number
        }>;
    }) => {
        const pageSelector = `.page_container[data-page="${input.pageNumber}"]`;
        const host = globalThis.__evbE2E.getActiveWorkspaceHost(pageSelector);
        const pageContainer = host?.querySelector<HTMLElement>(pageSelector) ?? null;
        const layer = pageContainer?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
        if (!host || !pageContainer || !layer) {
            return null;
        }
        pageContainer.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

        const scrollViewport = layer.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
        if (scrollViewport) {
            const layerRect = layer.getBoundingClientRect();
            const hostRect = host.getBoundingClientRect();
            const visibleTop = Math.max(hostRect.top, 24);
            const visibleBottom = Math.min(hostRect.bottom, window.innerHeight - 24);
            if (visibleBottom > visibleTop) {
                const targetY = layerRect.top + layerRect.height * (input.ratios[0]?.y ?? 0.5);
                scrollViewport.scrollTop += targetY - ((visibleTop + visibleBottom) / 2);
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            }
        }

        const rect = layer.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        const minX = Math.min(...input.ratios.map(ratio => ratio.x));
        const minY = Math.min(...input.ratios.map(ratio => ratio.y));
        const maxX = Math.max(...input.ratios.map(ratio => ratio.x));
        const maxY = Math.max(...input.ratios.map(ratio => ratio.y));
        const width = maxX - minX;
        const height = maxY - minY;
        const origins = (maximum: number) => Array.from(
            {length: Math.floor((0.96 - maximum - 0.04) / 0.08) + 1},
            (_, index) => 0.04 + index * 0.08,
        );
        const toClientPoints = (origin: {
            x: number;
            y: number
        }) => input.ratios.map(ratio => ({
            x: rect.left + rect.width * (origin.x + ratio.x - minX),
            y: rect.top + rect.height * (origin.y + ratio.y - minY),
        }));
        const isAvailable = (point: {
            x: number;
            y: number
        }) => {
            const target = document.elementFromPoint(point.x, point.y);
            return Boolean(
                target
                && layer.contains(target)
                && !target.closest('[data-annotation-id]'),
            );
        };
        for (const originY of origins(height)) {
            for (const originX of origins(width)) {
                const candidate = toClientPoints({
                    x: originX,
                    y: originY,
                });
                if (candidate.every(isAvailable)) {
                    return candidate;
                }
            }
        }
        throw new Error('Could not find an unobstructed canonical shape area on the page');
    }, {
        pageNumber,
        ratios,
    });
}

async function createCanonicalShape(
    page: Page,
    tool: TCanonicalShapeTool,
    ratios: ReadonlyArray<{
        x: number;
        y: number
    }>,
    pageNumber = MATRIX_PAGE_NUMBER,
) {
    const before = await readCanonicalEntities(page, pageNumber);
    await clickAnnotationTool(page, tool);
    const points = await resolveEditorLayerPoints(page, pageNumber, ratios);
    if (!points || points.length < 2) {
        throw new Error(`Could not resolve canonical ${tool} points on page ${pageNumber}`);
    }
    const start = points[0]!;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const point of points.slice(1)) {
        await page.mouse.move(point.x, point.y, {steps: 6});
    }
    await page.mouse.up();
    return waitForNewCanonicalEntity(
        page,
        pageNumber,
        'shape',
        new Set(before.map(entity => entity.id)),
    );
}

async function clickCanonicalEntity(page: Page, id: string, pageNumber: number) {
    const input = {
        id,
        pageNumber,
    };
    await clickAnnotationTool(page, 'Select');
    await scrollViewerToPage(page, pageNumber);
    const pageSelector = `.editor-pane.is-active .page_container[data-page="${pageNumber}"]`;
    const markerRect = await page.$eval(
        `${pageSelector} .pdf-annotation-editor-layer [data-annotation-id="${id}"]`,
        (element) => {
            const entityRect = element.getBoundingClientRect();
            const pageRect = element.closest<HTMLElement>('.page_container')?.getBoundingClientRect();
            if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) {
                return null;
            }
            return {
                left: (entityRect.left - pageRect.left) / pageRect.width,
                top: (entityRect.top - pageRect.top) / pageRect.height,
                width: entityRect.width / pageRect.width,
                height: entityRect.height / pageRect.height,
            };
        },
    );
    if (!markerRect) {
        throw new Error(`Canonical entity page geometry was unavailable: ${id}`);
    }
    const annotationNavigation = await callWorkspaceCommand(
        page,
        'handleGoToPage',
        [
            pageNumber,
            {
                navigationSource: 'annotation',
                markerRect,
            },
        ],
    );
    if (annotationNavigation.called) {
        await waitForToolbarCurrentPage(page, pageNumber, 5_000);
        await waitForViewerInteractive(page, 10_000);
    }
    const kind = await page.$eval(
        `${pageSelector} .pdf-annotation-editor-layer [data-annotation-id="${id}"]`,
        element => element.getAttribute('data-annotation-kind'),
    );
    if (kind === 'note') {
        await page.focus(`.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${id}"]`);
        await page.keyboard.press('Enter');
        await page.waitForFunction((annotationId: string) => Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id].is-selected',
        )).some(candidate => candidate.dataset.annotationId === annotationId), {timeout: 10_000}, id);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        return;
    }
    try {
        await page.waitForFunction((selection: {
            id: string;
            pageNumber: number
        }) => {
            const entity = Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]',
            )).find(candidate => (
                candidate.dataset.annotationId === selection.id
                && Number(candidate.closest<HTMLElement>('.page_container')?.dataset.page ?? 0) === selection.pageNumber
            ));
            if (!entity) {
                return false;
            }
            const layer = entity.closest<HTMLElement>('.pdf-annotation-editor-layer');
            const viewer = layer?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            const rect = entity.getBoundingClientRect();
            return rect.width > 0
                && rect.height > 0
                && rect.top >= 0
                && rect.bottom <= window.innerHeight
                && viewer !== null
                && layer !== null
                && getComputedStyle(layer).pointerEvents !== 'none';
        }, {timeout: 10_000}, input);
    } catch (error) {
        const diagnostics = await page.evaluate((selection: {
            id: string;
            pageNumber: number
        }) => {
            const activeLayers = Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .pdf-annotation-editor-layer',
            ));
            const candidates = activeLayers.flatMap(layer => Array.from(layer.querySelectorAll<HTMLElement>(
                '[data-annotation-id][data-annotation-kind]',
            )).map(entity => {
                const rect = entity.getBoundingClientRect();
                const page = entity.closest<HTMLElement>('.page_container');
                const styles = getComputedStyle(entity);
                return {
                    annotationId: entity.dataset.annotationId ?? null,
                    bounds: {
                        bottom: rect.bottom,
                        height: rect.height,
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        width: rect.width,
                    },
                    className: entity.className,
                    isSelected: entity.classList.contains('is-selected'),
                    kind: entity.dataset.annotationKind ?? null,
                    page: page?.dataset.page ?? null,
                    pointerEvents: styles.pointerEvents,
                    visibility: {
                        display: styles.display,
                        opacity: styles.opacity,
                        visibility: styles.visibility,
                    },
                };
            }));
            const target = candidates.find(candidate => candidate.annotationId === selection.id);
            const point = target
                ? {
                    x: target.bounds.left + target.bounds.width / 2,
                    y: target.bounds.top + target.bounds.height / 2,
                }
                : null;
            const hit = point ? document.elementFromPoint(point.x, point.y) : null;
            const scrollContainers = Array.from(new Set([
                ...activeLayers.map(layer => layer.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')),
                ...activeLayers.map(layer => layer.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')),
            ].filter((element): element is HTMLElement => element !== null)));
            const describeContainer = (element: HTMLElement | null) => {
                if (!element) {
                    return null;
                }
                const rect = element.getBoundingClientRect();
                return {
                    bounds: {
                        bottom: rect.bottom,
                        height: rect.height,
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        width: rect.width,
                    },
                    className: element.className,
                    scrollHeight: element.scrollHeight,
                    scrollLeft: element.scrollLeft,
                    scrollTop: element.scrollTop,
                    scrollWidth: element.scrollWidth,
                };
            };
            return {
                activeLayerCount: activeLayers.length,
                activeLayerCandidates: candidates,
                elementFromPoint: hit
                    ? {
                        annotationId: hit.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId ?? null,
                        className: hit.className,
                        tagName: hit.tagName,
                    }
                    : null,
                expected: selection,
                pageContainers: Array.from(document.querySelectorAll<HTMLElement>(
                    '.editor-pane.is-active .page_container',
                )).map(page => {
                    const rect = page.getBoundingClientRect();
                    return {
                        bounds: {
                            bottom: rect.bottom,
                            height: rect.height,
                            left: rect.left,
                            right: rect.right,
                            top: rect.top,
                            width: rect.width,
                        },
                        page: page.dataset.page ?? null,
                    };
                }),
                point,
                scrollContainers: scrollContainers.map(describeContainer),
                target: target ?? null,
                viewport: {
                    devicePixelRatio: window.devicePixelRatio,
                    height: window.innerHeight,
                    width: window.innerWidth,
                },
            };
        }, input);
        throw new Error(`Canonical entity failed pre-click visibility: ${JSON.stringify(diagnostics)}`, {cause: error});
    }
    const point = await page.evaluate((selection: {
        id: string;
        pageNumber: number
    }) => {
        const entity = Array.from(document.querySelectorAll<HTMLElement>(
            `.editor-pane.is-active .page_container[data-page="${selection.pageNumber}"] .pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]`,
        )).find(candidate => (
            candidate.dataset.annotationId === selection.id
        ));
        if (!entity) {
            return null;
        }
        const rect = entity.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, input);
    if (!point) {
        throw new Error(`Canonical entity is not mounted: ${id}`);
    }
    await page.mouse.click(point.x, point.y);
    try {
        await page.waitForFunction((selection: {
            id: string;
            pageNumber: number
        }) => {
            const pageContainer = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .page_container[data-page="${selection.pageNumber}"]`,
            );
            return Array.from(pageContainer?.querySelectorAll<HTMLElement>(
                '.pdf-annotation-editor-layer [data-annotation-id].is-selected',
            ) ?? []).some(entity => entity.dataset.annotationId === selection.id);
        }, {timeout: 10_000}, {
            id,
            pageNumber,
        });
    } catch (error) {
        const diagnostics = await page.evaluate((selection: {
            id: string;
            pageNumber: number;
            point: {
                x: number;
                y: number
            }
        }) => {
            const pageContainer = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .page_container[data-page="${selection.pageNumber}"]`,
            );
            const layer = pageContainer?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
            const entity = layer
                ? Array.from(layer.querySelectorAll<HTMLElement>('[data-annotation-id][data-annotation-kind]'))
                    .find(candidate => candidate.dataset.annotationId === selection.id)
                : null;
            const actualPageContainer = entity?.closest<HTMLElement>('.page_container');
            const viewer = layer?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            const rect = entity?.getBoundingClientRect();
            const hit = document.elementFromPoint(selection.point.x, selection.point.y);
            return {
                entity: entity
                    ? {
                        bounds: rect ? {
                            bottom: rect.bottom,
                            height: rect.height,
                            left: rect.left,
                            right: rect.right,
                            top: rect.top,
                            width: rect.width,
                        } : null,
                        className: entity.className,
                        datasetKind: entity.dataset.annotationKind,
                        isSelected: entity.classList.contains('is-selected'),
                        pointerEvents: getComputedStyle(entity).pointerEvents,
                    }
                    : null,
                hit: hit
                    ? {
                        annotationId: (hit.closest<HTMLElement>('[data-annotation-id]'))?.dataset.annotationId ?? null,
                        className: hit.className,
                        tagName: hit.tagName,
                    }
                    : null,
                page: {
                    bounds: actualPageContainer?.getBoundingClientRect().toJSON() ?? null,
                    expectedPage: selection.pageNumber,
                    reportedPage: pageContainer?.dataset.page ?? null,
                },
                point: selection.point,
                viewport: {
                    devicePixelRatio: window.devicePixelRatio,
                    height: window.innerHeight,
                    width: window.innerWidth,
                },
                viewer: {
                    bounds: viewer?.getBoundingClientRect().toJSON() ?? null,
                    scrollHeight: viewer?.scrollHeight ?? null,
                    scrollLeft: viewer?.scrollLeft ?? null,
                    scrollTop: viewer?.scrollTop ?? null,
                    scrollWidth: viewer?.scrollWidth ?? null,
                },
            };
        }, {
            id,
            pageNumber,
            point,
        });
        throw new Error(`Canonical entity did not become selected: ${JSON.stringify(diagnostics)}`, {cause: error});
    }
}

async function focusCanonicalLayer(page: Page, pageNumber: number) {
    const selector = `.editor-pane.is-active .page_container[data-page="${pageNumber}"] .pdf-annotation-editor-layer`;
    await page.$eval(selector, element => (element as HTMLElement).focus({preventScroll: true}));
    await page.waitForFunction((expectedSelector: string) => (
        document.activeElement?.matches(expectedSelector) === true
    ), {timeout: 10_000}, selector);
}

async function moveCanonicalEntityWithKeyboard(page: Page, entity: ICanonicalEntitySnapshot) {
    await clickCanonicalEntity(page, entity.id, entity.pageNumber);
    const currentLeft = await page.$eval(
        `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${entity.id}"]`,
        element => element.getBoundingClientRect().left,
    );
    await focusCanonicalLayer(page, entity.pageNumber);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((input: {
        id: string;
        left: number
    }) => {
        const current = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id]',
        )).find(candidate => candidate.dataset.annotationId === input.id);
        return (current?.getBoundingClientRect().left ?? input.left) > input.left + 0.05;
    }, {timeout: 10_000}, {
        id: entity.id,
        left: currentLeft,
    });
}

async function deleteCanonicalEntityWithKeyboard(page: Page, entity: ICanonicalEntitySnapshot) {
    await clickCanonicalEntity(page, entity.id, entity.pageNumber);
    await focusCanonicalLayer(page, entity.pageNumber);
    await page.keyboard.press('Backspace');
    await page.waitForFunction((annotationId: string) => !Array.from(document.querySelectorAll<HTMLElement>(
        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id]',
    )).some(candidate => candidate.dataset.annotationId === annotationId), {timeout: 10_000}, entity.id);
}

async function dragCanonicalEntity(
    page: Page,
    entity: ICanonicalEntitySnapshot,
    delta: {
        x: number;
        y: number
    },
) {
    await clickCanonicalEntity(page, entity.id, entity.pageNumber);
    const point = await page.evaluate((annotationId: string) => {
        const current = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id]',
        )).find(candidate => candidate.dataset.annotationId === annotationId);
        const rect = current?.getBoundingClientRect();
        return rect
            ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                left: rect.left,
                top: rect.top,
            }
            : null;
    }, entity.id);
    if (!point) {
        throw new Error(`Canonical entity disappeared before drag: ${entity.id}`);
    }
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + delta.x, point.y + delta.y, {steps: 8});
    await page.mouse.up();
    await page.waitForFunction((input: {
        id: string;
        left: number;
        top: number
    }) => {
        const current = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id]',
        )).find(candidate => candidate.dataset.annotationId === input.id);
        const rect = current?.getBoundingClientRect();
        return rect !== undefined
            && Math.abs(rect.left - input.left) > 4
            && Math.abs(rect.top - input.top) > 4;
    }, {timeout: 10_000}, {
        id: entity.id,
        left: point.left,
        top: point.top,
    });
}

async function assertAnnotationStoreClean(page: Page) {
    const state = await readWorkspaceStateValues<{dirtyState?: {annotationDirtyEntityCount?: number;}}>(page, ['dirtyState']);
    expect(state.dirtyState?.annotationDirtyEntityCount ?? 0).toBe(0);
}

async function saveCanonicalRevision(page: Page, documentPath: string, label: string) {
    const event = await saveViaVisibleToolbarWithDeadline(
        page,
        NATIVE_SAVE_TIMEOUT_MS,
        documentPath,
        {label},
    );
    expect(event.detail.documentRevisionToken).toEqual(expect.any(String));
    await execFileAsync('qpdf', [
        '--check',
        documentPath,
    ], {timeout: 60_000});
    return event.detail.documentRevisionToken;
}

async function hardRestartAfterSave(
    sessionFixture: ReturnType<typeof createElectronE2ESessionFixture>,
    session: {name: string},
    documentPath: string,
) {
    const checkpointTab = await waitForCrashCheckpoint(session.name, documentPath);
    expect(checkpointTab).toMatchObject({
        isDirty: false,
        sourceRef: documentPath,
    });
    const restarted = await sessionFixture.restart({
        clean: false,
        hard: true,
        keepNuxt: true,
    });
    if (!restarted) {
        throw new Error(`Hard restart failed for ${documentPath}`);
    }
    await waitForPdfLoaded(restarted.page, MATRIX_TIMEOUT_MS);
    await waitForViewerInteractive(restarted.page, MATRIX_TIMEOUT_MS);
    return restarted;
}

async function installManagedJpegClipboard(page: Page, imagePath: string) {
    const probe = await page.evaluate(async (input: {imagePath: string}) => {
        const files = window.electronAPI?.documentFiles;
        if (!files?.createManagedTempFileHandle) {
            throw new Error('Managed image handles are unavailable');
        }
        const handle = await files.createManagedTempFileHandle(input.imagePath);
        const NativeFile = window.File;
        const ManagedFile = new Proxy(NativeFile, {construct(target, args) {
            return Object.assign(Reflect.construct(target, args), {nativeSourceHandle: handle});
        }});
        Object.defineProperty(window, 'File', {
            configurable: true,
            value: ManagedFile,
        });
        const bytes = await files.readFile(input.imagePath);
        const blob = new Blob([bytes as BlobPart], {type: 'image/jpeg'});
        const probeFile = new ManagedFile([blob], 'clipboard-probe.jpg', {type: 'image/jpeg'});
        const bitmap = await createImageBitmap(probeFile);
        const dimensions = {
            height: bitmap.height,
            width: bitmap.width,
        };
        bitmap.close();
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {read: async () => [{
                types: ['image/jpeg'],
                getType: async () => blob,
            }]},
        });
        return {
            dimensions,
            hasNativeSourceHandle: 'nativeSourceHandle' in probeFile,
        };
    }, {imagePath});
    expect(probe).toEqual({
        dimensions: {
            height: 40,
            width: 64,
        },
        hasNativeSourceHandle: true,
    });
}

async function pasteImageFromVisibleMenu(page: Page, pageNumber: number) {
    await page.waitForFunction((targetPage: number) => {
        const pageContainer = document.querySelector<HTMLElement>(
            `.editor-pane.is-active .page_container[data-page="${targetPage}"]`,
        );
        const rect = pageContainer?.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
    }, {timeout: 5_000}, pageNumber);
    const command = await callWorkspaceCommand(page, 'handlePasteImageFromClipboard');
    if (!command.called) {
        throw new Error('Electron paste-image menu command was not available');
    }
    if (command.value !== true) {
        throw new Error(`Electron paste-image command did not start placement: ${JSON.stringify(command)}`);
    }
    await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
        timeout: 30_000,
        visible: true,
    });
}

async function finalizeImagePlacement(page: Page) {
    await page.click(`${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__action--primary`);
    await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
        hidden: true,
        timeout: 60_000,
    });
}

async function resizeCanonicalEntity(
    page: Page,
    entity: ICanonicalEntitySnapshot,
    delta: {
        x: number;
        y: number
    },
) {
    await clickCanonicalEntity(page, entity.id, entity.pageNumber);
    const before = await page.$eval(
        `.editor-pane.is-active .page_container[data-page="${entity.pageNumber}"] `
        + `.pdf-annotation-editor-layer [data-annotation-id="${entity.id}"]`,
        element => {
            const rect = element.getBoundingClientRect();
            return {
                height: rect.height,
                width: rect.width,
            };
        },
    );
    const handleSelector = `.editor-pane.is-active .page_container[data-page="${entity.pageNumber}"] `
        + '.pdf-annotation-selection-handle--se';
    const point = await page.$eval(handleSelector, element => {
        const rect = element.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + delta.x, point.y + delta.y, {steps: 8});
    await page.mouse.up();
    await page.waitForFunction((input: {
        id: string;
        pageNumber: number;
        width: number;
        height: number
    }) => {
        const selector = `.editor-pane.is-active .page_container[data-page="${input.pageNumber}"] `
            + `.pdf-annotation-editor-layer [data-annotation-id="${input.id}"]`;
        const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        return rect !== undefined && rect.width > input.width + 10 && rect.height > input.height + 5;
    }, {timeout: 10_000}, {
        ...entity,
        ...before,
    });
}

largePdfDescribe('Electron E2E - exact large PDF canonical annotation matrix', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-issue-192-canonical-matrix-${Date.now()}`,
        timeoutMs: MATRIX_TIMEOUT_MS,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
    });

    it('creates, updates, deletes, recreates, saves, and hard-reopens canonical annotations', async () => {
        let session = sessionFixture.getSession();
        if (!session || !fixture.path) {
            throw new Error(`Exact large fixture is unavailable: ${fixture.reason}`);
        }
        const sourceIdentity = await readExactPdfFixtureIdentity(fixture.path, {timeoutMs: MATRIX_TIMEOUT_MS});
        validateExactPdfFixtureIdentity(sourceIdentity, exactFixtureExpectation);
        expect(sourceIdentity.pages).toBe(882);
        const documentPath = copyExactFixture(fixture.path);

        await openPdfInApp(session.page, documentPath, MATRIX_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, MATRIX_TIMEOUT_MS);
        await scrollViewerToPage(session.page, MATRIX_PAGE_NUMBER);
        await openAnnotationsTab(session.page, 30_000);
        const initialWorkingCopyPath = await readWorkingCopyPath(session.page);
        const initialIndex = await readAnnotationIndex(session.page, initialWorkingCopyPath);
        const initialShapes = await readShapeIndex(session.page, initialWorkingCopyPath);

        const beforeNote = await readCanonicalEntities(session.page, MATRIX_PAGE_NUMBER);
        await createStickyNoteWithPointer(session.page, 'issue 192 canonical note', {
            x: 0.78,
            y: 0.78,
        }, MATRIX_PAGE_NUMBER);
        await clickLatestVisibleNoteWindowClose(session.page);
        await waitForNoOpenNoteWindows(session.page);
        const note = await waitForNewCanonicalEntity(
            session.page,
            MATRIX_PAGE_NUMBER,
            'note',
            new Set(beforeNote.map(entity => entity.id)),
        );

        const beforeTextBox = await readCanonicalEntities(session.page, MATRIX_PAGE_NUMBER);
        await createCanonicalTextBoxWithPointer(
            session.page,
            'issue 192 canonical text box',
            {
                x: 0.22,
                y: 0.76,
            },
            MATRIX_PAGE_NUMBER,
        );
        const textBox = await waitForNewCanonicalEntity(
            session.page,
            MATRIX_PAGE_NUMBER,
            'text-box',
            new Set(beforeTextBox.map(entity => entity.id)),
        );
        const textBoxId = textBox.id;
        expect(textBoxId).toMatch(/^anno_/u);

        const markupIds: string[] = [];
        for (const tool of [
            'Highlight',
            'Underline',
            'Strikethrough',
            'Squiggly',
        ] as const) {
            const before = await readCanonicalEntities(session.page, MATRIX_PAGE_NUMBER);
            await createCanonicalTextMarkup(session.page, tool, {
                startPage: MATRIX_PAGE_NUMBER,
                startSpan: 0,
                endPage: MATRIX_PAGE_NUMBER,
                endSpan: 0,
            });
            await clearTextSelection(session.page);
            const markup = await waitForNewCanonicalEntity(
                session.page,
                MATRIX_PAGE_NUMBER,
                'text-markup',
                new Set(before.map(entity => entity.id)),
            );
            markupIds.push(markup.id);
        }

        const shapeIds: string[] = [];
        const shapeCases: Array<{
            tool: TCanonicalShapeTool;
            ratios: ReadonlyArray<{
                x: number;
                y: number
            }>
        }> = [
            {
                tool: 'Rectangle',
                ratios: [
                    {
                        x: 0.08,
                        y: 0.42,
                    },
                    {
                        x: 0.18,
                        y: 0.5,
                    },
                ],
            },
            {
                tool: 'Circle',
                ratios: [
                    {
                        x: 0.24,
                        y: 0.42,
                    },
                    {
                        x: 0.34,
                        y: 0.5,
                    },
                ],
            },
            {
                tool: 'Line',
                ratios: [
                    {
                        x: 0.42,
                        y: 0.42,
                    },
                    {
                        x: 0.56,
                        y: 0.5,
                    },
                ],
            },
            {
                tool: 'Arrow',
                ratios: [
                    {
                        x: 0.64,
                        y: 0.42,
                    },
                    {
                        x: 0.78,
                        y: 0.5,
                    },
                ],
            },
            {
                tool: 'Draw',
                ratios: [
                    {
                        x: 0.1,
                        y: 0.58,
                    },
                    {
                        x: 0.15,
                        y: 0.63,
                    },
                    {
                        x: 0.22,
                        y: 0.59,
                    },
                ],
            },
        ];
        for (const shapeCase of shapeCases) {
            const shape = await createCanonicalShape(session.page, shapeCase.tool, shapeCase.ratios);
            shapeIds.push(shape.id);
        }

        const firstSaveToken = await saveCanonicalRevision(
            session.page,
            documentPath,
            'issue 192 canonical annotation create save',
        );
        const firstSavedPath = await readWorkingCopyPath(session.page);
        expect(firstSavedPath).toBe(initialWorkingCopyPath);
        const firstIndex = await readAnnotationIndex(session.page, firstSavedPath);
        const firstShapes = await readShapeIndex(session.page, firstSavedPath);
        expect(firstIndex.revisionToken).toBe(firstSaveToken);
        for (const [
            subtype,
            expectedDelta,
        ] of Object.entries({
                FreeText: 1,
                Highlight: 1,
                Squiggly: 1,
                StrikeOut: 1,
                Text: 1,
                Underline: 1,
            })) {
            expect(countAddedAnnotationSubtype(initialIndex.entries, firstIndex.entries, subtype)).toBe(expectedDelta);
        }
        const addedEntries = diffAnnotationEntries(initialIndex.entries, firstIndex.entries)
            .filter(entry => entry.pageIndex === MATRIX_PAGE_INDEX);
        const noteEntry = addedEntries.find(entry => entry.subtype === 'Text');
        const textBoxEntry = addedEntries.find(entry => entry.subtype === 'FreeText');
        expect(noteEntry).toBeDefined();
        expect(textBoxEntry).toBeDefined();
        expect(qpdfObjectContainsText(
            await readObject(documentPath, {
                objectNumber: noteEntry!.objectNumber,
                generationNumber: noteEntry!.generationNumber,
            }),
            'issue 192 canonical note',
        )).toBe(true);
        expect(qpdfObjectContainsText(
            await readObject(documentPath, {
                objectNumber: textBoxEntry!.objectNumber,
                generationNumber: textBoxEntry!.generationNumber,
            }),
            'issue 192 canonical text box',
        )).toBe(true);

        const addedShapes = addedPageShapes(initialShapes, firstShapes);
        expect(addedShapes).toHaveLength(5);
        expect(addedShapes.filter(entry => entry.pdfSubtype === 'Square')).toHaveLength(1);
        expect(addedShapes.filter(entry => entry.pdfSubtype === 'Circle')).toHaveLength(1);
        expect(addedShapes.filter(entry => entry.pdfSubtype === 'Line')).toHaveLength(2);
        expect(addedShapes.filter(entry => entry.pdfSubtype === 'Ink')).toHaveLength(1);
        await assertAnnotationStoreClean(session.page);

        session = await hardRestartAfterSave(sessionFixture, session, documentPath);
        await scrollViewerToPage(session.page, MATRIX_PAGE_NUMBER);
        await openAnnotationsTab(session.page, 30_000);
        let reopenedEntities = await readCanonicalEntities(session.page, MATRIX_PAGE_NUMBER);
        expect(reopenedEntities.filter(entity => entity.kind === 'note')).not.toHaveLength(0);
        expect(reopenedEntities.filter(entity => entity.kind === 'text-box')).not.toHaveLength(0);
        expect(reopenedEntities.filter(entity => entity.kind === 'text-markup')).toHaveLength(4);
        expect(reopenedEntities.filter(entity => entity.kind === 'shape')).toHaveLength(5);
        await assertAnnotationStoreClean(session.page);

        for (const kind of [
            'note',
            'text-box',
            'text-markup',
            'shape',
        ] as const) {
            let entity: ICanonicalEntitySnapshot | undefined;
            if (kind === 'text-markup') {
                await scrollViewerToPage(session.page, MATRIX_PAGE_NUMBER);
                const topmost = await readTopmostCanonicalTextMarkupId(
                    session.page,
                    MATRIX_PAGE_NUMBER,
                    reopenedEntities.filter(candidate => candidate.kind === kind).map(candidate => candidate.id),
                );
                entity = reopenedEntities.find(candidate => candidate.id === topmost);
            } else {
                entity = reopenedEntities.find(candidate => candidate.kind === kind);
            }
            if (!entity) {
                throw new Error(`Reopened canonical ${kind} is missing`);
            }
            await moveCanonicalEntityWithKeyboard(session.page, entity);
        }

        const shapeToDelete = reopenedEntities.find(entity => entity.kind === 'shape');
        if (!shapeToDelete) {
            throw new Error('No reopened canonical shape was available for deletion');
        }
        await deleteCanonicalEntityWithKeyboard(session.page, shapeToDelete);
        const replacementShape = await createCanonicalShape(
            session.page,
            'Rectangle',
            [
                {
                    x: 0.82,
                    y: 0.62,
                },
                {
                    x: 0.92,
                    y: 0.72,
                },
            ],
        );
        expect(replacementShape.kind).toBe('shape');

        const secondSaveToken = await saveCanonicalRevision(
            session.page,
            documentPath,
            'issue 192 canonical annotation update delete recreate save',
        );
        const secondWorkingCopyPath = await readWorkingCopyPath(session.page);
        const secondIndex = await readAnnotationIndex(session.page, secondWorkingCopyPath);
        const secondShapes = await readShapeIndex(session.page, secondWorkingCopyPath);
        expect(secondIndex.revisionToken).toEqual(secondSaveToken);
        expect(countAnnotationSubtype(secondIndex.entries, 'Text')).toBe(countAnnotationSubtype(firstIndex.entries, 'Text'));
        expect(countAnnotationSubtype(secondIndex.entries, 'FreeText')).toBe(countAnnotationSubtype(firstIndex.entries, 'FreeText'));
        expect(pageShapes(secondShapes)).toHaveLength(pageShapes(firstShapes).length);
        await assertAnnotationStoreClean(session.page);

        session = await hardRestartAfterSave(sessionFixture, session, documentPath);
        await scrollViewerToPage(session.page, MATRIX_PAGE_NUMBER);
        await openAnnotationsTab(session.page, 30_000);
        reopenedEntities = await readCanonicalEntities(session.page, MATRIX_PAGE_NUMBER);
        expect(reopenedEntities.filter(entity => entity.kind === 'shape')).toHaveLength(5);
        expect(reopenedEntities.filter(entity => entity.id === shapeToDelete.id)).toHaveLength(0);
        expect(reopenedEntities.filter(entity => entity.kind === 'text-markup')).toHaveLength(4);
        await assertAnnotationStoreClean(session.page);

        expect(textBoxId).toMatch(/^anno_/u);
        expect(note.id).toMatch(/^anno_/u);
        expect(markupIds).toHaveLength(4);
        expect(shapeIds).toHaveLength(5);
    }, MATRIX_TIMEOUT_MS);

    it('creates, moves, deletes, saves, and hard-reopens a placed image through the canonical layer', async () => {
        let session = await sessionFixture.restart({clean: true});
        if (!session || !fixture.path) {
            throw new Error(`Exact large fixture is unavailable: ${fixture.reason}`);
        }
        const sourceIdentity = await readExactPdfFixtureIdentity(fixture.path, {timeoutMs: MATRIX_TIMEOUT_MS});
        validateExactPdfFixtureIdentity(sourceIdentity, exactFixtureExpectation);
        expect(sourceIdentity.pages).toBe(882);
        const documentPath = copyExactFixture(fixture.path);

        await openPdfInApp(session.page, documentPath, MATRIX_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, MATRIX_TIMEOUT_MS);
        await scrollViewerToPage(session.page, PLACED_IMAGE_PAGE_NUMBER);
        await openAnnotationsTab(session.page, 30_000);
        const initialWorkingCopyPath = await readWorkingCopyPath(session.page);
        const initialIndex = await readAnnotationIndex(session.page, initialWorkingCopyPath);
        const imagePath = join(dirname(initialWorkingCopyPath), `issue-192-placed-image-${process.pid}.jpg`);
        writeFileSync(imagePath, PLACED_IMAGE_JPEG);
        onTestFinished(() => rmSync(imagePath, {force: true}));
        await installManagedJpegClipboard(session.page, imagePath);

        const beforeImage = await readCanonicalEntities(session.page, PLACED_IMAGE_PAGE_NUMBER);
        await pasteImageFromVisibleMenu(session.page, PLACED_IMAGE_PAGE_NUMBER);
        await finalizeImagePlacement(session.page);
        const image = await waitForNewCanonicalEntity(
            session.page,
            PLACED_IMAGE_PAGE_NUMBER,
            'placed-image',
            new Set(beforeImage.map(entity => entity.id)),
        );
        expect(image.id).toMatch(/^placed-image-/u);
        await dragCanonicalEntity(session.page, image, {
            x: 52,
            y: 34,
        });
        await resizeCanonicalEntity(session.page, image, {
            x: 46,
            y: 28,
        });

        const firstSaveToken = await saveCanonicalRevision(
            session.page,
            documentPath,
            'issue 192 canonical placed-image create save',
        );
        const firstSavedPath = await readWorkingCopyPath(session.page);
        expect(firstSavedPath).toBe(initialWorkingCopyPath);
        const firstIndex = await readAnnotationIndex(session.page, firstSavedPath);
        expect(firstIndex.revisionToken).toBe(firstSaveToken);
        const addedStamps = diffAnnotationEntries(initialIndex.entries, firstIndex.entries)
            .filter(entry => entry.pageIndex === PLACED_IMAGE_PAGE_INDEX && entry.subtype === 'Stamp');
        expect(addedStamps).toHaveLength(1);
        const stampEntry = addedStamps[0]!;
        expect(stampEntry.name).toMatch(/^placed-image-/u);
        const stampObject = await readObject(documentPath, {
            objectNumber: stampEntry.objectNumber,
            generationNumber: stampEntry.generationNumber,
        });
        expect(stampObject).toContain('/Subtype /Stamp');
        await assertAnnotationStoreClean(session.page);

        session = await hardRestartAfterSave(sessionFixture, session, documentPath);
        await scrollViewerToPage(session.page, PLACED_IMAGE_PAGE_NUMBER);
        await openAnnotationsTab(session.page, 30_000);
        let reopenedImage = (await readCanonicalEntities(session.page, PLACED_IMAGE_PAGE_NUMBER))
            .find(entity => entity.kind === 'placed-image');
        if (!reopenedImage) {
            throw new Error('Placed image did not reopen in the canonical editor layer');
        }
        await dragCanonicalEntity(session.page, reopenedImage, {
            x: 32,
            y: 22,
        });
        const secondSaveToken = await saveCanonicalRevision(
            session.page,
            documentPath,
            'issue 192 canonical placed-image update save',
        );
        const secondWorkingCopyPath = await readWorkingCopyPath(session.page);
        const secondIndex = await readAnnotationIndex(session.page, secondWorkingCopyPath);
        expect(secondIndex.revisionToken).toBe(secondSaveToken);
        expect(secondIndex.entries.filter(entry => (
            entry.pageIndex === PLACED_IMAGE_PAGE_INDEX
            && entry.subtype === 'Stamp'
            && entry.name === stampEntry.name
        ))).toHaveLength(1);
        await assertAnnotationStoreClean(session.page);

        session = await hardRestartAfterSave(sessionFixture, session, documentPath);
        await scrollViewerToPage(session.page, PLACED_IMAGE_PAGE_NUMBER);
        await openAnnotationsTab(session.page, 30_000);
        reopenedImage = (await readCanonicalEntities(session.page, PLACED_IMAGE_PAGE_NUMBER))
            .find(entity => entity.kind === 'placed-image');
        if (!reopenedImage) {
            throw new Error('Updated placed image did not reopen in the canonical editor layer');
        }
        await deleteCanonicalEntityWithKeyboard(session.page, reopenedImage);
        const deletedSaveToken = await saveCanonicalRevision(
            session.page,
            documentPath,
            'issue 192 canonical placed-image delete save',
        );
        const deletedWorkingCopyPath = await readWorkingCopyPath(session.page);
        const deletedIndex = await readAnnotationIndex(session.page, deletedWorkingCopyPath);
        expect(deletedIndex.revisionToken).toBe(deletedSaveToken);
        expect(deletedIndex.entries.filter(entry => entry.name === stampEntry.name)).toHaveLength(0);
        await assertAnnotationStoreClean(session.page);

        session = await hardRestartAfterSave(sessionFixture, session, documentPath);
        await scrollViewerToPage(session.page, PLACED_IMAGE_PAGE_NUMBER);
        await openAnnotationsTab(session.page, 30_000);
        expect((await readCanonicalEntities(session.page, PLACED_IMAGE_PAGE_NUMBER))
            .filter(entity => entity.kind === 'placed-image')).toHaveLength(0);
        await assertAnnotationStoreClean(session.page);
    }, MATRIX_TIMEOUT_MS);
});
