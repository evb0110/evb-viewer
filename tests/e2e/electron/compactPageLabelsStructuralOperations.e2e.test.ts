import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import type {TLegacyDocumentRef} from '@contracts/documentRef';
import type {TRequestId} from '@contracts/shared';
import type {IEvbTestApi} from '@app/types/evbTestApi';
import {
    createCompactPageLabelsFixturePdf,
    createMultiPageTextFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    readWorkspaceStateValues,
    requireWorkspaceCommand,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
    waitForViewerInteractive,
    ensureSidebarOpen,
    goToPageViaToolbar,
    openDocumentSidebarTab,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForAnimationFrames} from '@tests/e2e/electron/helpers/viewerVirtualizationContract';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';

const PAGE_COUNT = 201;
const TEST_TIMEOUT_MS = 10 * 60 * 1_000;

interface IPageMutationFrame {
    elapsedMs: number;
    /** Top of the rotated page relative to the viewport; null when unmounted. */
    pageTopInViewport: number | null;
    msSinceClick: number | null;
    toolbar: string | null;
    zoom: string | null;
    fitWidth: boolean;
    sidebar: {
        left: number;
        width: number;
        height: number
    } | null;
    generation: string | null;
    revision: string | null;
    phase: string | null;
    viewportLifecycle: string | null;
    pageRect: {
        width: number;
        height: number
    } | null;
    canvasSizes: Array<[number, number]>;
    mainRaster: {
        painted: boolean;
        inkPixels: number;
        contentAspect: number | null;
        aspectError: number | null;
    };
    targetThumbnailPainted: boolean;
    targetThumbnail: {
        frameLandscape: boolean | null;
        bitmapLandscape: boolean | null;
    };
    pageSkeletonVisible: boolean;
    neighbourThumbnails: Array<{
        page: number;
        label: string | null;
        painted: boolean;
        sameCanvas: boolean;
        canvasSize: [number, number] | null;
        renderKey: string | null;
        sameRenderKey: boolean;
        rendered: boolean;
        preserved: boolean
    }>;
    scrollTop: number | null;
    operationBusy: boolean | null;
}

interface IPageMutationProbeFields {
    __pageMutationBaselineCanvases?: Map<number, HTMLCanvasElement>;
    __pageMutationBaselineRenderKeys?: Map<number, string | null>;
    __pageMutationCanvasResets?: Array<{
        page: number;
        stack: string | null
    }>;
    __pageMutationFrames?: IPageMutationFrame[];
    __pageMutationSampling?: boolean;
    __pageMutationFirstLandscapeRasterAt?: number | null;
    __pageMutationClickAt?: number | null;
    __pageMutationLastZoom?: string | null;
    __pageMutationLastZoomChangeAt?: number | null;
}

type TPageMutationProbeWindow = Window & IPageMutationProbeFields;

const initialRanges: IPdfPageLabelRange[] = [
    {
        startPage: 1,
        style: 'r',
        prefix: '',
        startNumber: 1,
    },
    {
        startPage: 41,
        style: 'D',
        prefix: 'Main-',
        startNumber: 1,
    },
    {
        startPage: 101,
        style: 'R',
        prefix: '',
        startNumber: 1,
    },
    {
        startPage: 151,
        style: 'a',
        prefix: 'Appendix-',
        startNumber: 1,
    },
];

function toRoman(value: number) {
    const parts: Array<[number, string]> = [
        [
            1000,
            'M',
        ],
        [
            900,
            'CM',
        ],
        [
            500,
            'D',
        ],
        [
            400,
            'CD',
        ],
        [
            100,
            'C',
        ],
        [
            90,
            'XC',
        ],
        [
            50,
            'L',
        ],
        [
            40,
            'XL',
        ],
        [
            10,
            'X',
        ],
        [
            9,
            'IX',
        ],
        [
            5,
            'V',
        ],
        [
            4,
            'IV',
        ],
        [
            1,
            'I',
        ],
    ];
    let remaining = value;
    let result = '';
    for (const [
        unit,
        symbol,
    ] of parts) {
        while (remaining >= unit) {
            result += symbol;
            remaining -= unit;
        }
    }
    return result;
}

function toAlpha(value: number) {
    if (value < 1) {
        return '';
    }
    const letter = String.fromCharCode(65 + ((value - 1) % 26));
    const repeatCount = Math.floor((value - 1) / 26) + 1;
    return letter.repeat(repeatCount);
}

function labelForPage(page: number, ranges: readonly IPdfPageLabelRange[]) {
    const range = ranges.reduce((current, candidate) => (
        candidate.startPage <= page ? candidate : current
    ));
    const number = range.startNumber + page - range.startPage;
    const value = range.style === 'r'
        ? toRoman(number).toLowerCase()
        : range.style === 'R'
            ? toRoman(number)
            : range.style === 'a'
                ? toAlpha(number).toLowerCase()
                : range.style === 'A'
                    ? toAlpha(number)
                    : String(number);
    return `${range.prefix}${value}`;
}

