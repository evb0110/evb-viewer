import type { Page } from 'puppeteer-core';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';

// Everything here is read the way a person reads the window: the text the
// toolbar renders and the layout rectangles the pages actually occupy. No
// automation snapshot of the viewer's own state takes part in an observation,
// so a test built on these samples cannot pass by agreeing with the model the
// viewer keeps of itself.

export interface IViewportPageCoverage {
    page: number;
    /** Height of the page rectangle that falls inside the viewport rectangle. */
    coveredHeight: number;
    /** Full height of the page rectangle. */
    height: number;
}

/**
 * A page counts as shown when it covers at least this fraction of the smaller
 * of its own height and the viewport height. Two pages can qualify at once;
 * which of them the toolbar names is a product decision this contract leaves
 * open.
 */
export const VISIBLE_PAGE_MIN_COVERAGE_RATIO = 0.25;

export interface IViewportPageSample {
    elapsedMs: number;
    /** Toolbar's rendered current-page text, trimmed, or null when absent. */
    toolbarText: string | null;
    /** Page that occupies most of the viewport rectangle, or null when none is mounted. */
    viewportPage: number | null;
    /** Fraction of the viewport height the dominant page covers. */
    viewportCoverage: number;
    viewportHeight: number;
    scrollTop: number;
    pages: IViewportPageCoverage[];
}

/**
 * Whether the page the toolbar names is one of the pages the window shows.
 */
export function isToolbarPageVisible(sample: IViewportPageSample) {
    const named = Number(sample.toolbarText);
    if (!Number.isSafeInteger(named)) {
        return false;
    }
    const coverage = sample.pages.find(entry => entry.page === named);
    if (!coverage) {
        return false;
    }
    return coverage.coveredHeight
        >= VISIBLE_PAGE_MIN_COVERAGE_RATIO * Math.min(coverage.height, sample.viewportHeight);
}

export interface IViewportPageSamplerHandle {
    read: () => Promise<IViewportPageSample[]>;
    stop: () => Promise<void>;
}

interface IViewportPageSamplerState {
    samples: IViewportPageSample[];
    stop: () => void;
}

interface IViewportPageSamplerWindow extends Window {__evbViewportPageSampler?: IViewportPageSamplerState;}

const SAMPLER_SOURCE = () => {
    const samplerWindow = window as IViewportPageSamplerWindow;
    samplerWindow.__evbViewportPageSampler?.stop();

    const isVisible = (element: HTMLElement) => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || '1') > 0;
    };
    const resolveViewport = () => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        return host?.querySelector<HTMLElement>(
            '[data-document-viewer-chassis-viewport], #pdf-viewer',
        ) ?? null;
    };
    const readToolbarText = () => {
        const element = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .find((candidate) => {
                const controls = candidate.closest<HTMLElement>('.page-controls') ?? candidate;
                const rect = controls.getBoundingClientRect();
                return rect.width > 8 && rect.height > 8 && isVisible(controls);
            });
        return element?.textContent?.trim() ?? null;
    };

    const state: IViewportPageSamplerState = {
        samples: [],
        stop: () => {},
    };
    const startedAt = performance.now();
    let frame = 0;
    const sample = () => {
        const viewport = resolveViewport();
        const viewportRect = viewport?.getBoundingClientRect() ?? null;
        const pages: IViewportPageCoverage[] = [];
        if (viewport && viewportRect) {
            for (const container of viewport.querySelectorAll<HTMLElement>('.page_container[data-page]')) {
                const pageNumber = Number(container.dataset.page);
                if (!Number.isSafeInteger(pageNumber) || !isVisible(container)) {
                    continue;
                }
                const rect = container.getBoundingClientRect();
                const coveredHeight = Math.min(rect.bottom, viewportRect.bottom)
                    - Math.max(rect.top, viewportRect.top);
                if (coveredHeight > 0 && rect.right > viewportRect.left && rect.left < viewportRect.right) {
                    pages.push({
                        page: pageNumber,
                        coveredHeight,
                        height: rect.height,
                    });
                }
            }
        }
        pages.sort((left, right) => right.coveredHeight - left.coveredHeight || left.page - right.page);
        const dominant = pages[0] ?? null;
        const viewportHeight = viewportRect?.height ?? 0;
        state.samples.push({
            elapsedMs: Math.round(performance.now() - startedAt),
            toolbarText: readToolbarText(),
            viewportPage: dominant?.page ?? null,
            viewportCoverage: dominant && viewportHeight > 0 ? dominant.coveredHeight / viewportHeight : 0,
            viewportHeight,
            scrollTop: viewport?.scrollTop ?? -1,
            pages,
        });
        frame = window.requestAnimationFrame(sample);
    };

    state.stop = () => {
        window.cancelAnimationFrame(frame);
    };
    samplerWindow.__evbViewportPageSampler = state;
    frame = window.requestAnimationFrame(sample);
};

/**
 * Starts a per-frame record of the rendered toolbar text and the page
 * rectangles inside the viewport rectangle.
 */
export async function installViewportPageSampler(page: Page): Promise<IViewportPageSamplerHandle> {
    await evaluateInPage(page, SAMPLER_SOURCE);
    return {
        read: () => readViewportPageSamples(page),
        stop: async () => {
            await evaluateInPage(page, () => {
                (window as IViewportPageSamplerWindow).__evbViewportPageSampler?.stop();
            });
        },
    };
}

export async function readViewportPageSamples(page: Page) {
    return evaluateInPage(page, () => (
        (window as IViewportPageSamplerWindow).__evbViewportPageSampler?.samples ?? []
    )) as Promise<IViewportPageSample[]>;
}

/**
 * Reads the same observation once, without a running sampler.
 */
export async function readViewportPageObservation(page: Page): Promise<IViewportPageSample> {
    const handle = await installViewportPageSampler(page);
    await evaluateInPage(page, () => new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    }));
    const samples = await handle.read();
    await handle.stop();
    const last = samples.at(-1);
    if (!last) {
        throw new Error('The viewport page sampler produced no frame');
    }
    return last;
}

/**
 * Waits until the viewport scroll offset and the dominant page stop changing.
 */
export async function waitForViewportQuiet(page: Page, quietMs = 600, timeoutMs = 20_000) {
    await evaluateInPage(page, async (input: {
        quietMs: number;
        timeoutMs: number;
    }) => {
        const resolveViewport = () => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            return host?.querySelector<HTMLElement>(
                '[data-document-viewer-chassis-viewport], #pdf-viewer',
            ) ?? null;
        };
        const deadline = performance.now() + input.timeoutMs;
        let previousScrollTop = Number.NaN;
        let quietSince = performance.now();
        while (performance.now() < deadline) {
            await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
            const scrollTop = resolveViewport()?.scrollTop ?? -1;
            if (scrollTop !== previousScrollTop) {
                previousScrollTop = scrollTop;
                quietSince = performance.now();
            } else if (performance.now() - quietSince >= input.quietMs) {
                return;
            }
        }
        throw new Error(`The viewport kept moving for ${String(input.timeoutMs)}ms`);
    }, {
        quietMs,
        timeoutMs,
    });
}
