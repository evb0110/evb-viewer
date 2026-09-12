// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
    watch,
} from 'vue';

const resizeObserverCallbacks: Array<() => void> = [];
const mutationObserverCallbacks: Array<(mutations: MutationRecord[]) => void> = [];
let rafRunCount = 0;

vi.mock('@vueuse/core', () => ({
    tryOnMounted: (callback: () => void) => callback(),
    tryOnScopeDispose: vi.fn(),
    useResizeObserver: (_target: unknown, callback: () => void) => {
        resizeObserverCallbacks.push(callback);
    },
    useMutationObserver: vi.fn(
        (_target: unknown, callback: (mutations: MutationRecord[]) => void) => {
            mutationObserverCallbacks.push(callback);
        },
    ),
    useEventListener: vi.fn(),
    useRafFn: (callback: () => void, options?: { immediate?: boolean }) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let active = Boolean(options?.immediate);

        const run = () => {
            timer = null;
            if (!active) {
                return;
            }
            rafRunCount += 1;
            callback();
        };

        const resume = () => {
            active = true;
            if (timer) {
                return;
            }
            timer = setTimeout(run, 0);
        };

        const pause = () => {
            active = false;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };

        if (active) {
            resume();
        }

        return {
            pause,
            resume,
            isActive: ref(active),
        };
    },
}));

const measuredElementSetters = new WeakMap<HTMLElement, (clientWidth: number, scrollWidth: number) => void>();

function createMeasuredElement(
    clientWidth: number,
    scrollWidth: number,
    rectLeft = 0,
): HTMLElement {
    const element = document.createElement('div');
    let measuredClientWidth = clientWidth;
    let measuredScrollWidth = scrollWidth;
    Object.defineProperties(element, {
        clientWidth: {
            configurable: true,
            get: () => measuredClientWidth,
        },
        scrollWidth: {
            configurable: true,
            get: () => measuredScrollWidth,
        },
        getBoundingClientRect: {
            configurable: true,
            value: () => ({
                left: rectLeft,
                right: rectLeft + measuredClientWidth,
                width: measuredClientWidth,
            }),
        },
    });
    measuredElementSetters.set(element, (nextClientWidth, nextScrollWidth) => {
        measuredClientWidth = nextClientWidth;
        measuredScrollWidth = nextScrollWidth;
    });
    document.body.append(element);
    return element;
}

function setElementMeasurements(
    element: HTMLElement,
    clientWidth: number,
    scrollWidth: number,
) {
    measuredElementSetters.get(element)?.(clientWidth, scrollWidth);
}

function toNodeList(nodes: Node[]) {
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    return fragment.childNodes;
}

function childListMutation(added: Node[], removed: Node[] = []) {
    const record: MutationRecord = {
        type: 'childList',
        target: document.body,
        addedNodes: toNodeList(added),
        removedNodes: toNodeList(removed),
        previousSibling: null,
        nextSibling: null,
        attributeName: null,
        attributeNamespace: null,
        oldValue: null,
    };
    return record;
}

function createResponsiveToolbarElement(getClientWidth: () => number) {
    const element = createMeasuredElement(500, 500);
    Object.defineProperty(element, 'clientWidth', {
        configurable: true,
        get: getClientWidth,
    });
    return element;
}

// Content changes leave the toolbar's own width alone and show up as content
// that is wider than the box, so the fixtures below vary scrollWidth only.
function createToolbarWithContentWidth(getScrollWidth: () => number) {
    const element = createMeasuredElement(500, 500);
    Object.defineProperty(element, 'scrollWidth', {
        configurable: true,
        get: getScrollWidth,
    });
    return element;
}

function stubGlobals() {
    vi.stubGlobal('ref', ref);
    vi.stubGlobal('computed', computed);
    vi.stubGlobal('watch', watch);
    vi.stubGlobal('onMounted', (cb: () => void) => cb());
    vi.stubGlobal('onBeforeUnmount', vi.fn());
}

