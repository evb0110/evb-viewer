import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    ref,
    watch,
} from 'vue';
import { createWorkspacePageNavigationFence } from '@app/modules/workspace-shell/viewers/createWorkspacePageNavigationFence';
import {
    createDocumentOpenSurfaceSession,
    type IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';

describe('createWorkspacePageNavigationFence', () => {
    const openSurfaces: IDocumentOpenSurfaceSession[] = [];

    function createTrackedOpenSurface() {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurfaces.push(openSurface);
        return openSurface;
    }

    afterEach(() => {
        for (const openSurface of openSurfaces.splice(0)) {
            openSurface.reset();
        }
    });

    it('does not arm a fence for an already-authoritative ready page', () => {
        const openSurface = createTrackedOpenSurface();
        const generation = openSurface.begin({
            documentId: 'document',
            documentRevision: 'revision',
        });
        openSurface.metadataReady(10);
        const fence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 1,
            renderVersion: 1,
            requestId: 1,
        });
        expect(fence).not.toBeNull();
        expect(openSurface.commitGeometry(generation, {
            height: 100,
            margin: 0,
            width: 100,
        })).toBe(true);
        expect(openSurface.commitCanvas(fence!)).toBe(true);
        expect(openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation: openSurface.snapshot.value.generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 1,
            top: 0,
            viewportIntentId: fence!.viewportIntentId,
        })).toBe(true);
        expect(openSurface.markReady(fence!)).toBe(true);

        const navigationFence = createWorkspacePageNavigationFence({
            currentPage: ref(1),
            openSurface,
        });
        navigationFence.begin(1);

        expect(navigationFence.targetPage.value).toBeNull();
        expect(navigationFence.consumePageUpdate(2)).toEqual({
            accepted: true,
            navigationSource: null,
        });
    });

    it('releases a genuine target after the surface records physical-input supersession', () => {
        const openSurface = createTrackedOpenSurface();
        const generation = openSurface.begin({
            documentId: 'document',
            documentRevision: 'revision',
        });
        openSurface.metadataReady(10);
        const fence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 1,
            renderVersion: 1,
            requestId: 1,
        })!;
        openSurface.commitGeometry(generation, {
            height: 100,
            margin: 0,
            width: 100,
        });
        openSurface.commitCanvas(fence);
        openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 1,
            top: 0,
            viewportIntentId: fence.viewportIntentId,
        });
        openSurface.markReady(fence);
        const navigationFence = createWorkspacePageNavigationFence({
            currentPage: ref(1),
            openSurface,
        });

        navigationFence.begin(5);
        openSurface.requestNavigation(5);
        expect(openSurface.observeViewportPage(2, {supersedeNavigation: true})).toBe(2);

        expect(navigationFence.consumePageUpdate(2)).toEqual({
            accepted: true,
            navigationSource: null,
        });
        expect(navigationFence.targetPage.value).toBeNull();
    });

    it('releases a replay target when a ready surface later moves away from it', () => {
        const openSurface = createTrackedOpenSurface();
        const generation = openSurface.begin({
            documentId: 'document',
            documentRevision: 'revision',
        });
        openSurface.metadataReady(10);
        const openingFence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 1,
            renderVersion: 1,
            requestId: 1,
        })!;
        openSurface.commitGeometry(generation, {
            height: 100,
            margin: 0,
            width: 100,
        });
        openSurface.commitCanvas(openingFence);
        openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 1,
            top: 0,
            viewportIntentId: openingFence.viewportIntentId,
        });
        openSurface.markReady(openingFence);
        const navigationFence = createWorkspacePageNavigationFence({
            currentPage: ref(5),
            openSurface,
        });

        navigationFence.begin(5);
        openSurface.requestNavigation(5);
        expect(navigationFence.targetPage.value).toBe(5);
        navigationFence.begin(5);
        openSurface.requestNavigation(5);
        expect(navigationFence.targetPage.value).toBe(5);
        const settledFence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 5,
            renderVersion: 1,
            requestId: 2,
        })!;
        openSurface.commitCanvas(settledFence);
        openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 5,
            top: 0,
            viewportIntentId: settledFence.viewportIntentId,
        });
        openSurface.markReady(settledFence);
        expect(openSurface.observeViewportPage(6)).toBe(6);
        expect(openSurface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            observedPage: 6,
            requestedPage: 5,
        });

        expect(navigationFence.consumePageUpdate(6)).toEqual({
            accepted: true,
            navigationSource: null,
        });
        expect(navigationFence.targetPage.value).toBeNull();
    });

    it('does not settle a target from page projections while the surface is transitioning', () => {
        const currentPage = ref(1);
        const openSurface = createTrackedOpenSurface();
        const generation = openSurface.begin({
            documentId: 'document',
            documentRevision: 'revision',
        });
        openSurface.metadataReady(500);
        const openingFence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 1,
            renderVersion: 1,
            requestId: 1,
        })!;
        openSurface.commitGeometry(generation, {
            height: 100,
            margin: 0,
            width: 100,
        });
        openSurface.commitCanvas(openingFence);
        openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 1,
            top: 0,
            viewportIntentId: openingFence.viewportIntentId,
        });
        openSurface.markReady(openingFence);
        expect(openSurface.observeViewportPage(431)).toBe(431);
        expect(openSurface.viewportSession.value).toMatchObject({
            committedPage: 1,
            lifecycle: 'ready',
            observedPage: 431,
            requestedPage: 1,
        });

        const navigationFence = createWorkspacePageNavigationFence({
            currentPage,
            openSurface,
        });
        navigationFence.begin(1);
        openSurface.requestNavigation(1);

        expect(openSurface.viewportSession.value.lifecycle).toBe('transitioning');
        expect(navigationFence.consumePageUpdate(1)).toEqual({
            accepted: false,
            navigationSource: null,
        });
        expect(navigationFence.targetPage.value).toBe(1);
        expect(currentPage.value).toBe(1);
        expect(navigationFence.consumePageUpdate(431)).toEqual({
            accepted: false,
            navigationSource: null,
        });
        expect(navigationFence.targetPage.value).toBe(1);
        expect(currentPage.value).toBe(1);
    });

    it('retains strict stale-page rejection for a genuine target', () => {
        const navigationFence = createWorkspacePageNavigationFence({currentPage: ref(1)});
        navigationFence.begin(5);

        expect(navigationFence.consumePageUpdate(4)).toEqual({
            accepted: false,
            navigationSource: null,
        });
        expect(navigationFence.targetPage.value).toBe(5);
        expect(navigationFence.consumePageUpdate(5)).toEqual({
            accepted: true,
            navigationSource: null,
        });
        expect(navigationFence.targetPage.value).toBeNull();
    });

    it('owns metadata clamping of an active target', () => {
        const navigationFence = createWorkspacePageNavigationFence({currentPage: ref(1)});
        navigationFence.begin(12);

        navigationFence.clampTo(10);

        expect(navigationFence.targetPage.value).toBe(10);
        expect(navigationFence.consumePageUpdate(12).accepted).toBe(false);
        expect(navigationFence.consumePageUpdate(10).accepted).toBe(true);
        expect(navigationFence.targetPage.value).toBeNull();
    });

    it('commits an accepted page to the workspace current page', () => {
        const currentPage = ref(1);
        const navigationFence = createWorkspacePageNavigationFence({currentPage});

        navigationFence.begin(5, 'toolbar');
        expect(navigationFence.consumePageUpdate(3).accepted).toBe(false);
        expect(currentPage.value).toBe(1);

        expect(navigationFence.consumePageUpdate(5).accepted).toBe(true);
        expect(currentPage.value).toBe(5);
    });

    it('reports the source that armed the settled target', () => {
        const navigationFence = createWorkspacePageNavigationFence({currentPage: ref(1)});
        navigationFence.begin(5, 'bookmark');

        expect(navigationFence.consumePageUpdate(5)).toEqual({
            accepted: true,
            navigationSource: 'bookmark',
        });
        // The source is released with the target, so the next unattributed
        // navigation cannot inherit it.
        navigationFence.begin(7);
        expect(navigationFence.consumePageUpdate(7)).toEqual({
            accepted: true,
            navigationSource: null,
        });
    });

    it('attributes no source to a page the surface superseded the target with', () => {
        const openSurface = createTrackedOpenSurface();
        const generation = openSurface.begin({
            documentId: 'document',
            documentRevision: 'revision',
        });
        openSurface.metadataReady(10);
        const fence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 1,
            renderVersion: 1,
            requestId: 1,
        })!;
        openSurface.commitGeometry(generation, {
            height: 100,
            margin: 0,
            width: 100,
        });
        openSurface.commitCanvas(fence);
        openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 1,
            top: 0,
            viewportIntentId: fence.viewportIntentId,
        });
        openSurface.markReady(fence);
        const navigationFence = createWorkspacePageNavigationFence({
            currentPage: ref(1),
            openSurface,
        });

        navigationFence.begin(5, 'thumbnail');
        openSurface.requestNavigation(5);
        expect(openSurface.observeViewportPage(2, {supersedeNavigation: true})).toBe(2);

        // Page 2 is where the user scrolled, not where the thumbnail click asked
        // to go, so the thumbnail must not be credited with it.
        expect(navigationFence.consumePageUpdate(2)).toEqual({
            accepted: true,
            navigationSource: null,
        });
    });

    it('keeps the arming source when viewer feedback re-arms the same target', () => {
        const navigationFence = createWorkspacePageNavigationFence({currentPage: ref(1)});

        navigationFence.begin(9, 'bookmark');
        // PDF.js feedback replays the in-flight target and knows no source.
        navigationFence.begin(9);

        expect(navigationFence.consumePageUpdate(9)).toEqual({
            accepted: true,
            navigationSource: 'bookmark',
        });
    });

    it('drops the previous source when a different target supersedes it', () => {
        const navigationFence = createWorkspacePageNavigationFence({currentPage: ref(1)});

        navigationFence.begin(9, 'bookmark');
        navigationFence.begin(4);

        expect(navigationFence.consumePageUpdate(4)).toEqual({
            accepted: true,
            navigationSource: null,
        });
    });

    it('never exposes a released target next to an uncommitted current page', () => {
        const currentPage = ref(1);
        const navigationFence = createWorkspacePageNavigationFence({currentPage});
        const observedNavigationPages: number[] = [];
        watch(
            navigationFence.targetPage,
            () => observedNavigationPages.push(navigationFence.navigationPage.value),
            {flush: 'sync'},
        );

        navigationFence.begin(5, 'toolbar');
        expect(navigationFence.navigationPage.value).toBe(5);

        navigationFence.consumePageUpdate(5);

        // Arming reports the target; releasing it reports the committed page.
        // A regression that clears the target before writing `currentPage`
        // records 1 here and makes held paging keys step from a stale page.
        expect(observedNavigationPages).toEqual([
            5,
            5,
        ]);
        expect(navigationFence.navigationPage.value).toBe(5);
    });
});
