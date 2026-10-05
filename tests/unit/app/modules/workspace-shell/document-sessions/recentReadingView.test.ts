import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRef } from '@contracts/documentRef';
import type {
    IPdfSemanticAnchor,
    IRecentReadingView,
} from '@contracts/recentReadingView';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

const recent = vi.hoisted(() => ({readingView: vi.fn<(source: string) => Promise<IRecentReadingView | null>>()}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentRecentFilesCapability: () => ({recentFiles: recent})}));

const {
    followOpeningReader,
    finishOpeningReader,
    seedOpeningSource,
} = await import('@app/modules/workspace-shell/document-sessions/recentReadingView');

const source = requireDocumentRef('/tmp/working.pdf');
const remembered: IRecentReadingView = {
    currentPage: 27,
    pageCount: 40,
    zoom: 1.85,
    zoomMode: 'custom',
    viewMode: 'single',
    continuousScroll: true,
    viewRotation: 0,
};
const anchor: IPdfSemanticAnchor = {
    page: 27,
    pageXFraction: 0.5,
    pageYFraction: 0.3,
    viewportXFraction: 0.5,
    viewportYFraction: 0.5,
    affinity: 'center',
};

// An opening view: its open surface, claimed at page 1 as an open claims it,
// and the view settings and placed point a workspace shows for it.
function createOpeningView(readerMoved = () => false) {
    const openSurface = createDocumentOpenSurfaceSession();
    openSurface.begin({
        documentId: '/documents/remembered.pdf',
        documentRevision: 'open-intent:test',
        provisional: true,
    }, null, 1);
    const view = {
        zoom: 1,
        zoomMode: 'fit-width' as string,
        viewMode: 'facing' as string,
        placedAnchor: null as IPdfSemanticAnchor | null,
        seededSource: null as string | null,
    };
    const workspace: Pick<IWorkspaceExpose, 'followReader'> = {followReader: () => ({
        moved: readerMoved,
        seed: (state, seededSource) => {
            view.zoom = state.zoom ?? view.zoom;
            view.zoomMode = state.zoomMode ?? view.zoomMode;
            view.viewMode = state.viewMode ?? view.viewMode;
            view.seededSource = seededSource;
        },
        finish: async (placed) => {
            view.placedAnchor = placed;
        },
    })};
    const controller = createWorkspaceDocumentController({tabId: 'tab-a'});
    return {
        openSurface,
        view,
        controller,
        opening: followOpeningReader(controller, openSurface, workspace)!,
        readTarget: () => ({
            source: openSurface.navigationTicket.value?.request.source,
            target: openSurface.navigationTicket.value?.request.target,
        }),
    };
}

const openingPageOne = {
    source: 'restore',
    target: {
        kind: 'page',
        page: 1,
    },
};

describe('seeding a normal open from its reading view', () => {
    beforeEach(() => {
        recent.readingView.mockReset();
        recent.readingView.mockResolvedValue(remembered);
    });

    it('seeds the view its open began in, whichever view of the document is in use when the source arrives', async () => {
        const opening = createOpeningView();
        // A split view of the same document, in use by the time the source arrives.
        const linkedSurface = createDocumentOpenSurfaceSession();
        linkedSurface.begin({
            documentId: '/documents/remembered.pdf',
            documentRevision: 'open-intent:linked',
            provisional: true,
        }, null, 1);

        await seedOpeningSource(opening.controller, source, Promise.resolve(40));

        expect(opening.readTarget().target).toEqual({
            kind: 'page',
            page: 27,
        });
        expect(opening.view.zoom).toBe(1.85);
        expect(linkedSurface.navigationTicket.value?.request.target).toEqual({
            kind: 'page',
            page: 1,
        });
    });

    it('opens at the remembered page and view, as the opening\'s own restore', async () => {
        const opening = createOpeningView();

        await seedOpeningSource(opening.controller, source, Promise.resolve(40));

        expect(opening.readTarget()).toEqual({
            source: 'restore',
            target: {
                kind: 'page',
                page: 27,
            },
        });
        expect(opening.view).toMatchObject({
            zoom: 1.85,
            zoomMode: 'custom',
            viewMode: 'single',
            seededSource: source,
        });
    });

    it('keeps the defaults when the admitted source has another page count', async () => {
        const opening = createOpeningView();

        await seedOpeningSource(opening.controller, source, Promise.resolve(41));

        expect(opening.readTarget()).toEqual(openingPageOne);
        expect(opening.view.zoomMode).toBe('fit-width');
    });

    it('keeps the view of a reader who moved it while the open ran', async () => {
        const opening = createOpeningView(() => true);

        await seedOpeningSource(opening.controller, source, Promise.resolve(40));

        expect(opening.readTarget()).toEqual(openingPageOne);
        expect(opening.view.zoomMode).toBe('fit-width');
    });

    it('places a remembered anchor once a seeded open is presented, and none for a failed one', async () => {
        recent.readingView.mockResolvedValue({
            ...remembered,
            anchor,
        });
        const presented = createOpeningView();
        await seedOpeningSource(presented.controller, source, Promise.resolve(40));
        await finishOpeningReader(presented.controller, presented.opening, true);
        const failed = createOpeningView();
        await seedOpeningSource(failed.controller, source, Promise.resolve(40));
        await finishOpeningReader(failed.controller, failed.opening, false);

        expect(presented.view.placedAnchor).toEqual(anchor);
        expect(failed.view.placedAnchor).toBeNull();
    });
});
