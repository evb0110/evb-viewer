import {
    appendFileSync,
    mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';

/**
 * Calibration runs ask whether the observation path reports the symptom a
 * historical fix repaired. They therefore record what was seen before anything
 * decides on it, on both sides of the revert, and the ground truth is read from
 * the DOM here rather than borrowed from the checker under calibration.
 */
const DEFAULT_RUN_DIRECTORY = join(projectRoot, '.devkit', 'methodology', 'calibration', 'unlabelled');

export function calibrationRunDirectory() {
    return process.env.EVB_CALIBRATION_RUN_DIR ?? DEFAULT_RUN_DIRECTORY;
}

export function recordCalibrationObservation(caseName: string, payload: Record<string, unknown>) {
    const directory = calibrationRunDirectory();
    mkdirSync(directory, {recursive: true});
    appendFileSync(
        join(directory, `${caseName}.jsonl`),
        `${JSON.stringify({
            at: new Date().toISOString(),
            side: process.env.EVB_CALIBRATION_SIDE ?? 'unlabelled',
            ...payload,
        })}\n`,
    );
}

export interface ICalibrationRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

export interface ICalibrationGeometry {
    documentXAtViewportCentre: number | null;
    horizontalScrollRange: number;
    noteWindows: Array<{
        annotationId: string | null;
        rect: ICalibrationRect;
    }>;
    pages: Array<{
        pageNumber: number;
        rect: ICalibrationRect;
    }>;
    scrollLeft: number;
    scrollTop: number;
    viewportRect: ICalibrationRect;
    zoomText: string | null;
}

/**
 * The screen positions the calibration reasons about, read independently of
 * `checkViewerInvariants` so a checker that reports nothing can still be
 * compared against what actually moved.
 */
export async function readCalibrationGeometry(page: Page): Promise<ICalibrationGeometry> {
    return evaluateInPage(page, () => {
        const toRect = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return {
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
            };
        };
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };
        const visibleHosts = [...document.querySelectorAll<HTMLElement>('.workspace-host')].filter(isVisibleHost);
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts[0] ?? null);
        const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport], .pdfViewer') ?? null;
        const viewportRect = viewport
            ? toRect(viewport)
            : {
                height: 0,
                left: 0,
                top: 0,
                width: 0,
            };
        const pages = [...(host?.querySelectorAll<HTMLElement>('.page_container[data-page]') ?? [])].map(container => ({
            pageNumber: Number.parseInt(container.getAttribute('data-page') ?? '0', 10),
            rect: toRect(container),
        }));
        const centreX = viewportRect.left + viewportRect.width / 2;
        const centreY = viewportRect.top + viewportRect.height / 2;
        const centrePage = pages.find(entry => (
            entry.rect.top <= centreY && entry.rect.top + entry.rect.height >= centreY
        )) ?? pages[0] ?? null;
        return {
            documentXAtViewportCentre: centrePage && centrePage.rect.width > 0
                ? (centreX - centrePage.rect.left) / centrePage.rect.width
                : null,
            horizontalScrollRange: viewport ? Math.max(0, viewport.scrollWidth - viewport.clientWidth) : 0,
            noteWindows: [...document.querySelectorAll<HTMLElement>('.note-window')].map(windowElement => ({
                annotationId: windowElement.getAttribute('data-annotation-id'),
                rect: toRect(windowElement),
            })),
            pages,
            scrollLeft: viewport?.scrollLeft ?? 0,
            scrollTop: viewport?.scrollTop ?? 0,
            viewportRect,
            zoomText: document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')
                ?.textContent?.trim() ?? null,
        };
    });
}

/** The page box the calibration follows, by physical page number. */
export function findCalibrationPage(geometry: ICalibrationGeometry, pageNumber: number) {
    return geometry.pages.find(entry => entry.pageNumber === pageNumber) ?? null;
}