function labelsFromRanges(totalPages: number, ranges: readonly IPdfPageLabelRange[]) {
    return Array.from({length: totalPages}, (_, index) => labelForPage(index + 1, ranges));
}

async function waitForLabels(session: IElectronE2ESession, expected: readonly string[]) {
    await expect.poll(async () => {
        let state: {
            pageLabels?: string[] | Record<string, string> | null;
            pageLabelRanges?: IPdfPageLabelRange[];
            pageLabelsResolved?: boolean;
        };
        try {
            state = await readWorkspaceStateValues<{
                pageLabels?: string[] | Record<string, string> | null;
                pageLabelRanges?: IPdfPageLabelRange[];
                pageLabelsResolved?: boolean;
            }>(session.page, [
                'pageLabels',
                'pageLabelRanges',
                'pageLabelsResolved',
            ]);
        } catch {
            return null;
        }
        if (state.pageLabelsResolved !== true || state.pageLabels !== null) {
            return null;
        }
        const ranges = state.pageLabelRanges ?? [];
        return labelsFromRanges(expected.length, ranges);
    }, {timeout: 60_000}).toEqual(expected);
}

async function waitForSemanticLabels(session: IElectronE2ESession, expected: readonly string[]) {
    await expect.poll(async () => {
        try {
            const state = await readWorkspaceStateValues<{
                pageLabels?: string[] | Record<string, string> | null;
                pageLabelRanges?: IPdfPageLabelRange[];
                totalPages?: number;
                pageLabelsResolved?: boolean;
            }>(session.page, [
                'pageLabels',
                'pageLabelRanges',
                'totalPages',
                'pageLabelsResolved',
            ]);
            if (state.pageLabelsResolved !== true) {
                return false;
            }
            if (state.pageLabels === null) {
                return labelsFromRanges(expected.length, state.pageLabelRanges ?? []);
            }
            const labels = Array.isArray(state.pageLabels)
                ? state.pageLabels
                : Object.values(state.pageLabels as Record<string, string>);
            return labels.length === expected.length
                && state.totalPages === expected.length
                ? labels
                : false;
        } catch {
            return false;
        }
    }, {timeout: 60_000}).toEqual(expected);
}

async function waitForPageOperation(session: IElectronE2ESession) {
    const readProgress = async () => {
        try {
            return (await readWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(
                session.page,
                ['isPageOperationInProgress'],
            )).isPageOperationInProgress;
        } catch {
            return undefined;
        }
    };
    await expect.poll(readProgress, {timeout: 20_000}).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10_000));
}

async function waitForPageOperationComplete(session: IElectronE2ESession) {
    await expect.poll(async () => {
        try {
            return (await readWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(
                session.page,
                ['isPageOperationInProgress'],
            )).isPageOperationInProgress;
        } catch {
            return undefined;
        }
    }, {timeout: 60_000}).toBe(false);
}

async function runCommand<T>(session: IElectronE2ESession, name: string, args: unknown[]) {
    if ([
        'handleSave',
        'handlePageDelete',
        'handlePageReorder',
        'handlePageMove',
    ].includes(name)) {
        const value = await requireWorkspaceCommand<T>(session.page, name, args);
        if (name === 'handleSave') {
            return value;
        }
        await waitForPageOperation(session);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        return value;
    }
    const called = await session.page.evaluate((payload: {
        args: unknown[];
        name: string
    }) => {
        const api = (window as Window & {__evbTestApi?: IEvbTestApi}).__evbTestApi;
        if (!api) {
            return false;
        }
        void api.callActiveWorkspaceCommand(payload.name, payload.args).catch(() => undefined);
        return true;
    }, {
        args,
        name,
    });
    expect(called, `${name} should be exposed`).toBe(true);
    if (name !== 'handleSave') {
        await waitForPageOperation(session);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
    }
    return null as T | null;
}

async function insertOnePageThroughGrantedNative(
    session: IElectronE2ESession,
    sourcePath: string,
) {
    const granted = await session.page.evaluate(async path => {
        const grant = (window as IE2EWindow & {__allowRendererFileOpenForAutomation?: (value: TLegacyDocumentRef) => Promise<boolean>;}).__allowRendererFileOpenForAutomation;
        return typeof grant === 'function' && await grant(path as TLegacyDocumentRef);
    }, sourcePath);
    expect(granted, 'insert source path automation grant').toBe(true);

    const afterPage = 200;
    const result = await session.page.evaluate(async ({
        source, after,
    }) => {
        const api = (window as IE2EWindow).electronAPI;
        if (!api) {
            throw new Error('electronAPI is unavailable');
        }
        const state = (window as IE2EWindow).__evbTestApi?.readActiveWorkspaceStateValues(['workingCopyPath']);
        const path = state && typeof state.workingCopyPath === 'string' ? state.workingCopyPath : null;
        if (!path) {
            throw new Error('active working copy path is unavailable');
        }
        const revision = await api.documentFiles.getDocumentRevision(path as TLegacyDocumentRef);
        return api.pageOps.insertFile(path, 200, after, [source], 'compact-label-positive-insert' as TRequestId, {expectedDocumentRevisionToken: revision?.token});
    }, {
        source: sourcePath,
        after: afterPage,
    });
    expect(result.success, 'positive page insertion must complete').toBe(true);
    return afterPage;
}

