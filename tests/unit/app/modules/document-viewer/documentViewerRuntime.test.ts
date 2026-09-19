// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import {
    createDocumentViewerRuntime,
    shouldAcceptFeaturePackRuntimePage,
    shouldApplyExternalRuntimePage,
} from '@app/modules/document-viewer/runtime/documentViewerRuntime';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import type { IDocumentPageSource } from '@app/modules/document-viewer/source/documentPageSource';
import { observeDocumentViewportWheelInteraction } from '@app/modules/document-viewer/runtime/documentViewportWritePort';
import {requireDocumentRef} from '@contracts/documentRef';

function createSource(kind: 'pdf' | 'djvu', pageCount: number): IDocumentPageSource {
    return {
        kind,
        documentRef: requireDocumentRef(`/document.${kind}`),
        pageCount,
        getPageMetrics: async () => ({
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        }),
        renderPage: async () => {
            throw new Error('Not used by the authority contract');
        },
        dispose() {},
    };
}

function wheelPacket(timeStamp: number, deltaY = 40, deltaX = 0, cancelable = false) {
    return {
        timeStamp,
        deltaX,
        deltaY,
        cancelable,
        preventDefault: vi.fn(),
    };
}

function scrollInteraction(timeStamp: number, deltaY = 40, deltaX = 0, cancelable = false) {
    return {
        intent: 'scroll' as const,
        deltaPx: deltaY,
        event: wheelPacket(timeStamp, deltaY, deltaX, cancelable),
    };
}

function createViewportContainer() {
    const container = document.createElement('div');
    // Keep the detached test viewport unbounded so the write port receives
    // the authored coordinates instead of happy-dom's zero-size geometry.
    Object.defineProperties(container, {
        scrollHeight: {
            configurable: true,
            value: Number.POSITIVE_INFINITY,
        },
        scrollWidth: {
            configurable: true,
            value: Number.POSITIVE_INFINITY,
        },
    });
    return container;
}

