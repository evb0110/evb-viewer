import type {Page} from 'puppeteer-core';
import type * as TViewerCore from '@tests/e2e/electron/helpers/viewerCore';
import type * as TViewerDom from '@tests/e2e/electron/helpers/viewerDom';
import type * as TWorkspaceExpose from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createFreeTextAnnotationWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';

const mocks = vi.hoisted(() => ({
    callWorkspaceCommand: vi.fn(),
    findVisiblePointInActiveHost: vi.fn(),
    installWorkspaceExposeProbe: vi.fn(async () => undefined),
    openAnnotationsTab: vi.fn(async () => undefined),
    waitForViewerInteractive: vi.fn(),
}));

vi.mock('@tests/e2e/electron/helpers/viewerCore', async importOriginal => ({
    ...await importOriginal<typeof TViewerCore>(),
    openAnnotationsTab: mocks.openAnnotationsTab,
    waitForViewerInteractive: mocks.waitForViewerInteractive,
}));
vi.mock('@tests/e2e/electron/helpers/viewerDom', async importOriginal => ({
    ...await importOriginal<typeof TViewerDom>(),
    findVisiblePointInActiveHost: mocks.findVisiblePointInActiveHost,
}));
vi.mock('@tests/e2e/electron/helpers/workspaceExpose', async importOriginal => ({
    ...await importOriginal<typeof TWorkspaceExpose>(),
    callWorkspaceCommand: mocks.callWorkspaceCommand,
    installWorkspaceExposeProbe: mocks.installWorkspaceExposeProbe,
}));

afterEach(() => {
    vi.restoreAllMocks();
});

describe('free text stress creation', () => {
    it('activates the visible Text tool and bounds each pointer wait', async () => {
        const waitOptions: Array<{timeout?: number}> = [];
        const waitArguments: unknown[][] = [];
        let evaluateCount = 0;
        const toolbarPoint = {
            x: 20,
            y: 30,
        };
        const pagePoint = {
            x: 120,
            y: 140,
        };
        mocks.findVisiblePointInActiveHost.mockResolvedValue(toolbarPoint);

        const fakePage = Object.assign(Object.create(null) as Page, {
            evaluate: vi.fn(async () => {
                evaluateCount += 1;
                if (evaluateCount === 1) {
                    return 0;
                }
                if (evaluateCount === 2) {
                    return 'select';
                }
                if (evaluateCount === 3) {
                    return pagePoint;
                }
                return 1;
            }),
            keyboard: {
                down: vi.fn(async () => undefined),
                press: vi.fn(async () => undefined),
                type: vi.fn(async () => undefined),
                up: vi.fn(async () => undefined),
            },
            mouse: {click: vi.fn(async () => undefined)},
            focus: vi.fn(async () => undefined),
            waitForSelector: vi.fn(async () => undefined),
            waitForFunction: vi.fn(async (predicate: (args: unknown) => boolean, options: {timeout?: number}, ...args: unknown[]) => {
                waitOptions.push(options);
                waitArguments.push(args);
                return undefined;
            }),
        });

        const result = await createFreeTextAnnotationWithPointer(fakePage, 'stress note 1', {
            x: 0.4,
            y: 0.3,
        }, 2);

        expect(result).toBe(1);
        expect(mocks.findVisiblePointInActiveHost).toHaveBeenCalledWith(
            fakePage,
            '.notes-panel .tool-button[data-tool="text"]',
        );
        expect(fakePage.mouse.click).toHaveBeenNthCalledWith(1, toolbarPoint.x, toolbarPoint.y);
        expect(fakePage.mouse.click).toHaveBeenNthCalledWith(2, pagePoint.x, pagePoint.y);
        expect(waitOptions).toHaveLength(4);
        expect(waitOptions.every(options => options.timeout === 30_000)).toBe(true);
        expect(waitArguments[1]).toEqual([2]);
        expect(waitArguments[2]).toEqual(['.editor-pane.is-active .page_container[data-page="2"] .pdf-annotation-editor-text-box.is-editing [contenteditable="true"]']);
        expect(waitArguments[3]).toEqual(['stress note 1']);
        expect(fakePage.waitForSelector).toHaveBeenCalledWith(
            '.editor-pane.is-active .page_container[data-page="2"] .pdf-annotation-editor-text-box.is-editing [contenteditable="true"]',
            {
                timeout: 30_000,
                visible: true,
            },
        );
        expect(fakePage.focus).not.toHaveBeenCalled();
        expect(fakePage.keyboard.type).toHaveBeenCalledWith('stress note 1', {delay: 10});
        expect(fakePage.keyboard.press).toHaveBeenCalledWith('Enter');
    });
});
