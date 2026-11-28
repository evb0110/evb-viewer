// @vitest-environment happy-dom

import {afterEach, describe, expect, it, vi} from 'vitest';
import {createApp, defineComponent, h, nextTick, reactive, ref} from 'vue';
import type {IAnnotationNotePosition} from '@app/types/annotationNoteWindow';
import type {IAnnotationNoteWindowEntry} from '@app/modules/workspace-shell/annotations/annotationNoteWindowEntry';
import {createAnnotationOverlayRuntime} from '@app/modules/workspace-shell/annotations/createAnnotationOverlayRuntime';

const disposals: Array<() => void> = [];

afterEach(() => {
    disposals.splice(0).forEach((dispose) => dispose());
    vi.restoreAllMocks();
});

function createNoteEntry(overrides: Partial<IAnnotationNoteWindowEntry> = {}): IAnnotationNoteWindowEntry {
    return {
        annotationId: 'note-1',
        pageIndex: 0,
        pageNumber: 1,
        author: null,
        createdAt: null,
        modifiedAt: null,
        markerRect: {
            left: 0.2,
            top: 0.3,
            width: 0.1,
            height: 0.05,
        },
        subtype: 'Text',
        source: 'pdf',
        hasNote: true,
        draftText: 'Note body',
        saving: false,
        error: null,
        order: 1,
        isMinimized: false,
        ...overrides,
    };
}

function flushAnimationFrames() {
    return new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
        });
    });
}

function setupViewportHarness(pageCount: number) {
    const workspaceRoot = document.createElement('div');
    workspaceRoot.className = 'workspace-host';
    const viewportRoot = document.createElement('div');
    viewportRoot.id = 'pdf-viewer';
    const pageTrack = document.createElement('div');
    pageTrack.setAttribute('data-pdf-page-track', '');
    viewportRoot.append(pageTrack);
    workspaceRoot.append(viewportRoot);
    document.body.append(workspaceRoot);

    let viewportRect = new DOMRect(0, 0, 900, 700);
    const pageRects = new Map<number, DOMRect>();
    const pages = new Map<number, HTMLDivElement>();
    const measuredPages: number[] = [];
    let viewportMeasurements = 0;

    vi.spyOn(viewportRoot, 'getBoundingClientRect').mockImplementation(() => {
        viewportMeasurements += 1;
        return viewportRect;
    });

    const mountPage = (pageNumber: number, rect = new DOMRect(100, (pageNumber - 1) * 820, 600, 800)) => {
        const page = document.createElement('div');
        page.className = 'page_container';
        page.dataset.page = String(pageNumber);
        pageRects.set(pageNumber, rect);
        vi.spyOn(page, 'getBoundingClientRect').mockImplementation(() => {
            measuredPages.push(pageNumber);
            return pageRects.get(pageNumber) ?? new DOMRect(0, 0, 0, 0);
        });
        pageTrack.append(page);
        pages.set(pageNumber, page);
        return page;
    };

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        mountPage(pageNumber);
    }

    const notes = reactive<IAnnotationNoteWindowEntry[]>([]);
    const positions = ref<Record<string, IAnnotationNotePosition>>({});
    const zoom = ref(1);
    const visible = ref(true);

    const mountHost = document.createElement('div');
    workspaceRoot.append(mountHost);
    let runtime!: ReturnType<typeof createAnnotationOverlayRuntime>;
    const app = createApp(
        defineComponent({
            setup() {
                runtime = createAnnotationOverlayRuntime({
                    getNoteWindows: () => notes,
                    getNotePositions: () => positions.value,
                    getWorkspaceRoot: () => workspaceRoot,
                    getViewportRoot: () => viewportRoot,
                    getZoom: () => zoom.value,
                    getEmptyNoteLabel: () => 'Empty note',
                    isVisible: () => visible.value,
                    paintsPage: () => true,
                });
                return () => h('div');
            },
        }),
    );
    app.mount(mountHost);

    disposals.push(() => {
        app.unmount();
        workspaceRoot.remove();
    });

    return {
        workspaceRoot,
        viewportRoot,
        pageTrack,
        pages,
        pageRects,
        notes,
        positions,
        zoom,
        visible,
        runtime,
        mountPage,
        setViewportRect(next: DOMRect) {
            viewportRect = next;
        },
        resetMeasurements() {
            measuredPages.length = 0;
            viewportMeasurements = 0;
        },
        getMeasuredPages: () => [...measuredPages],
        getViewportMeasurements: () => viewportMeasurements,
    };
}

