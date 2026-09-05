// @vitest-environment happy-dom
import type { Page } from 'puppeteer-core';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    clickHistoryActionAcrossAnimationBoundaries,
    disconnectAnnotationUndoBoundaryProbe,
    readAnnotationUndoBoundaryProbe,
} from '@tests/e2e/electron/helpers/viewerAnnotations';

// The annotation helpers pull in the Electron session fixtures, whose
// project-root resolution needs a file: module URL that the DOM environment
// does not provide. None of the probe helpers under test touch them.
vi.mock('@tests/e2e/electron/helpers/fixtures', () => ({readPdfAnnotationSummary: vi.fn()}));

type TPageEvaluateArgument = string | ((...args: unknown[]) => unknown);

function createRecordingPage() {
    const calls: TPageEvaluateArgument[][] = [];
    const evaluate = vi.fn(async (...args: TPageEvaluateArgument[]) => {
        calls.push(args);
        return undefined;
    });
    const page = Object.create(null) as Page;
    Object.defineProperty(page, 'evaluate', { value: evaluate });
    return {
        calls,
        page,
    };
}

function readBoundaryFunction(calls: TPageEvaluateArgument[][]) {
    const boundaryFunction = calls.at(1)?.at(0);
    if (typeof boundaryFunction !== 'function') {
        throw new Error(`Boundary page function was not evaluated: ${JSON.stringify(calls.map(call => typeof call.at(0)))}`);
    }
    return boundaryFunction as (label: string) => Promise<unknown>;
}

function setRendererWindow(value: unknown) {
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value,
        writable: true,
    });
}

describe('annotation undo boundary probe', () => {
    const originalWindow = globalThis.window;

    afterEach(() => {
        vi.restoreAllMocks();
        setRendererWindow(originalWindow);
    });

    it('installs the shared workspace expose probe before sampling the boundaries', async () => {
        const {
            calls,
            page,
        } = createRecordingPage();

        await clickHistoryActionAcrossAnimationBoundaries(page, 'Undo');

        expect(calls).toHaveLength(2);
        expect(calls.at(0)?.at(0)).toEqual(expect.stringContaining('__evbFindWorkspaceExpose'));
        expect(calls.at(1)?.at(0)).toEqual(expect.any(Function));
        expect(calls.at(1)?.at(1)).toBe('Undo');
    });

    it('fails the boundary evaluation when the shared test API is unavailable', async () => {
        const {
            calls,
            page,
        } = createRecordingPage();
        await clickHistoryActionAcrossAnimationBoundaries(page, 'Undo');
        const boundaryFunction = readBoundaryFunction(calls);
        setRendererWindow({});

        await expect(boundaryFunction('Undo')).rejects.toThrow(
            /window\.__evbTestApi\.readActiveWorkspaceStateValues/u,
        );
    });

    it('releases the retained observer during teardown', async () => {
        const disconnect = vi.fn();
        const rendererWindow: Record<string, unknown> = { __evbAnnotationUndoBoundaryProbe: { disconnect } };
        setRendererWindow(rendererWindow);
        const evaluate = vi.fn(async (pageFunction: () => void) => pageFunction());
        const page = Object.create(null) as Page;
        Object.defineProperty(page, 'evaluate', { value: evaluate });

        await disconnectAnnotationUndoBoundaryProbe(page);

        expect(disconnect).toHaveBeenCalledOnce();
        expect('__evbAnnotationUndoBoundaryProbe' in rendererWindow).toBe(false);
    });
});

/**
 * Every count the probe reports has to come from the active workspace host.
 * Inactive tabs keep their viewers mounted, so a document-wide count would let
 * another tab's editors decide whether an undo left an orphan behind.
 */
