// @vitest-environment happy-dom

import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import { SIDEBAR } from '@app/constants/pdfLayout';
import WorkspaceSidebarHost from '@app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue';

function mountHost() {
    const host = document.createElement('div');
    document.body.append(host);
    const showSidebar = ref(false);
    const slideEvents: string[] = [];
    const app = createApp(defineComponent({setup: () => () => h(WorkspaceSidebarHost, {
        isResizingSidebar: false,
        resizeAriaLabel: 'Resize sidebar',
        showSidebar: showSidebar.value,
        sidebarContentWidth: SIDEBAR.DEFAULT_WIDTH,
        sidebarWrapperStyle: {width: `${String(SIDEBAR.DEFAULT_WIDTH + SIDEBAR.RESIZER_WIDTH)}px`},
        onSlideStart: () => slideEvents.push('start'),
        onSlideEnd: () => slideEvents.push('end'),
    }, {sidebar: () => h('div', {class: 'panel'})})}));
    app.mount(host);
    return {
        dispose() {
            app.unmount();
            host.remove();
        },
        content: () => host.querySelector<HTMLElement>('.sidebar-wrapper__content'),
        showSidebar,
        slideEvents,
        wrapper: () => host.querySelector<HTMLElement>('.sidebar-wrapper'),
    };
}

// happy-dom does not apply the component stylesheet, so the wrapper reports the
// width slide the production CSS declares through a stubbed computed style.
function stubWrapperWidthSlide(wrapper: HTMLElement | null, durationMs: number) {
    const original = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        const style = original(element, pseudo);
        if (element !== wrapper) {
            return style;
        }
        // Own data properties shadow happy-dom's prototype setters, which
        // reject writes from an object they did not construct.
        return Object.defineProperties(Object.create(style) as CSSStyleDeclaration, {
            transitionProperty: {value: 'width'},
            transitionDuration: {value: `${String(durationMs)}ms`},
            transitionDelay: {value: '0s'},
        });
    });
    return () => spy.mockRestore();
}

function dispatchTransitionEnd(target: HTMLElement, propertyName: string) {
    const event = new Event('transitionend', {bubbles: true});
    Object.defineProperty(event, 'propertyName', {value: propertyName});
    target.dispatchEvent(event);
}

describe('sidebar open layout stability', () => {
    it('gives the panel its open width on the first frame of the slide', async () => {
        const view = mountHost();
        onTestFinished(view.dispose);
        await nextTick();

        expect(view.wrapper()?.style.width).toBe('0px');
        expect(view.content()?.style.width).toBe('0px');
        expect(view.content()?.querySelector('.panel')).not.toBeNull();

        view.showSidebar.value = true;
        await nextTick();

        // The wrapper animates its width open. The panel jumps straight to the
        // final width so the thumbnail rail measures one width instead of
        // relaying out and re-rasterizing on every frame of the animation.
        expect(view.wrapper()?.style.width).toBe(`${String(SIDEBAR.DEFAULT_WIDTH + SIDEBAR.RESIZER_WIDTH)}px`);
        expect(view.content()?.style.width).toBe(`${String(SIDEBAR.DEFAULT_WIDTH)}px`);
    });

    it('collapses the panel back to zero so a closed sidebar cannot measure as visible', async () => {
        const view = mountHost();
        onTestFinished(view.dispose);
        view.showSidebar.value = true;
        await nextTick();
        view.showSidebar.value = false;
        await nextTick();

        expect(view.content()?.style.width).toBe('0px');
        expect(view.wrapper()?.classList.contains('is-closed')).toBe(true);
    });

    it('reports the slide from the toggle until the wrapper finishes its width transition', async () => {
        const view = mountHost();
        onTestFinished(view.dispose);
        await nextTick();
        onTestFinished(stubWrapperWidthSlide(view.wrapper(), 200));

        view.showSidebar.value = true;
        await nextTick();
        expect(view.slideEvents).toEqual(['start']);

        // The panel's own delayed width step bubbles the same event name and
        // must not release the viewer while the wrapper is still moving.
        dispatchTransitionEnd(view.content() as HTMLElement, 'width');
        expect(view.slideEvents).toEqual(['start']);

        dispatchTransitionEnd(view.wrapper() as HTMLElement, 'width');
        expect(view.slideEvents).toEqual([
            'start',
            'end',
        ]);
    });

    it('ends the slide on a timer when the transition never reports its end', async () => {
        vi.useFakeTimers();
        onTestFinished(() => vi.useRealTimers());
        const view = mountHost();
        onTestFinished(view.dispose);
        await nextTick();
        onTestFinished(stubWrapperWidthSlide(view.wrapper(), 200));

        view.showSidebar.value = true;
        await nextTick();
        view.showSidebar.value = false;
        await nextTick();
        expect(view.slideEvents).toEqual(['start']);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(view.slideEvents).toEqual([
            'start',
            'end',
        ]);
    });

    it('does not report a slide when the wrapper has no width transition', async () => {
        const view = mountHost();
        onTestFinished(view.dispose);
        await nextTick();

        view.showSidebar.value = true;
        await nextTick();
        view.showSidebar.value = false;
        await nextTick();

        expect(view.slideEvents).toEqual([]);
    });
});