describe('createAnnotationOverlayRuntime', () => {
    it('stays idle with zero page layout reads during scroll and viewport mutations when there are no notes', async () => {
        const harness = setupViewportHarness(12);
        await nextTick();
        await flushAnimationFrames();
        harness.resetMeasurements();

        // Scroll and mutate mounted pages as happens while scrolling a plain PDF.
        for (let frame = 0; frame < 5; frame += 1) {
            harness.viewportRoot.dispatchEvent(new Event('scroll'));
            const extraSpan = document.createElement('span');
            harness.pages.get(3)!.append(extraSpan);
            await flushAnimationFrames();
        }

        expect(harness.runtime.viewportDomSnapshot.value).toBeNull();
        expect(harness.runtime.connectorLines.value).toEqual([]);
        expect(harness.getMeasuredPages()).toEqual([]);
        expect(harness.getViewportMeasurements()).toBe(0);
    });

    it('tracks minimized note targets without scroll layout reads and reacts only to tracked page DOM changes', async () => {
        const harness = setupViewportHarness(10);
        harness.notes.push(
            createNoteEntry({
                annotationId: 'min-note-1',
                pageIndex: 0,
                pageNumber: 1,
                isMinimized: true,
            }),
        );
        await nextTick();
        await flushAnimationFrames();

        expect(harness.runtime.anchoredAnnotationNoteWindows.value.map((n) => n.annotationId)).toEqual(['min-note-1']);
        expect(harness.runtime.minimizedIndicatorTargets.value['min-note-1']).toBe(harness.pages.get(1));
        expect(harness.runtime.viewportDomSnapshot.value).toBeNull();

        harness.resetMeasurements();

        // Scroll and mutate an unrelated page container (page 8): no layout reads should occur.
        for (let frame = 0; frame < 4; frame += 1) {
            harness.viewportRoot.dispatchEvent(new Event('scroll'));
            const unrelated = document.createElement('div');
            harness.pages.get(8)!.append(unrelated);
            await flushAnimationFrames();
        }
        expect(harness.getMeasuredPages()).toEqual([]);
        expect(harness.getViewportMeasurements()).toBe(0);

        // When the inline editor note for the same ID mounts on page 1, the minimized fallback hides.
        const inlineNote = document.createElement('button');
        inlineNote.className = 'pdf-annotation-editor-note';
        inlineNote.dataset.annotationId = 'min-note-1';
        harness.pages.get(1)!.append(inlineNote);
        await flushAnimationFrames();
        await nextTick();

        expect(harness.runtime.anchoredAnnotationNoteWindows.value).toEqual([]);
        expect(harness.getMeasuredPages()).toEqual([]);

        // Removing the inline editor note restores the minimized fallback indicator.
        inlineNote.remove();
        await flushAnimationFrames();
        await nextTick();
        expect(harness.runtime.anchoredAnnotationNoteWindows.value.map((n) => n.annotationId)).toEqual(['min-note-1']);

        // Unmounting page 1 detaches the target, and remounting page 1 restores it.
        const oldPage1 = harness.pages.get(1)!;
        oldPage1.remove();
        await flushAnimationFrames();
        await nextTick();
        expect(harness.runtime.minimizedIndicatorTargets.value['min-note-1']).toBeUndefined();

        const remountedPage1 = harness.mountPage(1);
        await flushAnimationFrames();
        await nextTick();
        expect(harness.runtime.minimizedIndicatorTargets.value['min-note-1']).toBe(remountedPage1);
    });

    it('matches minimized inline notes by proximity on a tracked page and refreshes after a hidden tab becomes visible', async () => {
        const harness = setupViewportHarness(4);
        harness.visible.value = false;
        // Simulate display:none zero-size rects while the tab is hidden.
        harness.pageRects.set(2, new DOMRect(0, 0, 0, 0));

        const inlineNote = document.createElement('button');
        inlineNote.className = 'pdf-annotation-editor-note';
        inlineNote.dataset.annotationId = 'different-editor-id';
        let noteRect = new DOMRect(0, 0, 0, 0);
        vi.spyOn(inlineNote, 'getBoundingClientRect').mockImplementation(() => noteRect);
        harness.pages.get(2)!.append(inlineNote);

        harness.notes.push(
            createNoteEntry({
                annotationId: 'legacy-note-2',
                pageIndex: 1,
                pageNumber: 2,
                isMinimized: true,
                markerRect: {
                    left: 0.4,
                    top: 0.25,
                    width: 0.1,
                    height: 0.05,
                },
            }),
        );
        await nextTick();
        await flushAnimationFrames();

        // While hidden with 0x0 rects, proximity cannot match yet.
        expect(harness.runtime.anchoredAnnotationNoteWindows.value.map((n) => n.annotationId)).toEqual(['legacy-note-2']);

        // Tab becomes visible with real layout rects matching normalized (0.5, 0.25) on page 2.
        harness.pageRects.set(2, new DOMRect(100, 100, 600, 800));
        noteRect = new DOMRect(100 + 300 - 8, 100 + 200 - 8, 16, 16);
        harness.visible.value = true;
        await nextTick();
        await flushAnimationFrames();
        await nextTick();

        expect(harness.runtime.anchoredAnnotationNoteWindows.value).toEqual([]);
    });

    it('measures only the open note page on scroll, updates connectors, drops them offscreen, and cleans up on minimize', async () => {
        const harness = setupViewportHarness(12);
        harness.positions.value = {
            'open-note-1': {
                x: 420,
                y: 160,
                width: 240,
                height: 180,
            },
        };
        harness.notes.push(
            createNoteEntry({
                annotationId: 'open-note-1',
                pageIndex: 0,
                pageNumber: 1,
                isMinimized: false,
            }),
        );
        await nextTick();
        await flushAnimationFrames();
        await nextTick();

        expect(harness.runtime.viewportDomSnapshot.value?.pageContainers.has(1)).toBe(true);
        expect(harness.runtime.viewportDomSnapshot.value?.pageContainers.size).toBe(1);
        expect(harness.runtime.connectorLines.value).toHaveLength(1);
        expect(harness.runtime.connectorLines.value[0]?.annotationId).toBe('open-note-1');

        // Scroll while page 1 is still visible: only page 1 (never pages 2..12) is measured.
        harness.resetMeasurements();
        harness.pageRects.set(1, new DOMRect(100, -120, 600, 800));
        harness.viewportRoot.dispatchEvent(new Event('scroll'));
        await flushAnimationFrames();
        await nextTick();

        expect(harness.getMeasuredPages()).toEqual([1]);
        expect(harness.getViewportMeasurements()).toBe(1);
        expect(harness.runtime.connectorLines.value).toHaveLength(1);

        // Scroll page 1 completely offscreen: connector clears cleanly.
        harness.resetMeasurements();
        harness.pageRects.set(1, new DOMRect(100, -1200, 600, 800));
        harness.viewportRoot.dispatchEvent(new Event('scroll'));
        await flushAnimationFrames();
        await nextTick();

        expect(harness.getMeasuredPages()).toEqual([1]);
        expect(harness.runtime.connectorLines.value).toEqual([]);

        // Scroll page 1 back into view: connector returns.
        harness.pageRects.set(1, new DOMRect(100, 20, 600, 800));
        harness.viewportRoot.dispatchEvent(new Event('scroll'));
        await flushAnimationFrames();
        await nextTick();

        expect(harness.runtime.connectorLines.value).toHaveLength(1);

        // Minimize the note: snapshot and connectors clear, and subsequent scrolls read zero layout rects.
        harness.notes[0]!.isMinimized = true;
        await nextTick();
        await flushAnimationFrames();
        await nextTick();

        expect(harness.runtime.viewportDomSnapshot.value).toBeNull();
        expect(harness.runtime.connectorLines.value).toEqual([]);

        harness.resetMeasurements();
        harness.viewportRoot.dispatchEvent(new Event('scroll'));
        await flushAnimationFrames();
        expect(harness.getMeasuredPages()).toEqual([]);
        expect(harness.getViewportMeasurements()).toBe(0);
    });
});
