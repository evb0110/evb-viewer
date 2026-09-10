import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_CAPABILITY_TIER_SUPPORT,
    resolveBrowserCapabilityTier,
} from '@app/platform/browser/browserCapabilityTier';
import type {
    TBrowserCapabilityTier,
    TBrowserFileAccessTier,
} from '@app/platform/browser/browserCapabilityTier';

interface IRuntimeShape {
    hasOpenPicker: boolean;
    hasSavePicker: boolean;
    hasIndexedDb: boolean;
    fileAccessTier: TBrowserFileAccessTier;
}

const RUNTIME_SHAPES: readonly IRuntimeShape[] = [
    {
        hasOpenPicker: true,
        hasSavePicker: true,
        hasIndexedDb: true,
        fileAccessTier: 'file-system-access',
    },
    {
        hasOpenPicker: true,
        hasSavePicker: true,
        hasIndexedDb: false,
        fileAccessTier: 'file-system-access',
    },
    {
        hasOpenPicker: true,
        hasSavePicker: false,
        hasIndexedDb: true,
        fileAccessTier: 'open-handle-only',
    },
    {
        hasOpenPicker: true,
        hasSavePicker: false,
        hasIndexedDb: false,
        fileAccessTier: 'open-handle-only',
    },
    {
        hasOpenPicker: false,
        hasSavePicker: true,
        hasIndexedDb: true,
        fileAccessTier: 'save-handle-only',
    },
    {
        hasOpenPicker: false,
        hasSavePicker: true,
        hasIndexedDb: false,
        fileAccessTier: 'save-handle-only',
    },
    {
        hasOpenPicker: false,
        hasSavePicker: false,
        hasIndexedDb: true,
        fileAccessTier: 'download-only',
    },
    {
        hasOpenPicker: false,
        hasSavePicker: false,
        hasIndexedDb: false,
        fileAccessTier: 'download-only',
    },
];

function stubRuntime(shape: IRuntimeShape) {
    const receivers: unknown[] = [];
    const pickerWindow = {
        ...(shape.hasOpenPicker
            ? {showOpenFilePicker(this: unknown) {
                receivers.push(this);
                return Promise.resolve([]);
            }}
            : {}),
        ...(shape.hasSavePicker
            ? {showSaveFilePicker(this: unknown) {
                receivers.push(this);
                return Promise.resolve({name: 'picked.pdf'});
            }}
            : {}),
    };
    const indexedDbFactory = shape.hasIndexedDb ? {open: vi.fn()} : undefined;

    vi.stubGlobal('window', pickerWindow);
    vi.stubGlobal('indexedDB', indexedDbFactory);
    return {
        indexedDbFactory,
        pickerWindow,
        receivers,
    };
}

describe('browser capability tier', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('declares one level per independent picker and persistence combination', () => {
        const expectedTiers = RUNTIME_SHAPES.map((shape): TBrowserCapabilityTier =>
            `${shape.fileAccessTier}-${shape.hasIndexedDb ? 'persistent' : 'volatile'}`);

        expect(Object.keys(BROWSER_CAPABILITY_TIER_SUPPORT).sort()).toEqual(expectedTiers.sort());
        expect(new Set(Object.values(BROWSER_CAPABILITY_TIER_SUPPORT)
            .map(support => Object.values(support).join(':'))).size).toBe(RUNTIME_SHAPES.length);
    });

    it('resolves every runtime shape to its authoritative support policy', () => {
        for (const shape of RUNTIME_SHAPES) {
            const {indexedDbFactory} = stubRuntime(shape);
            const capabilities = resolveBrowserCapabilityTier();

            expect(capabilities.support).toBe(BROWSER_CAPABILITY_TIER_SUPPORT[capabilities.tier]);
            expect(capabilities.support.opensWithHandle).toBe(shape.hasOpenPicker);
            expect(capabilities.support.savesToChosenTarget).toBe(shape.hasSavePicker);
            expect(capabilities.support.persistentStorage).toBe(shape.hasIndexedDb);
            expect(capabilities.indexedDbFactory).toBe(indexedDbFactory ?? null);
        }
    });

    it('exposes picker commands already bound to the picker window', async () => {
        const runtime = stubRuntime(RUNTIME_SHAPES[0]!);
        const capabilities = resolveBrowserCapabilityTier();

        await capabilities.openFilePicker?.();
        await capabilities.saveFilePicker?.();

        expect(runtime.receivers).toEqual([
            runtime.pickerWindow,
            runtime.pickerWindow,
        ]);
    });

    it('degrades to volatile downloads outside a browser runtime', () => {
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('indexedDB', undefined);

        expect(resolveBrowserCapabilityTier()).toMatchObject({
            tier: 'download-only-volatile',
            openFilePicker: null,
            saveFilePicker: null,
            indexedDbFactory: null,
        });
    });

    it('degrades to volatile storage when IndexedDB access itself is denied', () => {
        vi.stubGlobal('window', {});
        Object.defineProperty(globalThis, 'indexedDB', {
            configurable: true,
            get() {
                throw new Error('IndexedDB access denied');
            },
        });

        expect(resolveBrowserCapabilityTier()).toMatchObject({
            tier: 'download-only-volatile',
            indexedDbFactory: null,
        });
    });
});
