import type { Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import type { IWorkspaceExposeProbeWindow } from '@tests/e2e/electron/helpers/workspaceExpose';

// The page number a person reads is the text the toolbar renders, not the
// `currentPage` field of the viewer's automation snapshot. A frozen indicator
// over a moving document is a defect the snapshot cannot show, so every
// observation here carries both channels and the caller compares them.

/** One reading of the rendered page indicator next to the viewer's own model. */
export interface IToolbarPageIndicatorObservation {
    /** Rendered primary text: a page label when the document has one, else a number. */
    primaryText: string | null;
    /** Rendered secondary text. Beside a page label the viewer renders "(12)". */
    secondaryText: string | null;
    /** Physical page the rendered indicator names, derived from the rendered text. */
    renderedPage: number | null;
    /** Pages the window lays out on the rendered page's row, a facing spread included. */
    renderedRowPages: number[];
    /** True while the inline page editor has replaced the rendered number. */
    isEditing: boolean;
    /** `currentPage` of the viewer's own automation snapshot. */
    snapshotPage: number | null;
    /** Rendered total, when the indicator shows one. */
    totalPagesText: string | null;
}

// The page source below is serialized into the renderer, so it cannot close
// over module scope. Two page rectangles count as one rendered row when they
// overlap vertically by at least half of the shorter one.
const OBSERVATION_SOURCE = (): IToolbarPageIndicatorObservation => {
    const isVisible = (element: HTMLElement | null, minSizePx: number) => {
        if (!element?.isConnected) {
            return false;
        }
        let current: HTMLElement | null = element;
        while (current) {
            const style = window.getComputedStyle(current);
            if (
                style.display === 'none'
                || style.visibility === 'hidden'
                || Number(style.opacity || '1') === 0
            ) {
                return false;
            }
            current = current.parentElement;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > minSizePx && rect.height > minSizePx;
    };
    const readText = (root: HTMLElement, selector: string) => {
        const element = root.querySelector<HTMLElement>(selector);
        const text = element?.textContent?.trim() ?? '';
        return text === '' ? null : text;
    };
    // The global toolbar host owns the active document's controls. A split
    // pane can render a second, inactive set, so prefer the host and only then
    // fall back to the first visible one.
    const resolveControls = () => {
        const roots = [
            document.querySelector<HTMLElement>('#editor-global-toolbar-host'),
            document.documentElement,
        ];
        for (const root of roots) {
            const controls = Array.from(root?.querySelectorAll<HTMLElement>('.page-controls') ?? [])
                .find(candidate => isVisible(candidate, 8));
            if (controls) {
                return controls;
            }
        }
        return null;
    };
    const resolveViewport = () => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        return host?.querySelector<HTMLElement>(
            '[data-document-viewer-chassis-viewport], #pdf-viewer',
        ) ?? null;
    };
    const readRowPages = (page: number | null) => {
        const viewport = page === null ? null : resolveViewport();
        if (!viewport) {
            return [];
        }
        const boxes = Array.from(viewport.querySelectorAll<HTMLElement>('.page_container[data-page]'))
            .map(container => ({
                page: Number(container.dataset.page),
                rect: container.getBoundingClientRect(),
            }))
            .filter(entry => Number.isSafeInteger(entry.page) && entry.rect.height > 0);
        const named = boxes.find(entry => entry.page === page);
        if (!named) {
            return [];
        }
        return boxes
            .filter((entry) => {
                const overlap = Math.min(entry.rect.bottom, named.rect.bottom)
                    - Math.max(entry.rect.top, named.rect.top);
                return overlap >= 0.5 * Math.min(entry.rect.height, named.rect.height);
            })
            .map(entry => entry.page)
            .sort((left, right) => left - right);
    };

    const controls = resolveControls();
    const primaryText = controls ? readText(controls, '.page-controls-current-primary') : null;
    const secondaryText = controls ? readText(controls, '.page-controls-current-secondary') : null;
    // The viewer renders a page label as the primary text and the physical
    // page in parentheses beside it, so the parenthesised value is the one to
    // compare with a physical page number.
    const labelledPage = secondaryText ? /^\((\d+)\)$/u.exec(secondaryText) : null;
    const primaryPage = primaryText !== null && /^\d+$/u.test(primaryText)
        ? Number(primaryText)
        : null;
    const renderedPage = labelledPage ? Number(labelledPage[1]) : primaryPage;

    return {
        primaryText,
        secondaryText,
        renderedPage,
        renderedRowPages: readRowPages(renderedPage),
        isEditing: Boolean(controls?.querySelector('.page-controls-inline-input')),
        snapshotPage: (window as IWorkspaceExposeProbeWindow)
            .__evbTestApi
            ?.getActiveToolbarSnapshot()
            ?.currentPage ?? null,
        totalPagesText: controls ? readText(controls, '.page-controls-total') : null,
    };
};

/** Reads the rendered indicator and the viewer's snapshot in the same frame. */
export async function readToolbarPageIndicator(page: Page) {
    return evaluateInPage(page, OBSERVATION_SOURCE) as Promise<IToolbarPageIndicatorObservation>;
}

/**
 * Whether a page number names the same reading position as `expectedPage`.
 * In a facing spread the window lays two pages on one row and the toolbar may
 * name either of them, which R1 of the behavior contract allows.
 */
function namesExpectedPage(
    observation: IToolbarPageIndicatorObservation,
    value: number | null,
    expectedPage: number,
) {
    if (value === null) {
        return false;
    }
    if (value === expectedPage) {
        return true;
    }
    return observation.renderedRowPages.includes(value)
        && observation.renderedRowPages.includes(expectedPage);
}

export function describeToolbarPageIndicator(observation: IToolbarPageIndicatorObservation) {
    return JSON.stringify({
        isEditing: observation.isEditing,
        primaryText: observation.primaryText,
        renderedPage: observation.renderedPage,
        renderedRowPages: observation.renderedRowPages,
        secondaryText: observation.secondaryText,
        snapshotPage: observation.snapshotPage,
        totalPagesText: observation.totalPagesText,
    });
}

function explainDisagreement(
    observation: IToolbarPageIndicatorObservation,
    expectedPage: number,
) {
    const renderedMatches = namesExpectedPage(observation, observation.renderedPage, expectedPage);
    const snapshotMatches = namesExpectedPage(observation, observation.snapshotPage, expectedPage);
    if (renderedMatches && !snapshotMatches) {
        return `the toolbar renders page ${String(expectedPage)} while the viewer's own snapshot reports ${String(observation.snapshotPage)}`;
    }
    if (snapshotMatches && !renderedMatches) {
        return observation.renderedPage === null
            ? 'the viewer reports the requested page while the toolbar renders no readable page number'
            : `the viewer reports the requested page while the toolbar still renders page ${String(observation.renderedPage)}`;
    }
    return `neither the rendered indicator (${String(observation.renderedPage)}) nor the viewer's snapshot (${String(observation.snapshotPage)}) reached it`;
}

export interface IWaitForToolbarPageIndicatorOptions {
    /** How long both channels must keep naming the page before it counts as settled. */
    settleMs?: number;
    timeoutMs?: number;
}

/**
 * Waits until the page a person reads in the toolbar and the page the viewer
 * reports internally are both `expectedPage`, and stay there. A disagreement
 * that survives the settle window is reported as a disagreement, not as a
 * plain timeout, because that is the shape of a frozen page counter.
 */
export async function waitForToolbarPageIndicator(
    page: Page,
    expectedPage: number,
    options: IWaitForToolbarPageIndicatorOptions = {},
) {
    const settleMs = options.settleMs ?? 250;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    let observation = await readToolbarPageIndicator(page);
    let agreedSince: number | null = null;

    while (Date.now() < deadline) {
        const agreed = namesExpectedPage(observation, observation.renderedPage, expectedPage)
            && namesExpectedPage(observation, observation.snapshotPage, expectedPage);
        if (!agreed) {
            agreedSince = null;
        } else {
            agreedSince ??= Date.now();
            if (Date.now() - agreedSince >= settleMs) {
                return observation;
            }
        }
        await delay(50);
        observation = await readToolbarPageIndicator(page);
    }

    throw new Error(
        `The viewer did not settle on page ${String(expectedPage)} within ${String(timeoutMs)}ms: `
        + `${explainDisagreement(observation, expectedPage)}. `
        + `Last observation: ${describeToolbarPageIndicator(observation)}`,
    );
}
