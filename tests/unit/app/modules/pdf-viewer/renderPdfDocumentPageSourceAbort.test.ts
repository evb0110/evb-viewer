import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import { createWorkspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import { renderPdfDocumentPageSource } from '@app/modules/pdf-viewer/runtime/renderPdfDocumentPageSource';

describe('renderPdfDocumentPageSource abort window', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Loading the page is the one await between the request's abort check and
    // the render task it hands the signal to, so a navigation that lands there
    // has to reach pdf.js as a cancel rather than being left to finish.
    it('cancels the render task for a request aborted while its page loaded', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
            .mockReturnValue(cast<CanvasRenderingContext2D>({}));
        const controller = new AbortController();
        const cancel = vi.fn();
        const page = cast<IPdfPage>({
            getViewport: ({scale}: {scale: number}) => ({
                width: 100 * scale,
                height: 200 * scale,
            }),
            render: () => ({
                promise: Promise.resolve(),
                cancel,
            }),
        });
        const document = cast<IPdfDocument>({getPage: async () => {
            controller.abort(new DOMException('Navigated away', 'AbortError'));
            return page;
        }});

        await expect(renderPdfDocumentPageSource({
            document,
            request: {
                pageNumber: 1,
                widthPx: 100,
                priority: 'navigation',
                signal: controller.signal,
            },
            scopeId: 'pane-1',
            surfaceBudget: createWorkspaceSurfaceBudgetController(64 * 1024 * 1024),
        })).rejects.toMatchObject({name: 'AbortError'});

        expect(cancel).toHaveBeenCalledOnce();
    });
});