describe('annotation undo boundary probe host scoping', () => {
    const ACTIVE_HIGHLIGHT_ID = 'active-highlight';
    const INACTIVE_HIGHLIGHT_ID = 'inactive-highlight';

    function stubVisibleRect(element: HTMLElement) {
        Object.defineProperty(element, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({
                width: 40,
                height: 20,
                top: 0,
                left: 0,
                right: 40,
                bottom: 20,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }),
        });
    }

    function buildTwoWorkspaceDocument() {
        document.body.innerHTML = `
            <div class="editor-pane is-active">
                <div class="workspace-host" data-workspace-active="true">
                    <div class="pdf-annotation-editor-layer">
                        <div class="pdf-annotation-editor-text-markup" id="${ACTIVE_HIGHLIGHT_ID}"></div>
                    </div>
                </div>
            </div>
            <div class="editor-pane">
                <div class="workspace-host" data-workspace-active="false">
                    <div class="pdf-annotation-editor-layer">
                        <div class="pdf-annotation-editor-text-markup" id="${INACTIVE_HIGHLIGHT_ID}"></div>
                    </div>
                </div>
            </div>
            <button type="button" aria-label="Undo">Undo</button>
        `;
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const inactiveHost = document.querySelectorAll<HTMLElement>('.workspace-host')[1];
        const button = document.querySelector<HTMLButtonElement>('button[aria-label="Undo"]');
        if (!activeHost || !inactiveHost || !button) {
            throw new Error('Failed to build the two-workspace probe fixture');
        }
        stubVisibleRect(button);
        Object.defineProperty(globalThis, '__evbE2E', {
            configurable: true,
            value: {getActiveWorkspaceHost: () => activeHost},
            writable: true,
        });
        Reflect.set(window, '__evbTestApi', {readActiveWorkspaceStateValues: () => ({annotationComments: []})});
        return {
            activeHost,
            button,
            inactiveHost,
        };
    }

    function createEvaluatingPage() {
        const calls: TPageEvaluateArgument[][] = [];
        const evaluate = vi.fn(async (...args: TPageEvaluateArgument[]) => {
            calls.push(args);
            const [
                pageFunction,
                ...rest
            ] = args;
            return typeof pageFunction === 'function' ? pageFunction(...rest) : undefined;
        });
        const page = Object.create(null) as Page;
        Object.defineProperty(page, 'evaluate', { value: evaluate });
        return page;
    }

    afterEach(() => {
        document.body.innerHTML = '';
        Reflect.deleteProperty(window, '__evbTestApi');
        Reflect.deleteProperty(window, '__evbAnnotationUndoBoundaryProbe');
        Reflect.deleteProperty(globalThis, '__evbE2E');
    });

    it('counts and observes only the active workspace host', async () => {
        const {
            activeHost,
            button,
            inactiveHost,
        } = buildTwoWorkspaceDocument();
        button.addEventListener('click', () => {
            activeHost.querySelector(`#${ACTIVE_HIGHLIGHT_ID}`)?.remove();
            const strayEditor = document.createElement('div');
            strayEditor.className = 'pdf-annotation-editor-text-markup';
            strayEditor.id = 'inactive-late-highlight';
            inactiveHost.querySelector('.pdf-annotation-editor-layer')?.append(strayEditor);
        });

        const boundary = await clickHistoryActionAcrossAnimationBoundaries(createEvaluatingPage(), 'Undo');

        // The inactive host owns a highlight editor of its own throughout, so a
        // document-wide count would report 2 here and 2 after the undo.
        expect(boundary.at('before').canonicalTextMarkupCount).toBe(1);
        expect(boundary.at('before').editorLayerTags).toHaveLength(1);
        expect(boundary.at('synchronous').canonicalTextMarkupCount).toBe(0);
        expect(boundary.at('frame-2').canonicalTextMarkupCount).toBe(0);
        expect(boundary.at('frame-2').removedHighlightNodeIds).toEqual([ACTIVE_HIGHLIGHT_ID]);
        // The stray node was appended to the inactive host in the same task as
        // the undo; it must not read as a resurrected editor.
        expect(boundary.at('frame-2').addedHighlightNodeIds).toEqual([]);
    });

    it('keeps a later inactive-host mutation out of the retained probe read', async () => {
        const {
            activeHost,
            inactiveHost,
        } = buildTwoWorkspaceDocument();
        const page = createEvaluatingPage();
        await clickHistoryActionAcrossAnimationBoundaries(page, 'Undo');
        activeHost.querySelector(`#${ACTIVE_HIGHLIGHT_ID}`)?.remove();
        const strayEditor = document.createElement('div');
        strayEditor.className = 'pdf-annotation-editor-text-markup';
        strayEditor.id = 'inactive-deferred-highlight';
        inactiveHost.querySelector('.pdf-annotation-editor-layer')?.append(strayEditor);

        const observed = await readAnnotationUndoBoundaryProbe(page);

        expect(observed.added).toEqual([]);
        expect(observed.canonicalTextMarkupCount).toBe(0);
        expect(observed.highlightAnnotationCount).toBe(0);
    });

    it('fails the retained read when the probe was never installed', async () => {
        buildTwoWorkspaceDocument();

        await expect(readAnnotationUndoBoundaryProbe(createEvaluatingPage())).rejects.toThrow(
            /probe is not installed/u,
        );
    });

    it('fails the boundary evaluation when no active workspace host resolves', async () => {
        buildTwoWorkspaceDocument();
        Object.defineProperty(globalThis, '__evbE2E', {
            configurable: true,
            value: {getActiveWorkspaceHost: () => null},
            writable: true,
        });

        await expect(clickHistoryActionAcrossAnimationBoundaries(createEvaluatingPage(), 'Undo')).rejects.toThrow(
            /could not resolve the active workspace host/u,
        );
    });
});
