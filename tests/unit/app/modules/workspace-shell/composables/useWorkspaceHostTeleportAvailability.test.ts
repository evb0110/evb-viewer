// @vitest-environment happy-dom

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApp, defineComponent, nextTick, type Ref} from 'vue';
import {useWorkspaceHostTeleportAvailability} from '@app/modules/workspace-shell/composables/useWorkspaceHostTeleportAvailability';

const TOOLBAR_HOST_ID = 'workspace-toolbar-teleport-host';
const STATUS_HOST_ID = 'workspace-status-teleport-host';

function mountAvailability() {
    let result!: {
        canTeleportToolbar: Ref<boolean>;
        canTeleportStatus: Ref<boolean>;
    };
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(
        defineComponent({
            setup() {
                result = useWorkspaceHostTeleportAvailability({
                    toolbarHostId: TOOLBAR_HOST_ID,
                    statusHostId: STATUS_HOST_ID,
                });
                return () => null;
            },
        }),
    );
    app.mount(host);
    return {
        ...result,
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

function appendTeleportHost(id: string) {
    const el = document.createElement('div');
    el.id = id;
    document.body.append(el);
    return el;
}

describe('useWorkspaceHostTeleportAvailability', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    it('detects hosts already present on mount without scheduling a fallback timer or observer', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const toolbar = appendTeleportHost(TOOLBAR_HOST_ID);
        const status = appendTeleportHost(STATUS_HOST_ID);

        const mounted = mountAvailability();
        await nextTick();

        expect(mounted.canTeleportToolbar.value).toBe(true);
        expect(mounted.canTeleportStatus.value).toBe(true);
        expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 5_000);

        // Removing hosts does not flip availability because no observer was attached.
        toolbar.remove();
        status.remove();
        await Promise.resolve();
        await nextTick();
        expect(mounted.canTeleportToolbar.value).toBe(true);
        expect(mounted.canTeleportStatus.value).toBe(true);

        mounted.unmount();
    });

    it('discovers hosts mounted before nextTick completes', async () => {
        const mounted = mountAvailability();
        expect(mounted.canTeleportToolbar.value).toBe(false);
        expect(mounted.canTeleportStatus.value).toBe(false);

        appendTeleportHost(TOOLBAR_HOST_ID);
        appendTeleportHost(STATUS_HOST_ID);
        await nextTick();

        expect(mounted.canTeleportToolbar.value).toBe(true);
        expect(mounted.canTeleportStatus.value).toBe(true);

        mounted.unmount();
    });

    it('discovers late hosts via DOM mutation and stops observing and timing out once both exist', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        const mounted = mountAvailability();
        await nextTick();

        expect(mounted.canTeleportToolbar.value).toBe(false);
        expect(mounted.canTeleportStatus.value).toBe(false);
        const fallbackTimerCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5_000);
        expect(fallbackTimerCallIndex).toBeGreaterThanOrEqual(0);
        const fallbackTimerHandle = setTimeoutSpy.mock.results[fallbackTimerCallIndex]?.value;

        const toolbar = appendTeleportHost(TOOLBAR_HOST_ID);
        await Promise.resolve();
        await nextTick();
        expect(mounted.canTeleportToolbar.value).toBe(true);
        expect(mounted.canTeleportStatus.value).toBe(false);

        const status = appendTeleportHost(STATUS_HOST_ID);
        await Promise.resolve();
        await nextTick();
        expect(mounted.canTeleportToolbar.value).toBe(true);
        expect(mounted.canTeleportStatus.value).toBe(true);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(fallbackTimerHandle);

        // Observer has disconnected once both hosts were found.
        toolbar.remove();
        status.remove();
        await Promise.resolve();
        await nextTick();
        expect(mounted.canTeleportToolbar.value).toBe(true);
        expect(mounted.canTeleportStatus.value).toBe(true);

        mounted.unmount();
    });

    it('stops observing after the 5-second timeout when hosts remain absent', async () => {
        const mounted = mountAvailability();
        await nextTick();
        expect(mounted.canTeleportToolbar.value).toBe(false);
        expect(mounted.canTeleportStatus.value).toBe(false);

        vi.advanceTimersByTime(5_000);

        appendTeleportHost(TOOLBAR_HOST_ID);
        appendTeleportHost(STATUS_HOST_ID);
        await Promise.resolve();
        await nextTick();
        expect(mounted.canTeleportToolbar.value).toBe(false);
        expect(mounted.canTeleportStatus.value).toBe(false);

        mounted.unmount();
    });

    it('clears the observer and fallback timer on unmount before hosts appear', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        const mounted = mountAvailability();
        await nextTick();

        const fallbackTimerCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5_000);
        expect(fallbackTimerCallIndex).toBeGreaterThanOrEqual(0);
        const fallbackTimerHandle = setTimeoutSpy.mock.results[fallbackTimerCallIndex]?.value;

        mounted.unmount();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(fallbackTimerHandle);

        appendTeleportHost(TOOLBAR_HOST_ID);
        appendTeleportHost(STATUS_HOST_ID);
        await Promise.resolve();
        await nextTick();
        expect(mounted.canTeleportToolbar.value).toBe(false);
        expect(mounted.canTeleportStatus.value).toBe(false);
    });
});