describe('document viewer chassis authority', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('scopes opening-page elements to a unique chassis instance', () => {
        const first = createDocumentViewerRuntime(ref('djvu'));
        const second = createDocumentViewerRuntime(ref('djvu'));
        const element = document.createElement('div');

        expect(first.instanceId).not.toBe(second.instanceId);
        expect(first.openingPageElement.value).toBeNull();
        first.bindOpeningPageElement(element);
        expect(first.openingPageElement.value).toBe(element);
        expect(second.openingPageElement.value).toBeNull();
        first.bindOpeningPageElement(null);
        expect(first.openingPageElement.value).toBeNull();
    });

    it('publishes opening-page visual state only through the connected owned frame', () => {
        vi.useFakeTimers();
        const authority = createDocumentViewerRuntime(ref('djvu'));
        const generation = authority.openSurface.begin({
            documentId: '/documents/scan.djvu',
            documentRevision: 'revision-1',
        });
        expect(authority.openSurface.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'chassis-owner',
            pageNumber: 3,
            intentKey: 'fit-width:1',
            style: {
                width: '600px',
                height: '800px',
            },
        })).toBe(true);
        const element = document.createElement('div');
        element.dataset.openSurfaceFrameOwner = 'chassis-owner';
        element.dataset.openSurfaceGeneration = String(generation);
        element.dataset.pageNumber = '3';
        document.body.append(element);
        authority.bindOpeningPageElement(element);

        expect(authority.commitOpeningPageVisual(generation - 1, 3, 'fresh')).toBe(false);
        expect(authority.commitOpeningPageVisual(generation, 2, 'fresh')).toBe(false);
        expect(authority.openingPageVisual.value).toBe('none');
        vi.advanceTimersByTime(120);
        expect(authority.openingPageVisual.value).toBe('skeleton');
        expect(authority.commitOpeningPageVisual(generation, 3, 'fresh')).toBe(true);
        expect(authority.openingPageVisual.value).toBe('fresh');
        authority.openSurface.begin({
            documentId: '/documents/next.djvu',
            documentRevision: 'revision-2',
        });
        expect(authority.openingPageVisual.value).toBe('none');
        vi.useRealTimers();
    });

    it('keeps one navigation, page-slot, and surface-budget authority across PDF and DjVu sources', async () => {
        const sourceKind = ref<'pdf' | 'djvu'>('pdf');
        const authority = createDocumentViewerRuntime(sourceKind, 2);
        const originalSlots = authority.pageSlots;
        const originalBudget = authority.surfaceBudget;
        const originalViewportWritePort = authority.viewportWritePort;
        authority.bindSource(createSource('pdf', 12));

        expect(authority.navigate(7)).toBe(7);
        const mounted = authority.pageSlots.whenMounted(7, new AbortController().signal);
        authority.pageSlots.markMounted(7);
        await expect(mounted).resolves.toBeUndefined();

        sourceKind.value = 'djvu';
        authority.bindSource(createSource('djvu', 12));

        expect(authority.sourceKind.value).toBe('djvu');
        expect(authority.currentPage.value).toBe(7);
        expect(authority.pageSlots).toBe(originalSlots);
        expect(authority.pageSlots.isMounted(7)).toBe(true);
        expect(authority.surfaceBudget).toBe(originalBudget);
        expect(authority.viewportWritePort).toBe(originalViewportWritePort);
    });

    it('clears an authored scroll origin for physical wheel input but preserves it for zoom', () => {
        const authority = createDocumentViewerRuntime(ref('pdf'));
        const container = createViewportContainer();

        authority.viewportWritePort.apply(container, {
            intent: authority.viewportWritePort.beginIntent('navigate:7'),
            reason: 'navigation',
            top: 700,
        });

        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(true);
        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(true);

        const staleAfterWheel = authority.viewportWritePort.beginIntent('resize-restore');
        observeDocumentViewportWheelInteraction(
            authority.viewportWritePort,
            scrollInteraction(0),
            container,
        );
        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(false);
        expect(authority.viewportWritePort.apply(container, {
            intent: staleAfterWheel,
            reason: 'stale-after-wheel',
            top: 725,
        })).toBe(false);

        const zoomIntent = authority.viewportWritePort.beginIntent('zoom-anchor-restore');
        expect(authority.viewportWritePort.apply(container, {
            intent: zoomIntent,
            reason: 'zoom-anchor',
            top: 730,
        })).toBe(true);
        observeDocumentViewportWheelInteraction(
            authority.viewportWritePort,
            {
                ...scrollInteraction(16),
                intent: 'zoom',
            },
            container,
        );
        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(true);
    });

    describe('a command issued during a fling', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        function scrollPacket(port: ReturnType<typeof createDocumentViewerRuntime>['viewportWritePort'], timeStamp: number, deltaY = 40) {
            return observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, deltaY));
        }

        it('outlives the inertial tail and lands where it aimed', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();

            expect(scrollPacket(port, 0)).toBe('user-input');
            expect(scrollPacket(port, 16)).toBe('user-input');
            port.fenceCommandAgainstLiveGesture(30);
            const navigation = port.beginIntent('navigate:734');

            expect(port.userScrollSuppressed.value).toBe(true);
            expect(scrollPacket(port, 32, 38)).toBe('command-residue');
            // Chromium coalesces packets under load, so a tail packet can be
            // larger than the one before it without being a new gesture.
            expect(scrollPacket(port, 96, 140)).toBe('command-residue');
            expect(port.isCommandResidueLive(100)).toBe(true);
            expect(port.apply(container, {
                intent: navigation,
                reason: 'navigation',
                top: 700,
            })).toBe(true);
        });

        it('yields to a new gesture after a quiet gap', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();

            scrollPacket(port, 0);
            port.fenceCommandAgainstLiveGesture(10);
            const navigation = port.beginIntent('navigate:734');

            expect(scrollPacket(port, 400)).toBe('user-input');
            expect(port.userScrollSuppressed.value).toBe(false);
            expect(port.isCommandResidueLive(400)).toBe(false);
            expect(port.apply(container, {
                intent: navigation,
                reason: 'navigation',
                top: 700,
            })).toBe(false);
        });

        it('treats a reversal as a new gesture, since inertia never reverses', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;

            scrollPacket(port, 0, -60);
            port.fenceCommandAgainstLiveGesture(10);

            expect(scrollPacket(port, 16, -55)).toBe('command-residue');
            expect(scrollPacket(port, 32, 20)).toBe('user-input');
            expect(port.userScrollSuppressed.value).toBe(false);
        });

        it('keeps a diagonal tail whose larger axis alternates as one gesture', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const diagonalPacket = (timeStamp: number, deltaY: number, deltaX: number) => (
                observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, deltaY, deltaX))
            );

            diagonalPacket(0, 12, 10);
            port.fenceCommandAgainstLiveGesture(10);

            expect(diagonalPacket(16, 9, 11)).toBe('command-residue');
            expect(diagonalPacket(32, 8, 7)).toBe('command-residue');
            expect(diagonalPacket(48, 0, 5)).toBe('command-residue');
            expect(diagonalPacket(64, -6, -5)).toBe('user-input');
        });

        it('scrolls a new sequence by hand when it begins while scrolling is suppressed', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();
            const send = (timeStamp: number, cancelable: boolean) => {
                const interaction = scrollInteraction(timeStamp, 40, 0, cancelable);
                return {
                    owner: observeDocumentViewportWheelInteraction(port, interaction, container),
                    prevented: interaction.event.preventDefault,
                };
            };

            // Chromium sends only the first event of a sequence as cancelable.
            send(0, true);
            send(16, false);
            port.fenceCommandAgainstLiveGesture(20);
            expect(send(32, false).owner).toBe('command-residue');
            expect(port.userScrollSuppressed.value).toBe(true);
            container.scrollTop = 700;

            // The user scrolls again at once, with no quiet gap. Chromium has
            // bound this sequence to a viewport it could not scroll, so
            // restoring scrolling cannot revive it; the viewer adopts it.
            const first = send(48, true);
            expect(first.owner).toBe('adopted-user-input');
            expect(first.prevented).toHaveBeenCalledOnce();
            expect(port.userScrollSuppressed.value).toBe(false);
            expect(container.scrollTop).toBe(740);

            // Preventing the first event keeps the rest of it cancelable.
            expect(send(64, true).owner).toBe('adopted-user-input');
            expect(container.scrollTop).toBe(780);

            // Once the restored style has settled, a later sequence is
            // Chromium's to scroll again.
            vi.advanceTimersByTime(400);
            const native = send(400, true);
            expect(native.owner).toBe('user-input');
            expect(native.prevented).not.toHaveBeenCalled();
            expect(container.scrollTop).toBe(780);
        });

        it('restores a landing that a late residue delta displaced', () => {
            vi.useFakeTimers();
            vi.spyOn(performance, 'now').mockReturnValue(30);
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();

            observeDocumentViewportWheelInteraction(port, scrollInteraction(0), container);
            port.fenceCommandAgainstLiveGesture(10);
            port.apply(container, {
                intent: port.beginIntent('navigate:1'),
                reason: 'navigation',
                top: 700,
            });

            // The compositor applied one more delta before suppression reached it.
            container.scrollTop = 837;

            expect(port.consumeAuthorityScroll(container)).toBe(true);
            expect(container.scrollTop).toBe(700);
            vi.restoreAllMocks();
        });

        it('falls back to the quiet gap when a prevented sequence keeps every packet cancelable', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const packet = (timeStamp: number) => (
                observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, true))
            );

            packet(0);
            packet(16);
            port.fenceCommandAgainstLiveGesture(20);

            expect(packet(32)).toBe('command-residue');
            expect(packet(48)).toBe('command-residue');

            // The tail went quiet, so the idle timer has restored scrolling
            // and the next sequence is Chromium's to scroll.
            vi.advanceTimersByTime(352);
            expect(port.userScrollSuppressed.value).toBe(false);
            expect(packet(400)).toBe('user-input');
        });

        it('restores scrolling as soon as the host reports the sequence over, and keeps late packets as residue', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();
            const send = (timeStamp: number, cancelable: boolean) => (
                observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable), container)
            );

            send(0, true);
            send(16, false);
            port.fenceCommandAgainstLiveGesture(20);
            const navigation = port.beginIntent('navigate:734');
            expect(port.userScrollSuppressed.value).toBe(true);

            port.observeWheelScrollSequence('end');
            expect(port.userScrollSuppressed.value).toBe(false);

            // The signal overtook the gesture's last packets, which were
            // waiting behind a busy main thread. The command has not landed
            // yet, so they must not read as the user taking the viewport.
            expect(send(32, false)).toBe('command-residue');

            // On a slow machine a trailing packet can be delivered long after
            // the signal, well past any idle window.
            vi.advanceTimersByTime(900);
            expect(send(48, false)).toBe('command-residue');
            expect(port.apply(container, {
                intent: navigation,
                reason: 'navigation',
                top: 700,
            })).toBe(true);

            // The next gesture is the user's and releases the ownership.
            expect(send(1_400, true)).toBe('user-input');
        });

        it('adopts a sequence that begins before the restored style can have reached the compositor', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();
            const send = (timeStamp: number, cancelable: boolean) => (
                observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable), container)
            );

            send(0, true);
            send(16, false);
            port.fenceCommandAgainstLiveGesture(20);
            port.observeWheelScrollSequence('end');

            expect(send(40, true)).toBe('adopted-user-input');
            expect(container.scrollTop).toBe(40);
        });

        it('leaves a sequence to Chromium once the restored style has settled', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();
            const send = (timeStamp: number, cancelable: boolean) => {
                const interaction = scrollInteraction(timeStamp, 40, 0, cancelable);
                return {
                    owner: observeDocumentViewportWheelInteraction(port, interaction, container),
                    prevented: interaction.event.preventDefault,
                };
            };

            send(0, true);
            send(16, false);
            port.fenceCommandAgainstLiveGesture(20);
            port.observeWheelScrollSequence('end');
            vi.advanceTimersByTime(400);

            const native = send(420, true);
            expect(native.owner).toBe('user-input');
            expect(native.prevented).not.toHaveBeenCalled();
            expect(container.scrollTop).toBe(0);
        });

        it('keeps one fling together when a slow machine delivers it as a few distant packets', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();
            const send = (timeStamp: number, cancelable: boolean) => (
                observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable), container)
            );

            // Measured under a 6x CPU slowdown: one fling arrived as ten
            // packets with a 192 ms median gap and gaps up to 334 ms.
            send(0, true);
            port.observeWheelScrollSequence('begin');
            send(300, false);
            send(620, false);

            // The click comes 280 ms after the last packet. Timing alone would
            // call the gesture over; the host still has the sequence open.
            port.fenceCommandAgainstLiveGesture(900);
            const navigation = port.beginIntent('navigate:1');
            expect(port.userScrollSuppressed.value).toBe(true);

            expect(send(950, false)).toBe('command-residue');
            expect(send(1_290, false)).toBe('command-residue');
            // A quiet gap means nothing while the sequence is open.
            vi.advanceTimersByTime(600);
            expect(port.userScrollSuppressed.value).toBe(true);
            expect(port.apply(container, {
                intent: navigation,
                reason: 'navigation',
                top: 0,
            })).toBe(true);

            port.observeWheelScrollSequence('end');
            expect(port.userScrollSuppressed.value).toBe(false);
        });

        it('does not let the late packets of an ended sequence reopen it', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const send = (timeStamp: number, cancelable: boolean) => (
                observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable))
            );

            send(0, true);
            port.observeWheelScrollSequence('begin');
            send(16, false);
            port.observeWheelScrollSequence('end');
            // Overtaken by the signal, delivered after it.
            send(32, false);

            // Long after, with nothing in flight, a command must not suppress
            // scrolling for a sequence that is already over.
            port.fenceCommandAgainstLiveGesture(5_000);
            expect(port.userScrollSuppressed.value).toBe(false);
        });

        it('restores scrolling once the tail goes quiet', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;

            scrollPacket(port, 0);
            port.fenceCommandAgainstLiveGesture(10);
            scrollPacket(port, 16);
            vi.advanceTimersByTime(199);
            expect(port.userScrollSuppressed.value).toBe(true);

            vi.advanceTimersByTime(1);
            expect(port.userScrollSuppressed.value).toBe(false);
        });

        it('leaves scrolling alone when no gesture is in flight', () => {
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;

            scrollPacket(port, 0);
            port.fenceCommandAgainstLiveGesture(500);

            expect(port.userScrollSuppressed.value).toBe(false);
            expect(scrollPacket(port, 510)).toBe('user-input');
        });
    });

    it('resets a stale viewport offset synchronously when a document generation begins', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);
        const container = createViewportContainer();
        container.scrollLeft = 7;
        container.scrollTop = 4;
        authority.bindViewportElement(container);

        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });

        expect(container.scrollLeft).toBe(0);
        expect(container.scrollTop).toBe(0);
        expect(authority.viewportWritePort.consumeAuthorityScroll(container)).toBe(true);
    });

    it('rejects stale continuations after supersession, user input, and source revision changes', () => {
        const authority = createDocumentViewerRuntime(ref('pdf'));
        const container = createViewportContainer();
        const staleByIntent = authority.viewportWritePort.beginIntent('navigate:old');
        const current = authority.viewportWritePort.beginIntent('navigate:new');

        expect(authority.viewportWritePort.apply(container, {
            intent: staleByIntent,
            reason: 'late-old-navigation',
            top: 100,
        })).toBe(false);
        expect(authority.viewportWritePort.apply(container, {
            intent: current,
            reason: 'latest-navigation',
            top: 200,
        })).toBe(true);
        expect(container.scrollTop).toBe(200);

        const staleByInteraction = authority.viewportWritePort.beginIntent('resize-restore');
        authority.viewportWritePort.observeUserScroll(container);
        expect(authority.viewportWritePort.apply(container, {
            intent: staleByInteraction,
            reason: 'late-resize',
            top: 300,
        })).toBe(false);

        const staleByDocument = authority.viewportWritePort.beginIntent('document-a-restore');
        authority.bindSource(createSource('pdf', 4));
        expect(authority.viewportWritePort.apply(container, {
            intent: staleByDocument,
            reason: 'late-document-a',
            top: 400,
        })).toBe(false);
        expect(container.scrollTop).toBe(200);
    });

    it('rebinds feature presentation and events without replacing the chassis viewport', () => {
        const authority = createDocumentViewerRuntime(ref('pdf'));
        const container = createViewportContainer();
        const received: string[] = [];
        const interaction = {
            deltaPx: 120,
            event: new WheelEvent('wheel'),
            intent: 'platform-scroll' as const,
        };
        authority.bindViewportElement(container);

        const releasePdf = authority.bindViewportFeature({
            getClass: () => 'pdfViewer',
            getStyle: () => ({zoom: 2}),
            events: {scroll: () => received.push('pdf')},
            wheel: value => received.push(`pdf-${value.intent}`),
        });
        authority.dispatchViewportEvent('scroll');
        authority.dispatchViewportWheel(interaction);
        expect(authority.viewportElement.value).toBe(container);
        expect(authority.viewportClass.value).toBe('pdfViewer');

        releasePdf();
        authority.bindViewportFeature({
            getClass: () => 'document-source-viewer',
            getStyle: () => ({}),
            events: {scroll: () => received.push('djvu')},
            wheel: value => received.push(`djvu-${value.intent}`),
        });
        authority.dispatchViewportEvent('scroll');
        authority.dispatchViewportWheel(interaction);

        expect(authority.viewportElement.value).toBe(container);
        expect(authority.viewportClass.value).toBe('document-source-viewer');
        expect(received).toEqual([
            'pdf',
            'pdf-platform-scroll',
            'djvu',
            'djvu-platform-scroll',
        ]);
    });

    it('rejects a feature pack that attempts to bind a source of the wrong kind', () => {
        const authority = createDocumentViewerRuntime(ref('pdf'));

        expect(() => authority.bindSource(createSource('djvu', 3))).toThrow(
            'Cannot bind djvu source to pdf chassis',
        );
    });

    it('clamps navigation only after the source page count is known', () => {
        const authority = createDocumentViewerRuntime(ref('djvu'));

        expect(authority.navigate(20)).toBe(20);
        authority.pageCount.value = 8;
        expect(authority.navigate(20)).toBe(8);
        expect(authority.navigate(-4)).toBe(1);
    });

    it('delegates navigation dedupe to the owned open-surface session', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        const requestNavigation = vi.spyOn(openSurface, 'requestNavigation');
        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);

        expect(authority.navigate(1)).toBe(1);
        expect(requestNavigation).toHaveBeenCalledOnce();
        expect(requestNavigation).toHaveBeenCalledWith(1);
    });

    it('mounts on the latest opening-session intent instead of the stale initial page', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        for (let page = 2; page <= 6; page += 1) {
            openSurface.requestNavigation(page);
        }

        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);

        expect(openSurface.viewportSession.value.requestedPage).toBe(6);
        expect(authority.currentPage.value).toBe(6);
        expect(shouldApplyExternalRuntimePage(openSurface.viewportSession.value, 1)).toBe(false);
        expect(shouldApplyExternalRuntimePage(openSurface.viewportSession.value, 6)).toBe(true);
        expect(shouldApplyExternalRuntimePage({
            ...openSurface.viewportSession.value,
            lifecycle: 'transitioning',
        }, 1)).toBe(false);
        expect(shouldAcceptFeaturePackRuntimePage(openSurface.viewportSession.value, 1)).toBe(false);
        expect(shouldAcceptFeaturePackRuntimePage(openSurface.viewportSession.value, 6)).toBe(true);
        expect(shouldAcceptFeaturePackRuntimePage({
            ...openSurface.viewportSession.value,
            committedPage: 6,
        }, 7)).toBe(false);
        expect(shouldAcceptFeaturePackRuntimePage({
            ...openSurface.viewportSession.value,
            requestedPage: 7,
            committedPage: 6,
        }, 7)).toBe(true);
    });

    it('rejects navigation without a document owner instead of leaking it into the next open', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);

        expect(shouldAcceptFeaturePackRuntimePage(openSurface.viewportSession.value, 6)).toBe(false);

        for (let page = 2; page <= 6; page += 1) {
            authority.navigate(page);
        }
        expect(authority.currentPage.value).toBe(6);
        expect(openSurface.viewportSession.value.identity).toBeNull();

        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });

        expect(openSurface.viewportSession.value.requestedPage).toBe(1);
        expect(authority.currentPage.value).toBe(1);
    });
});
