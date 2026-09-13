import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDocumentPageSlotRegistry } from '@app/modules/document-viewer/page-slots/createDocumentPageSlotRegistry';
import { createDocumentViewerRenderCoordinator } from '@app/modules/document-viewer/chassis/createDocumentViewerRenderCoordinator';

describe('document viewer render coordinator', () => {
    it('makes feature replacement transactional across equal page numbers', async () => {
        const coordinator = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry());
        const outgoing = coordinator.createSession('pdf:1');
        const incoming = coordinator.createSession('djvu:2');
        const incomingReady = incoming.pageSlots.whenMounted(5, new AbortController().signal);
        const oldGeneration = outgoing.beginPageRender(5);
        const newGeneration = incoming.beginPageRender(5);

        incoming.pageSlots.markMounted(5);
        outgoing.dispose();

        await expect(incomingReady).resolves.toBeUndefined();
        expect(incoming.pageSlots.isMounted(5)).toBe(true);
        expect(outgoing.commitPageRender(5, oldGeneration)).toBe(false);
        expect(incoming.commitPageRender(5, newGeneration)).toBe(true);
        expect(incoming.getPageVisual(5)).toBe('fresh');
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
        expect(incoming.getPageVisual(3)).toBe('fresh');
    });

    it('returns to a skeleton while replacing a fresh page and after a failed replacement', () => {
        const session = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry())
            .createSession('djvu:replace');
        const firstGeneration = session.beginPageRender(4);
        expect(session.commitPageRender(4, firstGeneration)).toBe(true);
        expect(session.getPageVisual(4)).toBe('fresh');

        const replacementGeneration = session.beginPageRender(4);
        expect(session.getPageVisual(4)).toBe('skeleton');
        expect(session.failPageRender(4, replacementGeneration)).toBe(true);
        expect(session.getPageVisual(4)).toBe('skeleton');
    });

    it('forgets visual state when a page leaves residency', () => {
        const session = createDocumentViewerRenderCoordinator(createDocumentPageSlotRegistry())
            .createSession('djvu:release-page');
        const generation = session.beginPageRender(8);
        expect(session.commitPageRender(8, generation)).toBe(true);
        expect(session.getPageVisual(8)).toBe('fresh');

        session.releasePage(8);

        expect(session.getPageVisual(8)).toBe('skeleton');
        expect(session.commitPageRender(8, generation)).toBe(false);
    });
});
