import type * as TPageRuntime from '@tests/e2e/electron/helpers/pageRuntime';
import type * as TWorkspaceExpose from '@tests/e2e/electron/helpers/workspaceExpose';
import type * as TViewerDom from '@tests/e2e/electron/helpers/viewerDom';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    openPdfInApp,
    triggerOpenPathInApp,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

interface IFakeElement {
    classList: {contains: (name: string) => boolean};
    dataset: Record<string, string>;
    getBoundingClientRect: () => {
        height: number;
        width: number
    };
    querySelector: (selector: string) => IFakeElement | null;
    querySelectorAll: (selector: string) => IFakeElement[];
}

const mocks = vi.hoisted(() => ({
    waitForActiveWorkspaceHost: vi.fn(async () => undefined),
    waitForFunctionInPage: vi.fn(),
    evaluateInPage: vi.fn(),
}));

vi.mock('@tests/e2e/electron/helpers/pageRuntime', async importOriginal => ({
    ...await importOriginal<typeof TPageRuntime>(),
    waitForFunctionInPage: mocks.waitForFunctionInPage,
    evaluateInPage: mocks.evaluateInPage,
}));
vi.mock('@tests/e2e/electron/helpers/viewerDom', async importOriginal => ({
    ...await importOriginal<typeof TViewerDom>(),
    waitForActiveWorkspaceHost: mocks.waitForActiveWorkspaceHost,
}));

vi.mock('@tests/e2e/electron/helpers/workspaceExpose', async importOriginal => ({
    ...await importOriginal<typeof TWorkspaceExpose>(),
    getLatestAutomationEventId: vi.fn(async () => 0),
    installWorkspaceExposeProbe: vi.fn(async () => undefined),
}));

function createElement(options: {
    classes?: string[];
    dataset?: Record<string, string>;
    selectors?: Record<string, IFakeElement | null>;
    lists?: Record<string, IFakeElement[]>;
} = {}): IFakeElement {
    const classes = new Set(options.classes ?? []);
    const selectors = options.selectors ?? {};
    const lists = options.lists ?? {};
    return {
        classList: {contains: name => classes.has(name)},
        dataset: options.dataset ?? {},
        getBoundingClientRect: () => ({
            height: 600,
            width: 800,
        }),
        querySelector: selector => selectors[selector] ?? null,
        querySelectorAll: selector => lists[selector] ?? [],
    };
}

function installInteractivePage(options: {
    source?: IFakeElement | null;
    viewportDataset?: Record<string, string>;
    chassisDataset?: Record<string, string>;
}) {
    const source = options.source === undefined
        ? createElement()
        : options.source;
    const viewport = createElement({
        dataset: options.viewportDataset ?? {openSurfacePhase: 'ready'},
        selectors: {
            '[data-pdf-page-track]': null,
            '[data-testid="document-page-source-viewer"]': source,
        },
    });
    const chassis = createElement({
        dataset: options.chassisDataset ?? {openSurfacePresentation: 'committed'},
        selectors: {'[data-document-viewer-chassis-viewport]': viewport},
    });
    const host = createElement({selectors: {'.document-viewer-chassis': chassis}});
    const fakeDocument = {
        querySelector: (selector: string) => selector === '.editor-pane.is-active .workspace-host' ? host : null,
        querySelectorAll: (selector: string) => selector === '.workspace-host' ? [host] : [],
    };
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('window', {getComputedStyle: () => ({
        display: 'block',
        opacity: '1',
        visibility: 'visible',
    })});
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('viewer interactive readiness', () => {
    it('accepts a committed native DjVu source viewer', async () => {
        installInteractivePage({});
        mocks.waitForFunctionInPage.mockImplementation(async (
            _page: unknown,
            predicate: () => boolean,
        ) => {
            if (!predicate()) {
                throw new Error('interactive predicate rejected the native source viewer');
            }
        });

        await expect(waitForViewerInteractive(Object.create(null), 500)).resolves.toBeUndefined();
        expect(mocks.waitForFunctionInPage).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'missing native source viewer',
            {source: null},
        ],
        [
            'uncommitted chassis presentation',
            {chassisDataset: {openSurfacePresentation: 'opening'}},
        ],
    ])('rejects %s', async (_description, options) => {
        installInteractivePage(options);
        mocks.waitForFunctionInPage.mockImplementation(async (
            _page: unknown,
            predicate: () => boolean,
        ) => {
            if (!predicate()) {
                throw new Error('interactive predicate rejected the page');
            }
        });

        await expect(waitForViewerInteractive(Object.create(null), 500))
            .rejects.toThrow('interactive predicate rejected the page');
    });
});


describe('direct document open dispatch', () => {
    it.each([
        {
            name: 'triggerOpenPathInApp',
            open: triggerOpenPathInApp,
        },
        {
            name: 'openPdfInApp',
            open: openPdfInApp,
        },
    ])('does not replay $name when navigation destroys its pending result', async ({open}) => {
        mocks.evaluateInPage.mockReset();
        mocks.waitForFunctionInPage.mockReset();
        if (open === openPdfInApp) {
            mocks.waitForFunctionInPage.mockRejectedValueOnce(new Error('No active document'));
        }
        mocks.waitForFunctionInPage.mockResolvedValue(undefined);
        const navigationError = new Error('Execution context was destroyed, most likely because of a navigation.');
        mocks.evaluateInPage.mockResolvedValueOnce({
            electronAPI: 'object',
            openFileDirect: 'function',
            nuxtRootChildren: 1,
            url: 'http://localhost/electron',
        }).mockRejectedValue(navigationError);

        await expect(open(Object.create(null), '/tmp/open-once.pdf', 100))
            .rejects.toThrow('Execution context was destroyed');
        expect(mocks.evaluateInPage).toHaveBeenCalledTimes(2);
    });
});
