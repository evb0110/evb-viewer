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
} from '@app/modules/document-viewer/runtime/documentViewerRuntime';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import { createPageNavigationRequest } from '@app/modules/document-viewer/navigation/documentNavigationRequest';
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
    const packet = {
        timeStamp,
        deltaX,
        deltaY,
        cancelable,
        defaultPrevented: false,
        preventDefault: vi.fn(() => {
            packet.defaultPrevented = packet.cancelable;
        }),
    };
    return packet;
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
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        const authority = createDocumentViewerRuntime(sourceKind, 2, openSurface);
        const originalSlots = authority.pageSlots;
        const originalBudget = authority.surfaceBudget;
        const originalViewportWritePort = authority.viewportWritePort;
        authority.bindSource(createSource('pdf', 12));

        const request = createPageNavigationRequest(7, 'toolbar');
        const ticket = authority.navigate(request);
        expect(ticket).not.toBeNull();
        expect(ticket?.request).toEqual(request);
        expect(authority.currentPage.value).toBe(1);
        expect(authority.navigationPage.value).toBe(7);
        authority.pageSlots.markMounted(7);
        authority.observePage(7);

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
            expect(port.isCommandResidueLive()).toBe(true);
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
            expect(port.isCommandResidueLive()).toBe(false);
            expect(port.apply(container, {
                intent: navigation,
                reason: 'navigation',
                top: 700,
            })).toBe(false);
        });

        it('keeps a gesture begun before the command as residue when the command overtakes it', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();
            const send = (timeStamp: number) => observeDocumentViewportWheelInteraction(
                port,
                scrollInteraction(timeStamp, 40, 0, true),
                container,
            );

            send(0);
            // Chromium queues wheel packets in the browser and lets the click
            // overtake them, so packets from before the command arrive after it.
            port.fenceCommandAgainstLiveGesture(900);
            const navigation = port.beginIntent('navigate:1');

            expect(send(850)).toBe('command-residue');
            expect(send(860)).toBe('command-residue');
            expect(port.apply(container, {
                intent: navigation,
                reason: 'navigation',
                top: 0,
            })).toBe(true);
            // Scrolling is still suppressed, so the viewer scrolls this newer
            // gesture by hand rather than dropping it.
            expect(send(1_400)).toBe('adopted-user-input');
            expect(port.isCommandResidueLive()).toBe(false);
        });

        it('keeps a gesture begun before the command as residue when none of it arrived first', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();
            const send = (timeStamp: number) => observeDocumentViewportWheelInteraction(
                port,
                scrollInteraction(timeStamp, 40, 0, true),
                container,
            );

            port.fenceCommandAgainstLiveGesture(900);

            expect(send(880)).toBe('command-residue');
            expect(send(890)).toBe('command-residue');
            expect(send(1_400)).not.toBe('command-residue');
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

        it('falls back to the quiet gap only inside a prevented sequence, where every packet stays cancelable', () => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const packet = (timeStamp: number) => {
                const interaction = scrollInteraction(timeStamp, 40, 0, true);
                const owner = observeDocumentViewportWheelInteraction(port, interaction);
                // A renderer handler prevents the packet, as a paged flip does.
                interaction.event.preventDefault();
                return owner;
            };

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
            port.observeWheelScrollSequence('begin');
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
            port.observeWheelScrollSequence('begin');
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
            port.observeWheelScrollSequence('begin');
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
            const container = createViewportContainer();
            const navigation = port.beginIntent('navigate:1');
            observeDocumentViewportWheelInteraction(port, scrollInteraction(48, 40, 0, false), container);
            expect(port.apply(container, {
                intent: navigation,
                reason: 'navigation',
                top: 700,
            })).toBe(true);
            expect(container.scrollTop).toBe(700);
            expect(port.userScrollSuppressed.value).toBe(false);
        });

        describe('ownership of late and sparse packets', () => {
            function fencedFling() {
                vi.useFakeTimers();
                const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
                const container = createViewportContainer();
                const send = (timeStamp: number, cancelable: boolean) => (
                    observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable), container)
                );
                send(0, true);
                port.observeWheelScrollSequence('begin');
                send(16, false);
                port.fenceCommandAgainstLiveGesture(20);
                const navigation = port.beginIntent('navigate:1');
                const lands = () => port.apply(container, {
                    intent: navigation,
                    reason: 'navigation',
                    top: 700,
                });
                return {
                    port,
                    send,
                    lands,
                };
            }

            // Two independent distortions of a slow machine. Timestamps say
            // when the hardware produced a packet; the clock says when the
            // renderer got round to it.
            const distortions = [
                {
                    name: 'sparse timestamps, prompt delivery',
                    timestampGapMs: 1_601,
                    deliveryDelayMs: 0,
                },
                {
                    name: 'close timestamps, late delivery',
                    timestampGapMs: 16,
                    deliveryDelayMs: 5_000,
                },
                {
                    name: 'sparse timestamps and late delivery',
                    timestampGapMs: 12_000,
                    deliveryDelayMs: 5_000,
                },
            ];

            it.each(distortions)('keeps residue while the host sequence is open: $name', ({
                timestampGapMs,
                deliveryDelayMs,
            }) => {
                const fling = fencedFling();
                vi.advanceTimersByTime(deliveryDelayMs);

                expect(fling.send(16 + timestampGapMs, false)).toBe('command-residue');
                expect(fling.port.userScrollSuppressed.value).toBe(true);
                expect(fling.lands()).toBe(true);
            });

            it.each(distortions)('keeps residue after the host ended the sequence: $name', ({
                timestampGapMs,
                deliveryDelayMs,
            }) => {
                const fling = fencedFling();
                fling.port.observeWheelScrollSequence('end');
                vi.advanceTimersByTime(deliveryDelayMs);

                expect(fling.send(16 + timestampGapMs, false)).toBe('command-residue');
                // The sequence is over, so a late packet is only late: it must
                // not take scrolling away again.
                expect(fling.port.userScrollSuppressed.value).toBe(false);
                expect(fling.lands()).toBe(true);
            });
        });

        describe('a genuine next sequence', () => {
            function commandDuringOnePacketSequence() {
                vi.useFakeTimers();
                const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
                const container = createViewportContainer();
                const send = (timeStamp: number, cancelable: boolean) => (
                    observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable), container)
                );
                send(0, true);
                port.observeWheelScrollSequence('begin');
                port.fenceCommandAgainstLiveGesture(10);
                const staleNavigation = port.beginIntent('navigate:734');
                const staleNavigationLands = () => port.apply(container, {
                    intent: staleNavigation,
                    reason: 'navigation',
                    top: 700,
                });
                return {
                    port,
                    send,
                    staleNavigationLands,
                };
            }

            // A cancelable packet right after a one-packet sequence is
            // structurally identical to the next member of a run of one-packet
            // sequences, which is how the DevTools input path delivers a
            // fling: same flags, same host boundaries in between. Nothing but
            // the gap separates them, so the quiet gap decides. A person
            // cannot scroll one packet, issue a command and start a new
            // gesture inside that gap.
            it('is joined to a one-packet sequence it follows within the quiet gap', () => {
                const run = commandDuringOnePacketSequence();
                run.port.observeWheelScrollSequence('end');

                expect(run.send(40, true)).toBe('command-residue');
                expect(run.staleNavigationLands()).toBe(true);
            });

            it('is the user taking the viewport once the quiet gap has passed, whatever the host order', () => {
                const run = commandDuringOnePacketSequence();
                run.port.observeWheelScrollSequence('end');
                vi.advanceTimersByTime(260);

                expect(run.send(260, true)).toBe('user-input');
                run.port.observeWheelScrollSequence('begin');
                expect(run.staleNavigationLands()).toBe(false);
                expect(run.send(276, false)).toBe('user-input');
            });

            it('needs no quiet gap after a sequence that produced a non-cancelable packet', () => {
                vi.useFakeTimers();
                const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
                const container = createViewportContainer();
                const send = (timeStamp: number, cancelable: boolean) => (
                    observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable), container)
                );
                send(0, true);
                port.observeWheelScrollSequence('begin');
                send(16, false);
                port.fenceCommandAgainstLiveGesture(20);
                const staleNavigation = port.beginIntent('navigate:734');

                // 8 ms after the tail's last packet, before its `end` arrives.
                expect(send(24, true)).toBe('adopted-user-input');
                expect(port.apply(container, {
                    intent: staleNavigation,
                    reason: 'navigation',
                    top: 700,
                })).toBe(false);
            });

            it('is not closed by the old sequence\'s end arriving after its first packet', () => {
                vi.useFakeTimers();
                const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
                const send = (timeStamp: number, cancelable: boolean) => (
                    observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable))
                );
                send(0, true);
                port.observeWheelScrollSequence('begin');
                send(16, false);

                // Input outranks IPC on a busy main thread, so the next
                // sequence's first packet can be handled before the old `end`.
                expect(send(40, true)).toBe('user-input');
                port.observeWheelScrollSequence('end');
                port.observeWheelScrollSequence('begin');
                send(56, false);

                // The new sequence is still open long after its last packet.
                port.fenceCommandAgainstLiveGesture(3_000);
                expect(port.userScrollSuppressed.value).toBe(true);
                expect(send(3_100, false)).toBe('command-residue');
                port.observeWheelScrollSequence('end');
                expect(port.userScrollSuppressed.value).toBe(false);
            });

            it('starts on a reversal, which inertia never produces, without leaving its sequence', () => {
                vi.useFakeTimers();
                const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
                const send = (timeStamp: number, deltaY: number, cancelable: boolean) => (
                    observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, deltaY, 0, cancelable))
                );
                send(0, 60, true);
                port.observeWheelScrollSequence('begin');
                send(16, 55, false);
                port.fenceCommandAgainstLiveGesture(20);

                expect(send(32, -20, false)).toBe('user-input');
                expect(port.userScrollSuppressed.value).toBe(false);

                // Still the host's same sequence: a later command fences it
                // without any recent packet, and its end is still recognised.
                port.fenceCommandAgainstLiveGesture(2_000);
                expect(port.userScrollSuppressed.value).toBe(true);
                port.observeWheelScrollSequence('end');
                expect(port.userScrollSuppressed.value).toBe(false);
            });
        });

        describe('a scroll sequence that belongs to another scroller', () => {
            it('is not a live gesture for a viewport that never received a wheel packet', () => {
                const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;

                port.observeWheelScrollSequence('begin');
                port.fenceCommandAgainstLiveGesture(10);

                expect(port.userScrollSuppressed.value).toBe(false);
            });

            it('neither reopens nor ends a sequence this viewport finished earlier', () => {
                vi.useFakeTimers();
                const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
                const send = (timeStamp: number, cancelable: boolean) => (
                    observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable))
                );
                send(0, true);
                port.observeWheelScrollSequence('begin');
                send(16, false);
                port.observeWheelScrollSequence('end');

                // A fling in the sidebar, then a row click that navigates here.
                port.observeWheelScrollSequence('begin');
                port.fenceCommandAgainstLiveGesture(4_000);
                expect(port.userScrollSuppressed.value).toBe(false);
                port.observeWheelScrollSequence('end');

                // The viewport's own next gesture is unaffected.
                expect(send(5_000, true)).toBe('user-input');
                port.observeWheelScrollSequence('begin');
                send(5_016, false);
                port.fenceCommandAgainstLiveGesture(6_000);
                expect(port.userScrollSuppressed.value).toBe(true);
            });

            it('still ends its own sequence when it started listening mid-sequence and saw no begin', () => {
                vi.useFakeTimers();
                const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
                const send = (timeStamp: number, cancelable: boolean) => (
                    observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, cancelable))
                );
                // An earlier sequence elsewhere taught the viewport that the
                // host reports boundaries.
                port.observeWheelScrollSequence('begin');
                port.observeWheelScrollSequence('end');
                send(0, true);
                send(16, false);
                port.fenceCommandAgainstLiveGesture(900);
                expect(port.userScrollSuppressed.value).toBe(true);

                port.observeWheelScrollSequence('end');
                expect(port.userScrollSuppressed.value).toBe(false);
            });
        });

        it.each([
            40,
            5_000,
        ])('holds a command at %i ms through queued one-packet wheel sequences', (commandAtMs) => {
            vi.useFakeTimers();
            const port = createDocumentViewerRuntime(ref('pdf')).viewportWritePort;
            const container = createViewportContainer();
            // `Input.dispatchMouseEvent` sends each wheel event as a complete
            // sequence: cancelable, not prevented, with its own begin and end.
            const sendOnePacketSequence = (timeStamp: number) => {
                const owner = observeDocumentViewportWheelInteraction(port, scrollInteraction(timeStamp, 40, 0, true), container);
                port.observeWheelScrollSequence('begin');
                port.observeWheelScrollSequence('end');
                return owner;
            };

            sendOnePacketSequence(0);
            sendOnePacketSequence(16);
            sendOnePacketSequence(32);
            // The host has ended every member so far, yet the gesture is live.
            // The renderer can handle the click after the packet timestamps
            // have gone stale while more of the same burst is still queued.
            port.fenceCommandAgainstLiveGesture(commandAtMs);
            const navigation = port.beginIntent('navigate:1');
            expect(port.userScrollSuppressed.value).toBe(commandAtMs === 40);

            expect(sendOnePacketSequence(48)).toBe('command-residue');
            expect(sendOnePacketSequence(64)).toBe('command-residue');
            expect(port.userScrollSuppressed.value).toBe(true);
            expect(port.isCommandResidueLive()).toBe(true);
            expect(port.apply(container, {
                intent: navigation,
                reason: 'navigation',
                top: 0,
            })).toBe(true);

            // Quiet: scrolling comes back, and once the restored style has
            // settled the next gesture is Chromium's to scroll.
            vi.advanceTimersByTime(260);
            expect(port.userScrollSuppressed.value).toBe(false);
            vi.advanceTimersByTime(400);
            // A gesture the user starts now is timed after the command.
            expect(sendOnePacketSequence(commandAtMs + 660)).toBe('user-input');
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

    it('clamps the physical navigation cursor after the source page count is known', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.djvu',
            documentRevision: 'revision-1',
        });
        const authority = createDocumentViewerRuntime(ref('djvu'), 1, openSurface);

        const pending = authority.navigate(createPageNavigationRequest(20, 'toolbar'));
        expect(pending).not.toBeNull();
        expect(authority.currentPage.value).toBe(1);
        expect(authority.navigationPage.value).toBe(20);

        authority.bindSource(createSource('djvu', 8));
        expect(authority.currentPage.value).toBe(1);
        expect(authority.navigationPage.value).toBe(8);
        expect(pending?.request.target).toEqual({
            kind: 'page',
            page: 20,
        });
        expect(openSurface.navigationTicket.value?.signal).toBe(pending?.signal);
        expect(openSurface.navigationTicket.value?.request.target).toEqual({
            kind: 'page',
            page: 8,
        });
        expect(openSurface.isNavigationCurrent(pending!)).toBe(true);

        expect(authority.navigate(createPageNavigationRequest(-4, 'toolbar'))).toBeNull();
        expect(authority.navigationPage.value).toBe(8);
        authority.observePage(8);
        expect(authority.currentPage.value).toBe(8);
    });

    it('delegates navigation dedupe to the owned open-surface session', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        const requestNavigation = vi.spyOn(openSurface, 'navigate');
        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);
        const request = createPageNavigationRequest(1, 'toolbar');

        const ticket = authority.navigate(request);
        expect(ticket).toBe(openSurface.navigationTicket.value);
        expect(ticket?.request).toEqual(request);
        expect(requestNavigation).toHaveBeenCalledOnce();
        expect(requestNavigation).toHaveBeenCalledWith(request);
    });

    it('does not fence the wheel gesture that owns a wheel navigation ticket', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);
        const fence = vi.spyOn(authority.viewportWritePort, 'fenceCommandAgainstLiveGesture');

        expect(authority.navigate(createPageNavigationRequest(2, 'wheel'))).not.toBeNull();

        expect(fence).not.toHaveBeenCalled();
    });

    it('mounts on the latest opening-session intent while keeping physical page separate', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        for (let page = 2; page <= 6; page += 1) {
            openSurface.navigate(createPageNavigationRequest(page, 'toolbar'));
        }

        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);

        expect(openSurface.viewportSession.value.requestedPage).toBe(6);
        expect(authority.currentPage.value).toBe(1);
        expect(authority.navigationPage.value).toBe(6);
        expect(authority.navigationTicket.value?.request.target).toEqual({
            kind: 'page',
            page: 6,
        });
        expect(shouldAcceptFeaturePackRuntimePage(openSurface.viewportSession.value, 1)).toBe(true);
        expect(shouldAcceptFeaturePackRuntimePage(openSurface.viewportSession.value, 6)).toBe(false);
        authority.observePage(6);
        expect(shouldAcceptFeaturePackRuntimePage(openSurface.viewportSession.value, 1)).toBe(false);
        expect(shouldAcceptFeaturePackRuntimePage(openSurface.viewportSession.value, 6)).toBe(true);
    });

    it('replays the full target through a renderer bind without replacing the visible page', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);
        const request = {
            ...createPageNavigationRequest(1, 'bookmark'),
            target: {
                kind: 'named-dest' as const,
                destination: 'chapter',
            },
            readiness: 'metrics' as const,
            postArrival: 'search-highlight' as const,
            searchNavigationId: 17,
        };

        const ticket = authority.navigate(request);
        expect(ticket).not.toBeNull();
        expect(authority.currentPage.value).toBe(1);
        expect(authority.navigationPage.value).toBe(1);
        expect(authority.navigationTicket.value).toBe(ticket);
        expect(authority.navigationTicket.value?.request).toEqual(request);

        const rebound = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);
        expect(rebound.navigationTicket.value).toBe(ticket);
        expect(rebound.navigationTicket.value?.request.target).toEqual(request.target);
        expect(rebound.currentPage.value).toBe(1);
        expect(rebound.navigationPage.value).toBe(1);

        expect(openSurface.reportNavigation(ticket!, {
            kind: 'resolved',
            page: 8,
        })).toBe(true);
        expect(authority.currentPage.value).toBe(1);
        expect(authority.navigationPage.value).toBe(8);
        expect(rebound.currentPage.value).toBe(1);
        expect(rebound.navigationPage.value).toBe(8);
        expect(authority.navigationTicket.value?.request.target).toEqual(request.target);
    });

    it('rejects navigation without a document owner instead of leaking it into the next open', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        const authority = createDocumentViewerRuntime(ref('pdf'), 1, openSurface);

        for (let page = 2; page <= 6; page += 1) {
            expect(authority.navigate(createPageNavigationRequest(page, 'toolbar'))).toBeNull();
        }
        expect(authority.currentPage.value).toBe(1);
        expect(authority.navigationPage.value).toBe(1);
        expect(authority.navigationTicket.value).toBeNull();
        expect(openSurface.viewportSession.value.identity).toBeNull();

        openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });

        expect(openSurface.viewportSession.value.requestedPage).toBe(1);
        expect(authority.currentPage.value).toBe(1);
        expect(authority.navigationPage.value).toBe(1);
    });
});