describe('Electron E2E, compact page labels through structural operations', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('keeps every compact label through mutations, save, and reopen', async () => {
        const pdfPath = await createCompactPageLabelsFixturePdf(
            `compact-page-labels-${Date.now()}.pdf`,
            PAGE_COUNT,
        );
        const insertionSourcePath = await createMultiPageTextFixturePdf(
            `compact-page-labels-insert-${Date.now()}.pdf`,
            1,
        );
        let expected = labelsFromRanges(PAGE_COUNT, initialRanges);
        session = await startElectronE2ESession(`e2e-compact-page-labels-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await waitForLabels(session, expected);

        await runCommand(session, 'handlePageRotate', [
            [1],
            90,
        ]);
        await waitForPageOperationComplete(session);

        await runCommand(session, 'handlePageDelete', [[20]]);
        expected = expected.filter((_, index) => index !== 19);
        await waitForSemanticLabels(session, expected);
        const denseCheckpoint = await readWorkspaceStateValues<{
            pageLabels?: string[] | Record<string, string> | null;
            totalPages?: number;
        }>(session.page, [
            'pageLabels',
            'totalPages',
        ]);
        expect(denseCheckpoint.totalPages).toBe(200);
        expect(denseCheckpoint.pageLabels).not.toBeNull();

        const reorder = Array.from({length: expected.length}, (_, index) => index + 1);
        [
            reorder[29],
            reorder[30],
        ] = [
            reorder[30]!,
            reorder[29]!,
        ];
        expected = reorder.map(page => expected[page - 1]!);
        await runCommand(session, 'handlePageReorder', [reorder]);

        await runCommand(session, 'handleCropPages', [
            [40],
            {
                top: 5,
                bottom: 5,
                left: 5,
                right: 5,
            },
        ]);

        const move = {
            pageCount: expected.length,
            startPage: 50,
            endPage: 50,
            insertAt: 120,
        };
        const moved = expected.splice(move.startPage - 1, 1)[0]!;
        expected.splice(move.insertAt - 1, 0, moved);
        await runCommand(session, 'handlePageMove', [move]);

        const insertionAfterPage = await insertOnePageThroughGrantedNative(session, insertionSourcePath);
        expected.splice(insertionAfterPage, 0, '1');

        await runCommand(session, 'handleSave', []);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-compact-page-labels-reopen-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await waitForSemanticLabels(session, expected);
        const finalState = await readWorkspaceStateValues<{
            pageLabels?: string[] | Record<string, string> | null;
            totalPages?: number;
        }>(session.page, [
            'pageLabels',
            'totalPages',
        ]);
        expect(finalState.totalPages).toBe(201);
        expect(finalState.pageLabels).toBeNull();
    }, TEST_TIMEOUT_MS);

    it('keeps viewer chrome and commits Fit Width before a rotated page first paints', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(
            `page-mutation-viewer-continuity-${Date.now()}.pdf`,
            3,
        );
        session = await startElectronE2ESession(`e2e-page-mutation-viewer-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await ensureSidebarOpen(session.page, 60_000);
        await openDocumentSidebarTab(session.page, 'Pages', 60_000);
        await goToPageViaToolbar(session.page, 2);
        await waitForToolbarCurrentPage(session.page, 2, 60_000);

        const zoomDisplayPoint = await session.page.evaluate(() => {
            const display = Array.from(document.querySelectorAll<HTMLElement>('.zoom-controls-display'))
                .find((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
            if (!display) {
                return null;
            }
            const rect = display.getBoundingClientRect();
            return {
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2),
            };
        });
        expect(zoomDisplayPoint).not.toBeNull();
        if (!zoomDisplayPoint) {
            return;
        }
        await session.page.mouse.click(zoomDisplayPoint.x, zoomDisplayPoint.y);
        await session.page.waitForFunction(() => Array.from(
            document.querySelectorAll<HTMLButtonElement>('button.zoom-toggle-btn'),
        ).some(button => {
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && /Fit Width/iu.test(button.textContent ?? '');
        }), {timeout: 60_000});
        const fitWidthPoint = await session.page.evaluate(() => {
            const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button.zoom-toggle-btn'))
                .find((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && /Fit Width/iu.test(candidate.textContent ?? '');
                });
            if (!button) {
                return null;
            }
            const rect = button.getBoundingClientRect();
            return {
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2),
            };
        });
        expect(fitWidthPoint).not.toBeNull();
        if (!fitWidthPoint) {
            return;
        }
        await session.page.mouse.click(fitWidthPoint.x, fitWidthPoint.y);
        await session.page.waitForFunction(() => (
            (window as Window & {__evbTestApi?: IEvbTestApi})
                .__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
        ), {timeout: 60_000});
        await waitForAnimationFrames(session.page, 4);
        await session.page.waitForFunction(() => {
            const item = document.querySelector<HTMLElement>('[data-document-thumbnail-item][data-page="2"]');
            const page = document.querySelector<HTMLElement>('.page_container[data-page="2"]');
            return Boolean(item && page?.querySelector('canvas'));
        }, {timeout: 60_000});
        await session.page.waitForFunction(() => {
            const item = document.querySelector<HTMLElement>('[data-document-thumbnail-item][data-page="2"]');
            const thumbnailCanvas = item?.querySelector<HTMLCanvasElement>('canvas');
            const page = document.querySelector<HTMLElement>('.page_container[data-page="2"]');
            const pageCanvas = page?.querySelector<HTMLCanvasElement>('.page_canvas__render-layer > canvas');
            if (
                thumbnailCanvas?.dataset.thumbnailRendered !== 'true'
                || !pageCanvas
                || pageCanvas.width === 0
                || pageCanvas.height === 0
            ) {
                return false;
            }
            const sample = document.createElement('canvas');
            sample.width = 24;
            sample.height = 24;
            const context = sample.getContext('2d');
            if (!context) {
                return false;
            }
            context.drawImage(pageCanvas, 0, 0, sample.width, sample.height);
            const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
            for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index]! < 240 || pixels[index + 1]! < 240 || pixels[index + 2]! < 240) {
                    return true;
                }
            }
            return false;
        }, {timeout: 60_000});
        await session.page.waitForFunction(() => {
            const activeHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            return [
                1,
                3,
            ].every(pageNumber => {
                const item = activeHost?.querySelector<HTMLElement>(
                    `[data-document-thumbnail-item][data-page="${pageNumber}"]`,
                );
                return Boolean(item && (
                    Array.from(item.querySelectorAll('canvas')).some(canvas => canvas.width > 0 && canvas.height > 0)
                    || Array.from(item.querySelectorAll('img')).some(image => image.complete && image.naturalWidth > 0)
                ));
            });
        }, {timeout: 60_000});
        const baselineNeighbours = await session.page.evaluate(() => {
            const activeHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            return [
                1,
                3,
            ].map(pageNumber => {
                const item = activeHost?.querySelector<HTMLElement>(
                    `[data-document-thumbnail-item][data-page="${pageNumber}"]`,
                ) ?? null;
                return {
                    page: pageNumber,
                    label: item?.getAttribute('aria-label') ?? item?.textContent?.trim() ?? null,
                    painted: Boolean(item && (
                        Array.from(item.querySelectorAll('canvas')).some(canvas => canvas.width > 0 && canvas.height > 0)
                        || Array.from(item.querySelectorAll('img')).some(image => image.complete && image.naturalWidth > 0)
                    )),
                };
            });
        });
        expect(baselineNeighbours.every(item => item.painted), JSON.stringify(baselineNeighbours)).toBe(true);

        await session.page.evaluate(() => {
            const probe = window as TPageMutationProbeWindow;
            const activeHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
            const baselineCanvases = probe.__pageMutationBaselineCanvases = new Map<number, HTMLCanvasElement>();
            const baselineRenderKeys = probe.__pageMutationBaselineRenderKeys = new Map<number, string | null>();
            const canvasResets: NonNullable<IPageMutationProbeFields['__pageMutationCanvasResets']> = [];
            const frameSamples: IPageMutationFrame[] = [];
            probe.__pageMutationCanvasResets = canvasResets;
            probe.__pageMutationFrames = frameSamples;
            for (const pageNumber of [
                1,
                3,
            ]) {
                const canvas = activeHost?.querySelector<HTMLCanvasElement>(
                    `[data-document-thumbnail-item][data-page="${pageNumber}"] canvas`,
                );
                if (!canvas || !widthDescriptor?.get || !widthDescriptor.set) {
                    continue;
                }
                baselineCanvases.set(pageNumber, canvas);
                baselineRenderKeys.set(
                    pageNumber,
                    canvas.dataset.thumbnailRenderKey ?? null,
                );
                Object.defineProperty(canvas, 'width', {
                    configurable: true,
                    enumerable: true,
                    get: () => widthDescriptor.get?.call(canvas),
                    set: (value: number) => {
                        if (value === 0) {
                            canvasResets.push({
                                page: pageNumber,
                                stack: new Error().stack?.split('\n').slice(0, 8).join('\n') ?? null,
                            });
                        }
                        widthDescriptor.set?.call(canvas, value);
                    },
                });
            }
            probe.__pageMutationSampling = true;
            probe.__pageMutationFirstLandscapeRasterAt = null;
            probe.__pageMutationClickAt = null;
            probe.__pageMutationLastZoom = null;
            probe.__pageMutationLastZoomChangeAt = null;

            const isVisible = (element: HTMLElement | null) => {
                if (!element) {
                    return false;
                }
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0 && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            };
            const firstVisible = (selector: string) => Array.from(
                document.querySelectorAll<HTMLElement>(selector),
            ).find(isVisible) ?? null;
            const inspectCanvas = (canvas: HTMLCanvasElement | null) => {
                if (!canvas || canvas.width === 0 || canvas.height === 0) {
                    return {
                        painted: false,
                        inkPixels: 0,
                        contentAspect: null as number | null,
                    };
                }
                const sampleCanvas = document.createElement('canvas');
                sampleCanvas.width = 48;
                sampleCanvas.height = 64;
                const context = sampleCanvas.getContext('2d');
                if (!context) {
                    return {
                        painted: false,
                        inkPixels: 0,
                        contentAspect: null as number | null,
                    };
                }
                context.fillStyle = '#fff';
                context.fillRect(0, 0, sampleCanvas.width, sampleCanvas.height);
                context.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
                const pixels = context.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
                let inkPixels = 0;
                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index]! < 240 || pixels[index + 1]! < 240 || pixels[index + 2]! < 240) {
                        inkPixels += 1;
                    }
                }
                const transform = window.getComputedStyle(canvas).transform;
                const matrix = new DOMMatrix(transform === 'none' ? undefined : transform);
                const isQuarterTurn = Math.abs(matrix.a) < 0.1 && Math.abs(matrix.b) > 0.9;
                const contentAspect = isQuarterTurn
                    ? canvas.height / canvas.width
                    : canvas.width / canvas.height;
                const rect = canvas.getBoundingClientRect();
                const style = window.getComputedStyle(canvas);
                return {
                    painted: inkPixels > 0
                        && rect.width > 0
                        && rect.height > 0
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && style.opacity !== '0',
                    inkPixels,
                    contentAspect,
                };
            };
            const sample = () => {
                if (probe.__pageMutationSampling !== true) {
                    return;
                }
                const activeHost = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
                const target = activeHost?.querySelector<HTMLElement>('.page_container[data-page="2"]') ?? null;
                const viewer = activeHost?.querySelector<HTMLElement>('.document-viewer-viewport') ?? null;
                const chassis = activeHost?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
                const pageRect = target?.getBoundingClientRect();
                if (!probe.__pageMutationBaselineCanvases || !probe.__pageMutationBaselineRenderKeys) {
                    return;
                }
                const pageCanvases = Array.from(target?.querySelectorAll<HTMLCanvasElement>(
                    '.page_canvas__render-layer > canvas',
                ) ?? []);
                const canvasSizes = pageCanvases
                    .map(canvas => [
                        canvas.width,
                        canvas.height,
                    ] as [number, number]);
                const mainRaster = inspectCanvas(pageCanvases[0] ?? null);
                const pageAspect = pageRect && pageRect.height > 0
                    ? pageRect.width / pageRect.height
                    : null;
                const mainRasterAspectError = mainRaster.contentAspect !== null && pageAspect !== null
                    ? Math.abs(Math.log(mainRaster.contentAspect / pageAspect))
                    : null;
                const zoom = firstVisible('.zoom-controls-display-value, .zoom-controls-display')
                    ?.textContent?.replace(/\s+/gu, ' ').trim() ?? null;
                const now = performance.now();
                if (zoom !== probe.__pageMutationLastZoom) {
                    probe.__pageMutationLastZoom = zoom;
                    probe.__pageMutationLastZoomChangeAt = now;
                }
                if (pageRect && pageRect.width > pageRect.height
                    && canvasSizes.some(([
                        width,
                        height,
                    ]) => width > height)) {
                    probe.__pageMutationFirstLandscapeRasterAt ??= now;
                }
                const clickAt = probe.__pageMutationClickAt ?? null;
                const operationState = (window as Window & {__evbTestApi?: IEvbTestApi})
                    .__evbTestApi?.readActiveWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(['isPageOperationInProgress']);
                const sidebar = activeHost?.querySelector<HTMLElement>('[data-testid="document-sidebar"]') ?? null;
                const sidebarRect = sidebar?.getBoundingClientRect();
                const targetThumbnail = activeHost?.querySelector<HTMLElement>(
                    '[data-document-thumbnail-item][data-page="2"]',
                ) ?? null;
                const targetThumbnailCanvas = targetThumbnail?.querySelector<HTMLCanvasElement>('canvas') ?? null;
                const targetThumbnailPaint = inspectCanvas(targetThumbnailCanvas);
                const targetThumbnailFrameRect = targetThumbnail
                    ?.querySelector<HTMLElement>('[data-document-thumbnail-frame]')
                    ?.getBoundingClientRect();
                const neighbourThumbnails = [
                    1,
                    3,
                ].map(pageNumber => {
                    const item = activeHost?.querySelector<HTMLElement>(
                        `[data-document-thumbnail-item][data-page="${pageNumber}"]`,
                    ) ?? null;
                    const canvas = item?.querySelector<HTMLCanvasElement>('canvas') ?? null;
                    const painted = Boolean(item && (
                        Array.from(item.querySelectorAll('canvas')).some(canvas => canvas.width > 0 && canvas.height > 0)
                        || Array.from(item.querySelectorAll('img')).some(image => image.complete && image.naturalWidth > 0)
                    ));
                    return {
                        page: pageNumber,
                        label: item?.getAttribute('aria-label') ?? item?.textContent?.trim() ?? null,
                        painted,
                        sameCanvas: canvas !== null && canvas === baselineCanvases.get(pageNumber),
                        canvasSize: canvas ? [
                            canvas.width,
                            canvas.height,
                        ] as [number, number] : null,
                        renderKey: canvas?.dataset.thumbnailRenderKey ?? null,
                        sameRenderKey: canvas?.dataset.thumbnailRenderKey
                            === baselineRenderKeys.get(pageNumber),
                        rendered: canvas?.dataset.thumbnailRendered === 'true',
                        preserved: canvas?.dataset.thumbnailPreservedBitmap === 'true',
                    };
                });
                const pageSkeleton = target?.querySelector<HTMLElement>('.document-page-skeleton') ?? null;
                const frame: IPageMutationFrame = {
                    elapsedMs: now,
                    msSinceClick: clickAt === null
                        ? null
                        : now - clickAt,
                    toolbar: firstVisible('#editor-global-toolbar-host .page-controls-display, .page-controls-display')
                        ?.textContent?.replace(/\s+/gu, ' ').trim() ?? null,
                    zoom,
                    fitWidth: viewer?.classList.contains('pdfViewer--fit-width') === true
                        || viewer?.getAttribute('data-pdf-zoom-mode') === 'fit-width',
                    sidebar: isVisible(sidebar) && sidebarRect
                        ? {
                            left: sidebarRect.left,
                            width: sidebarRect.width,
                            height: sidebarRect.height,
                        }
                        : null,
                    generation: chassis?.getAttribute('data-open-surface-generation') ?? null,
                    revision: chassis?.getAttribute('data-open-surface-document-revision') ?? null,
                    phase: activeHost?.querySelector<HTMLElement>('[data-open-surface-phase]')
                        ?.getAttribute('data-open-surface-phase') ?? null,
                    viewportLifecycle: chassis?.getAttribute('data-viewport-lifecycle') ?? null,
                    pageRect: pageRect ? {
                        width: pageRect.width,
                        height: pageRect.height,
                    } : null,
                    canvasSizes,
                    mainRaster: {
                        ...mainRaster,
                        aspectError: mainRasterAspectError,
                    },
                    targetThumbnailPainted: targetThumbnailPaint.painted,
                    targetThumbnail: {
                        frameLandscape: targetThumbnailFrameRect && targetThumbnailFrameRect.height > 0
                            ? targetThumbnailFrameRect.width > targetThumbnailFrameRect.height
                            : null,
                        // The frame is laid out from the page geometry; a bitmap
                        // of the other orientation is drawn squeezed or cropped.
                        bitmapLandscape: targetThumbnailPaint.contentAspect === null
                            ? null
                            : targetThumbnailPaint.contentAspect > 1,
                    },
                    pageSkeletonVisible: isVisible(pageSkeleton),
                    neighbourThumbnails,
                    scrollTop: viewer?.scrollTop ?? null,
                    pageTopInViewport: target && viewer
                        ? target.getBoundingClientRect().top - viewer.getBoundingClientRect().top
                        : null,
                    operationBusy: operationState?.isPageOperationInProgress ?? null,
                };
                frameSamples.push(frame);
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });

        // A reader's own scroll ends the toolbar navigation's anchor upkeep, so
        // the rotation has to keep the page in place by itself.
        const viewerPoint = await session.page.evaluate(() => {
            const viewer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .document-viewer-viewport',
            );
            const rect = viewer?.getBoundingClientRect();
            return rect && rect.width > 0 && rect.height > 0
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null;
        });
        expect(viewerPoint).not.toBeNull();
        if (!viewerPoint) {
            return;
        }
        await session.page.mouse.move(viewerPoint.x, viewerPoint.y);
        await session.page.mouse.wheel({deltaY: 40});
        await waitForAnimationFrames(session.page, 30);

        const thumbnailPoint = await session.page.evaluate(() => {
            const item = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-document-thumbnail-item][data-page="2"]',
            );
            if (!item) {
                return null;
            }
            item.scrollIntoView({block: 'center'});
            const rect = item.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null;
        });
        expect(thumbnailPoint).not.toBeNull();
        if (!thumbnailPoint) {
            return;
        }
        await session.page.mouse.click(thumbnailPoint.x, thumbnailPoint.y, {button: 'right'});
        await session.page.waitForFunction(() => Array.from(
            document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ).some(item => item.textContent?.toLowerCase().includes('rotate counterclockwise')), {timeout: 15_000});
        const rotateMenuPoint = await session.page.evaluate(() => {
            const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .find(candidate => candidate.textContent?.toLowerCase().includes('rotate counterclockwise'));
            if (!item) {
                return null;
            }
            const rect = item.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        });
        expect(rotateMenuPoint).not.toBeNull();
        if (!rotateMenuPoint) {
            return;
        }
        await session.page.evaluate(() => {
            (window as TPageMutationProbeWindow).__pageMutationClickAt = performance.now();
        });
        await session.page.mouse.click(rotateMenuPoint.x, rotateMenuPoint.y);
        await session.page.waitForFunction(() => {
            const probe = window as TPageMutationProbeWindow;
            const now = performance.now();
            const firstLandscapeRasterAt = probe.__pageMutationFirstLandscapeRasterAt;
            const lastZoomChangeAt = probe.__pageMutationLastZoomChangeAt;
            const lastFrame = probe.__pageMutationFrames?.at(-1);
            return firstLandscapeRasterAt !== null
                && firstLandscapeRasterAt !== undefined
                && now - firstLandscapeRasterAt >= 2_000
                && lastZoomChangeAt !== null
                && lastZoomChangeAt !== undefined
                && now - lastZoomChangeAt >= 500
                && lastFrame?.operationBusy === false;
        }, {timeout: 60_000});
        const frames = await session.page.evaluate(() => {
            const probe = window as TPageMutationProbeWindow;
            probe.__pageMutationSampling = false;
            return {
                frames: probe.__pageMutationFrames ?? [],
                thumbnailBitmapResets: probe.__pageMutationCanvasResets ?? [],
            };
        });
        const {
            frames: sampledFrames,
            thumbnailBitmapResets,
        } = frames;

        const firstRotatedRasterIndex = sampledFrames.findIndex(frame => (
            frame.pageRect !== null
            && frame.pageRect.width > frame.pageRect.height
            && frame.canvasSizes.some(([
                width,
                height,
            ]) => width > height)
        ));
        expect(firstRotatedRasterIndex, JSON.stringify(frames)).toBeGreaterThanOrEqual(0);
        const initialFrame = sampledFrames[0];
        const firstRotatedRaster = sampledFrames[firstRotatedRasterIndex];
        const finalFrame = sampledFrames.at(-1);
        expect(initialFrame).toBeDefined();
        expect(firstRotatedRaster).toBeDefined();
        expect(finalFrame).toBeDefined();
        if (!initialFrame || !firstRotatedRaster || !finalFrame) {
            return;
        }

        expect(initialFrame.revision).not.toBe(finalFrame.revision);
        expect(new Set(sampledFrames.map(frame => frame.generation))).toEqual(new Set([initialFrame.generation]));
        const postClickFrames = sampledFrames.filter(frame => frame.msSinceClick !== null && frame.msSinceClick >= 0);
        expect(postClickFrames.every(frame => frame.phase === 'ready' && frame.viewportLifecycle === 'ready')).toBe(true);
        expect(postClickFrames.every(frame => frame.sidebar !== null)).toBe(true);
        expect(postClickFrames.every(frame => frame.fitWidth)).toBe(true);
        expect(postClickFrames.every(frame => frame.toolbar !== null && !/[-–—]\s*\/\s*0/u.test(frame.toolbar))).toBe(true);
        expect(postClickFrames.every(frame => /2\s*\/\s*3/u.test(frame.toolbar ?? ''))).toBe(true);
        expect(postClickFrames.every(frame => frame.mainRaster.painted), JSON.stringify(
            postClickFrames.filter(frame => !frame.mainRaster.painted).slice(0, 6),
        )).toBe(true);
        const preClickFrame = sampledFrames.filter(frame => frame.msSinceClick === null || frame.msSinceClick < 0).at(-1);
        const viewportHeight = await session.page.evaluate(() => document.querySelector<HTMLElement>(
            '.editor-pane.is-active .document-viewer-viewport',
        )?.clientHeight ?? 0);
        const pageOutOfViewFrames = postClickFrames.filter(frame => (
            frame.pageTopInViewport === null
            || frame.pageRect === null
            || frame.pageTopInViewport + frame.pageRect.height <= 0
            || frame.pageTopInViewport >= viewportHeight
        ));
        expect(pageOutOfViewFrames, JSON.stringify(pageOutOfViewFrames.slice(0, 4).map(frame => ({
            msSinceClick: frame.msSinceClick,
            pageTopInViewport: frame.pageTopInViewport,
            scrollTop: frame.scrollTop,
        })))).toEqual([]);
        // The rotated page keeps its place: its top may settle to the page
        // edge the swap restores, but never drifts by the size change of the
        // pages above it.
        const pageDrift = postClickFrames.map(frame => ({
            msSinceClick: frame.msSinceClick,
            drift: Math.abs((frame.pageTopInViewport ?? Number.POSITIVE_INFINITY)
                - (preClickFrame?.pageTopInViewport ?? Number.NaN)),
        }));
        const driftedFrames = pageDrift.filter(frame => !(frame.drift <= 64));
        expect(driftedFrames, JSON.stringify({
            preClickTop: preClickFrame?.pageTopInViewport,
            drifted: driftedFrames.slice(0, 6),
        })).toEqual([]);
        const stretchedFrames = postClickFrames.filter(frame => (
            frame.mainRaster.painted
            && frame.mainRaster.aspectError !== null
            && frame.mainRaster.aspectError > 0.08
        ));
        expect(stretchedFrames, JSON.stringify(stretchedFrames.slice(0, 6))).toEqual([]);
        let consecutiveBlankThumbnailFrames = 0;
        let maximumBlankThumbnailFrames = 0;
        for (const frame of postClickFrames) {
            consecutiveBlankThumbnailFrames = frame.targetThumbnailPainted
                ? 0
                : consecutiveBlankThumbnailFrames + 1;
            maximumBlankThumbnailFrames = Math.max(
                maximumBlankThumbnailFrames,
                consecutiveBlankThumbnailFrames,
            );
        }
        expect(maximumBlankThumbnailFrames).toBeLessThanOrEqual(1);
        const distortedThumbnailFrames = postClickFrames.filter(frame => (
            frame.targetThumbnailPainted
            && frame.targetThumbnail.bitmapLandscape !== frame.targetThumbnail.frameLandscape
        ));
        expect(distortedThumbnailFrames, JSON.stringify(distortedThumbnailFrames.slice(0, 6).map(frame => ({
            msSinceClick: frame.msSinceClick,
            revision: frame.revision,
            targetThumbnail: frame.targetThumbnail,
        })))).toEqual([]);
        expect(initialFrame.targetThumbnail.frameLandscape).toBe(false);
        expect(finalFrame.targetThumbnail.frameLandscape).toBe(true);
        const firstFinalScaleFrame = postClickFrames.find(frame => (
            frame.pageRect !== null
            && frame.pageRect.width > frame.pageRect.height
            && frame.mainRaster.painted
            && frame.mainRaster.aspectError !== null
            && frame.mainRaster.aspectError <= 0.08
        ));
        expect(firstFinalScaleFrame, JSON.stringify(postClickFrames.slice(0, 10))).toBeDefined();
        expect(firstFinalScaleFrame?.msSinceClick).toBeLessThanOrEqual(500);
        expect(firstFinalScaleFrame?.zoom).toBe(finalFrame.zoom);
        expect(postClickFrames.filter(frame => frame.pageRect && frame.pageRect.width > frame.pageRect.height)
            .every(frame => frame.zoom === finalFrame.zoom)).toBe(true);
        expect(postClickFrames.filter(frame => frame.revision !== initialFrame.revision)
            .every(frame => !frame.pageSkeletonVisible)).toBe(true);
        const unpaintedNeighbourFrames = sampledFrames.filter(frame => (
            frame.neighbourThumbnails.length !== 2
            || frame.neighbourThumbnails.some(item => !item.painted)
        )).map(frame => ({
            elapsedMs: frame.elapsedMs,
            revision: frame.revision,
            neighbourThumbnails: frame.neighbourThumbnails,
        }));
        expect(unpaintedNeighbourFrames, JSON.stringify({
            thumbnailBitmapResets: thumbnailBitmapResets.slice(0, 4),
            unpaintedNeighbourFrames: unpaintedNeighbourFrames.slice(0, 6),
        })).toEqual([]);
        expect(finalFrame.neighbourThumbnails.map(item => [
            item.page,
            item.label,
            item.painted,
            item.sameCanvas,
            item.canvasSize,
            item.renderKey,
            item.sameRenderKey,
            item.rendered,
        ])).toEqual(initialFrame.neighbourThumbnails.map(item => [
            item.page,
            item.label,
            item.painted,
            item.sameCanvas,
            item.canvasSize,
            item.renderKey,
            item.sameRenderKey,
            item.rendered,
        ]));
        expect(firstRotatedRaster.zoom).toBe(finalFrame.zoom);
        expect(sampledFrames.slice(firstRotatedRasterIndex).every(frame => frame.zoom === finalFrame.zoom)).toBe(true);
        expect(firstRotatedRaster.canvasSizes.some(([
            width,
            height,
        ]) => width > height)).toBe(true);
    }, 180_000);
});
