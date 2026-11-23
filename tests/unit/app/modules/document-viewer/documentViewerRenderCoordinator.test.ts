import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentPageSlotRegistry } from '@app/modules/document-viewer/page-slots/createDocumentPageSlotRegistry';
import { createDocumentViewerRenderCoordinator } from '@app/modules/document-viewer/runtime/createDocumentViewerRenderCoordinator';

describe('document viewer render coordinator', () => {
    it('makes feature replacement transactional across equal page numbers', async () => {
        const coordinator = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry());
        const outgoing = coordinator.createSession('pdf:1');
        const incoming = coordinator.createSession('djvu:2');
        let finishOutgoing!: () => void;
        const outgoingRender = outgoing.runPageRender(5, () => new Promise<void>((resolve) => {
            finishOutgoing = resolve;
        }));
        const incomingRender = incoming.runPageRender(5, async () => {});

        incoming.pageSlots.markMounted(5);
        outgoing.dispose();
        finishOutgoing();

        expect(incoming.pageSlots.isMounted(5)).toBe(true);
        await expect(outgoingRender).resolves.toMatchObject({committed: false});
        await expect(incomingRender).resolves.toMatchObject({committed: true});
    });

    it('keeps viewport and destination windows disjoint on long jumps', () => {
        const session = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry())
            .createSession('pdf:jump');
        expect(session.resolveMountedPages({
            currentPage: 1,
            destinationPage: 500,
            pageCount: 600,
            radius: 1,
        })).toEqual([
            1,
            2,
            499,
            500,
            501,
        ]);
    });

    it('admits viewport pages independently of a stale semantic page', () => {
        const session = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry())
            .createSession('djvu:viewport-authority');
        const pages = session.resolveMountedPages({
            currentPage: 17,
            pageCount: 1_532,
            radius: 2,
            viewportPages: [
                910,
                911,
                912,
            ],
        });

        expect(pages).toEqual([
            15,
            16,
            17,
            18,
            19,
            910,
            911,
            912,
        ]);
    });

    it('caps disjoint semantic and viewport windows without evicting their owners', () => {
        const session = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry())
            .createSession('djvu:bounded-viewport-authority');
        const viewportPages = Array.from({length: 25}, (_, index) => 900 + index);
        const pages = session.resolveMountedPages({
            currentPage: 17,
            destinationPage: 1_200,
            maxPages: 40,
            pageCount: 1_532,
            radius: 12,
            viewportPages,
        });

        expect(pages).toHaveLength(40);
        expect(pages).toEqual([...pages].sort((left, right) => left - right));
        expect(pages).toEqual(expect.arrayContaining(viewportPages));
        expect(pages).toContain(17);
        expect(pages).toContain(1_200);
    });

    it('owns render scheduling and rejects a completion after session replacement', async () => {
        const coordinator = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry());
        const outgoing = coordinator.createSession('pdf:render-old');
        let finish!: (value: string) => void;
        const pending = outgoing.runPageRender(3, () => new Promise<string>((resolve) => {
            finish = resolve;
        }));
        outgoing.dispose();
        const incoming = coordinator.createSession('djvu:render-new');
        const latest = incoming.runPageRender(3, async () => 'new');
        finish('old');

        await expect(pending).resolves.toMatchObject({
            committed: false,
            value: 'old',
        });
        await expect(latest).resolves.toMatchObject({
            committed: true,
            value: 'new',
        });
    });

    it('commits only the latest attempt of a page and carries its identity', async () => {
        const session = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry())
            .createSession('djvu:replace');
        let finishFirst!: () => void;
        const first = session.runPageRender(4, () => new Promise<void>((resolve) => {
            finishFirst = resolve;
        }));
        const replacement = session.runPageRender(4, async attempt => attempt);
        finishFirst();

        const [
            firstOutcome,
            replacementOutcome,
        ] = await Promise.all([
            first,
            replacement,
        ]);
        expect(firstOutcome.committed).toBe(false);
        expect(replacementOutcome.committed).toBe(true);
        // The renderer sees the attempt the session commits, not a translation.
        expect(replacementOutcome.value).toBe(replacementOutcome.attempt);
        expect(replacementOutcome.attempt.pageNumber).toBe(4);
        expect(replacementOutcome.attempt.requestId).toBeGreaterThan(firstOutcome.attempt.requestId);
    });

    it('fails a render without committing it', async () => {
        const session = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry())
            .createSession('djvu:fail');
        await expect(session.runPageRender(2, async () => {
            throw new Error('render failed');
        })).rejects.toThrow('render failed');
        await expect(session.runPageRender(2, async () => 'retry')).resolves.toMatchObject({committed: true});
    });

    it('forgets a page attempt when the page leaves residency', async () => {
        const session = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry())
            .createSession('djvu:release-page');
        let finish!: () => void;
        const pending = session.runPageRender(8, () => new Promise<void>((resolve) => {
            finish = resolve;
        }));

        session.releasePage(8);
        finish();

        await expect(pending).resolves.toMatchObject({committed: false});
    });
});
