// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IHostEnvironmentSnapshot } from '@contracts/hostPlatformFeature';
import type { TRefStore } from '@tests/unit/app/composables/installNuxtStateTestStubs';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

/**
 * Windows reports its own display scaling and then scales the app on top of it,
 * so the UI reads too large unless the renderer gives some of that back. This
 * composable owns that compensation, which is why the auto branch is pinned to
 * exact numbers rather than a range.
 */

const mocks = vi.hoisted(() => ({
    environmentListeners: [] as Array<(snapshot: IHostEnvironmentSnapshot) => void>,
    getEnvironment: vi.fn(),
    stopEnvironmentListener: vi.fn(),
    warn: vi.fn(),
}));

const platformApi = createElectronPlatformApiFixture({host: {
    getEnvironment: mocks.getEnvironment,
    onEnvironmentChange: (listener: (snapshot: IHostEnvironmentSnapshot) => void) => {
        mocks.environmentListeners.push(listener);
        return mocks.stopEnvironmentListener;
    },
}});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: mocks.warn,
}}));

const { useUiScale } = await import('@app/composables/useUiScale');

const cookieStore: TRefStore = new Map();
const stateStore: TRefStore = new Map();

function windowsSnapshot(osScaleFactor: number): IHostEnvironmentSnapshot {
    return {
        osScaleFactor,
        platform: 'win32',
    };
}

beforeEach(() => {
    cookieStore.clear();
    stateStore.clear();
    mocks.environmentListeners.length = 0;
    installNuxtStateTestStubs(cookieStore, stateStore);
});

afterEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.platform;
});

describe('useUiScale', () => {
    it('leaves the scale alone on platforms that do not scale themselves', () => {
        const uiScale = useUiScale();

        uiScale.setHostSnapshot({
            osScaleFactor: 2,
            platform: 'darwin',
        });

        expect(uiScale.effectiveScale.value).toBe(1);
    });

    it('gives back part of the Windows display scaling', () => {
        const uiScale = useUiScale();

        uiScale.setHostSnapshot(windowsSnapshot(1.25));
        expect(uiScale.effectiveScale.value).toBeCloseTo(0.92, 5);

        uiScale.setHostSnapshot(windowsSnapshot(1.5));
        expect(uiScale.effectiveScale.value).toBeCloseTo(0.8666667, 5);
    });

    it('never compensates below the readable floor', () => {
        const uiScale = useUiScale();

        uiScale.setHostSnapshot(windowsSnapshot(4));

        expect(uiScale.effectiveScale.value).toBe(0.85);
    });

    it('ignores a Windows scale factor that is absent or not above one', () => {
        const uiScale = useUiScale();

        uiScale.setHostSnapshot(windowsSnapshot(1));
        expect(uiScale.effectiveScale.value).toBe(1);

        uiScale.setHostSnapshot(windowsSnapshot(Number.NaN));
        expect(uiScale.effectiveScale.value).toBe(1);
    });

    it('applies the explicit presets in place of the automatic scale', () => {
        const uiScale = useUiScale();

        uiScale.setHostSnapshot(windowsSnapshot(2));

        uiScale.setPreferenceFromSettings({uiScale: 'compact'});
        expect(uiScale.effectiveScale.value).toBe(0.9);

        uiScale.setPreferenceFromSettings({uiScale: 'large'});
        expect(uiScale.effectiveScale.value).toBe(1.25);

        uiScale.setPreferenceFromSettings({uiScale: 'auto'});
        expect(uiScale.effectiveScale.value).toBe(0.85);
    });

    it('adopts the host snapshot the environment reports', async () => {
        const uiScale = useUiScale();
        mocks.getEnvironment.mockResolvedValue(windowsSnapshot(1.5));

        await uiScale.refreshHostSnapshot();

        expect(uiScale.hostSnapshot.value).toEqual(windowsSnapshot(1.5));
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    it('keeps the previous snapshot when the host cannot be read', async () => {
        const uiScale = useUiScale();
        const before = uiScale.hostSnapshot.value;
        mocks.getEnvironment.mockRejectedValue(new Error('no host bridge'));

        await uiScale.refreshHostSnapshot();

        expect(uiScale.hostSnapshot.value).toEqual(before);
        expect(mocks.warn).toHaveBeenCalledOnce();
    });

    it('tracks later environment changes through the host listener', () => {
        const uiScale = useUiScale();

        const stop = uiScale.attachHostEnvironmentListener();
        mocks.environmentListeners.forEach(listener => listener(windowsSnapshot(1.5)));

        expect(uiScale.effectiveScale.value).toBeCloseTo(0.8666667, 5);
        expect(stop).toBe(mocks.stopEnvironmentListener);
    });

    it('publishes the scale and platform the document styles read', () => {
        const uiScale = useUiScale();

        uiScale.applyUiScaleToDocument(0.9, windowsSnapshot(1.5));

        expect(document.documentElement.style.getPropertyValue('--app-ui-scale')).toBe('0.9');
        expect(document.documentElement.dataset.platform).toBe('win32');
    });
});