describe('useToolbarOverflow', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.clearAllMocks();
        document.body.replaceChildren();
        resizeObserverCallbacks.length = 0;
        mutationObserverCallbacks.length = 0;
        rafRunCount = 0;
        stubGlobals();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('collapses tiers when content overflows container', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();

        overflow.toolbarRef.value = createMeasuredElement(100, 260);
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);
        expect(overflow.hasOverflowItems.value).toBe(true);
        expect(overflow.isCollapsed(3)).toBe(true);
    });

    it('re-expands when resize removes overflow', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = createMeasuredElement(120, 300);

        overflow.toolbarRef.value = toolbar;
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);

        setElementMeasurements(toolbar, 160, 120);
        resizeObserverCallbacks.forEach(cb => cb());
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(0);
        expect(overflow.hasOverflowItems.value).toBe(false);
    });

    it('detects overflow from out-of-bounds children', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = createMeasuredElement(100, 100);
        const child = createMeasuredElement(30, 30, 85);

        toolbar.append(child);
        overflow.toolbarRef.value = toolbar;
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(5);
        expect(overflow.hasOverflowItems.value).toBe(true);
    });

    it('does not repeatedly retry a failed expand when the narrower tier changes measured width', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const tierChanges: number[] = [];

        watch(overflow.collapseTier, value => tierChanges.push(value));

        overflow.collapseTier.value = 1;
        overflow.toolbarRef.value = createResponsiveToolbarElement(
            () => overflow.collapseTier.value === 0 ? 490 : 500,
        );
        await nextTick();
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(1);
        expect(tierChanges).toContain(0);
        expect(tierChanges.at(-1)).toBe(1);

        const retriesAfterInitialPass = tierChanges.length;

        resizeObserverCallbacks.forEach(cb => cb());
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(1);
        expect(tierChanges).toHaveLength(retriesAfterInitialPass);
    });

    it('converges after each tier write echoes attribute and child-list mutations', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = createMeasuredElement(100, 100);
        let tierWriteCount = 0;

        Object.defineProperty(toolbar, 'scrollWidth', {
            configurable: true,
            get: () => overflow.collapseTier.value < 5 ? 200 : 100,
        });
        watch(overflow.collapseTier, () => {
            tierWriteCount += 1;
            if (tierWriteCount > 12) {
                return;
            }

            const notifyLayoutMutation = mutationObserverCallbacks[0];
            expect(notifyLayoutMutation).toBeDefined();
            notifyLayoutMutation?.([
                {
                    type: 'attributes',
                    attributeName: 'data-collapse-tier',
                } as MutationRecord,
                childListMutation([document.createElement('button')]),
            ]);
        }, { flush: 'sync' });

        overflow.toolbarRef.value = toolbar;
        await nextTick();
        await vi.runAllTimersAsync();

        expect(rafRunCount).toBeLessThanOrEqual(2);
        expect(overflow.collapseTier.value).toBe(5);
        expect(tierWriteCount).toBeGreaterThan(0);
    });

    it('recalculates once for a genuine external child-list mutation after convergence', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const toolbar = createMeasuredElement(100, 100);
        let measuredScrollWidth = 200;

        Object.defineProperty(toolbar, 'scrollWidth', {
            configurable: true,
            get: () => measuredScrollWidth,
        });
        overflow.toolbarRef.value = toolbar;
        await nextTick();
        await vi.runAllTimersAsync();

        const passesBeforeExternalMutation = rafRunCount;
        expect(overflow.collapseTier.value).toBe(5);
        measuredScrollWidth = 100;
        toolbar.append(document.createElement('span'));

        const notifyLayoutMutation = mutationObserverCallbacks[0];
        expect(notifyLayoutMutation).toBeDefined();
        notifyLayoutMutation?.([childListMutation([document.createElement('span')])]);
        await vi.runAllTimersAsync();

        expect(rafRunCount).toBe(passesBeforeExternalMutation + 1);
        expect(overflow.collapseTier.value).toBe(0);
    });

    it('measures a readout text change in place and retries expanding only after the text settles', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const tierChanges: number[] = [];
        let isReadoutWide = true;

        watch(overflow.collapseTier, value => tierChanges.push(value));

        // Tier 0 overflows by ten pixels while the readout is wide, so the
        // toolbar settles at tier 1 with its lowest group collapsed.
        overflow.toolbarRef.value = createToolbarWithContentWidth(
            () => overflow.collapseTier.value === 0 && isReadoutWide ? 510 : 500,
        );
        await nextTick();
        await vi.runAllTimersAsync();
        expect(overflow.collapseTier.value).toBe(1);

        const notifyMutation = mutationObserverCallbacks[0];
        expect(notifyMutation).toBeDefined();
        const changesBeforeText = tierChanges.length;

        // A fit-scale preview rewrites the zoom readout on every frame. Each
        // frame is a text-only child-list mutation; none may re-expand the
        // toolbar to measure tier 0, which would remount the collapsed group.
        for (let frame = 0; frame < 3; frame += 1) {
            notifyMutation?.([childListMutation([document.createTextNode('92%')], [document.createTextNode('93%')])]);
            await vi.advanceTimersByTimeAsync(16);
            expect(tierChanges).toHaveLength(changesBeforeText);
        }

        // Once the readout is narrow and has stopped changing, the deferred
        // pass re-measures from tier 0 and expands.
        isReadoutWide = false;
        notifyMutation?.([childListMutation([document.createTextNode('50%')], [document.createTextNode('92%')])]);
        await vi.advanceTimersByTimeAsync(16);
        expect(overflow.collapseTier.value).toBe(1);

        await vi.runAllTimersAsync();
        expect(overflow.collapseTier.value).toBe(0);
        expect(overflow.hasOverflowItems.value).toBe(false);
    });

    it('escalates from the current tier when a readout grows past the toolbar edge', async () => {
        const { useToolbarOverflow } = await import('@app/composables/useToolbarOverflow');
        const overflow = useToolbarOverflow();
        const tierChanges: number[] = [];
        let isReadoutWide = false;

        watch(overflow.collapseTier, value => tierChanges.push(value));

        overflow.toolbarRef.value = createToolbarWithContentWidth(
            () => (overflow.collapseTier.value <= 1 && isReadoutWide) || overflow.collapseTier.value === 0 ? 510 : 500,
        );
        await nextTick();
        await vi.runAllTimersAsync();
        expect(overflow.collapseTier.value).toBe(1);

        const changesBeforeText = tierChanges.length;
        isReadoutWide = true;
        mutationObserverCallbacks[0]?.([childListMutation([document.createTextNode('1600%')], [document.createTextNode('100%')])]);
        await vi.runAllTimersAsync();

        expect(overflow.collapseTier.value).toBe(2);
        expect(tierChanges.slice(changesBeforeText)).toEqual([2]);
    });
});
