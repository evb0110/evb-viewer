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
    createApp,
    defineComponent,
    h,
    nextTick,
} from 'vue';
import {BrowserLogger} from '@app/utils/browserLogger';
import {createDefaultScanCleanupSettingsFile} from '@contracts/scanCleanupSettings';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/runtime/discardScanCleanupDocumentState';
import {
    flushScanCleanupPreferencesStore,
    getScanCleanupPreferencesStore,
    loadScanCleanupDocumentSettings,
    resetScanCleanupPreferencesStore,
    retryScanCleanupPreferences,
    saveScanCleanupDocumentPreferencesInStore,
    whenScanCleanupPreferencesReady,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

const capability = vi.hoisted(() => ({value: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
}}));

vi.mock('@app/utils/platform', () => ({isDesktopPlatformActive: () => true}));
vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));

describe('scan cleanup renderer preference store', () => {
    beforeEach(() => {
        resetScanCleanupPreferencesStore();
        localStorage.clear();
        vi.clearAllMocks();
        capability.value.getSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());
        capability.value.updateSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());
    });

    afterEach(() => {
        vi.useRealTimers();
        resetScanCleanupPreferencesStore();
    });

    it('persists a document patch under the normalized authoritative source hash', async () => {
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();

        await saveScanCleanupDocumentPreferencesInStore(
            'A'.repeat(64),
            '/documents/book.pdf',
            {outputMode: 'grayscale'},
        );

        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledWith({document: {
            sourceSha256: 'a'.repeat(64),
            legacyDocumentKey: '/documents/book.pdf',
            patch: {outputMode: 'grayscale'},
        }}));
    });

    it('warns when a desktop document patch has no authoritative source hash', async () => {
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const warning = vi.spyOn(BrowserLogger, 'warn');

        await saveScanCleanupDocumentPreferencesInStore(null, '/documents/book.pdf', {outputMode: 'color'});
        await Promise.resolve();

        expect(capability.value.updateSettings).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalledWith(
            'scan-cleanup',
            expect.stringContaining('persist'),
            expect.any(Function),
        );
        warning.mockRestore();
    });

    it('keeps loaded document settings isolated from global preferences without echoing writes', async () => {
        vi.useFakeTimers();
        const sourceSha256 = 'b'.repeat(64);
        const documentKey = '/documents/stored-margins.pdf';
        const stored = createDefaultScanCleanupSettingsFile();
        stored.settings.readingOrder = 'rtl';
        stored.documentOverrides[sourceSha256] = {
            marginsMm: {
                leftMm: 12,
                topMm: 12,
                rightMm: 12,
                bottomMm: 12,
            },
            outputMode: 'color',
            overrides: {'1': {
                rotationDegrees: 90,
                layoutOverride: 'spread',
                excluded: false,
                manualSplit: null,
            }},
            lastUsedAtMs: 1,
        };
        capability.value.getSettings.mockResolvedValue(stored);
        capability.value.updateSettings.mockResolvedValue(stored);
        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => `${documentKey}\0revision-1`),
                legacyDocumentKey: computed(() => documentKey),
                sourceSha256: computed(() => sourceSha256),
            });
            return () => h('div');
        }}));
        app.mount(host);

        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(settings!.values.marginsMm.topMm).toBe(12));
        await vi.advanceTimersByTimeAsync(350);

        expect(getScanCleanupPreferencesStore().marginsMm).toEqual({
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        });
        const updates = capability.value.updateSettings.mock.calls.map(([request]) => request);
        expect(updates.filter(request => request.settings?.marginsMm !== undefined)).toEqual([]);
        expect(updates.filter(request => request.document !== undefined)).toEqual([]);
        app.unmount();
        host.remove();
    });

    it('retains binding edits made while document hydration is pending', async () => {
        vi.useFakeTimers();
        let resolveSettings!: (value: ReturnType<typeof createDefaultScanCleanupSettingsFile>) => void;
        capability.value.getSettings.mockImplementationOnce(() => new Promise(resolve => {
            resolveSettings = resolve;
        }));
        const stored = createDefaultScanCleanupSettingsFile();
        const sourceSha256 = 'e'.repeat(64);
        stored.documentOverrides[sourceSha256] = {
            outputMode: 'grayscale',
            marginsMm: {
                leftMm: 11,
                topMm: 11,
                rightMm: 11,
                bottomMm: 11,
            },
            lastUsedAtMs: 1,
        };
        getScanCleanupPreferencesStore();
        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => 'hydration-race'),
                sourceSha256: computed(() => sourceSha256),
                legacyDocumentKey: computed(() => '/documents/hydration-race.pdf'),
            });
            return () => h('div');
        }}));
        app.mount(host);
        settings!.values.outputMode = 'color';
        settings!.values.marginsMm.topMm = 19;
        settings!.values.pageOverrides = {'1': {
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: null,
        }};
        await nextTick();
        resolveSettings(stored);
        await whenScanCleanupPreferencesReady();
        await vi.advanceTimersByTimeAsync(350);

        expect(settings!.values.outputMode).toBe('color');
        expect(settings!.values.marginsMm.topMm).toBe(19);
        expect(settings!.values.pageOverrides['1']?.rotationDegrees).toBe(90);
        expect(settings!.documentSettingsReady.value).toBe(true);
        app.unmount();
        host.remove();
    });

    it('keeps cleanup settings unavailable when document hydration fails', async () => {
        const failure = new Error('document settings unavailable');
        capability.value.getSettings
            .mockResolvedValueOnce(createDefaultScanCleanupSettingsFile())
            .mockRejectedValueOnce(failure);
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();

        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => 'failed-hydration'),
                sourceSha256: computed(() => 'f'.repeat(64)),
                legacyDocumentKey: computed(() => '/documents/failed-hydration.pdf'),
            });
            return () => h('div');
        }}));
        app.mount(host);

        await vi.waitFor(() => expect(settings!.loadingDocument.value).toBe(false));

        expect(settings!.documentSettingsReady.value).toBe(false);
        expect(settings!.values.outputMode).toBe(DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE);
        app.unmount();
        host.remove();
    });

    it('exports legacy localStorage only for initial hydration and clears it after success', async () => {
        localStorage.setItem('evb.scanCleanup.settings.v1', JSON.stringify({readingOrder: 'rtl'}));
        localStorage.setItem('evb.scanCleanup.documentOverrides.v1', JSON.stringify({'/documents/legacy.pdf': {outputMode: 'color'}}));
        getScanCleanupPreferencesStore({
            sourceSha256: 'd'.repeat(64),
            legacyDocumentKey: '/documents/legacy.pdf',
        });

        await whenScanCleanupPreferencesReady();

        expect(capability.value.getSettings.mock.calls[0]?.[0]).toMatchObject({legacyStorage: {
            settingsRaw: JSON.stringify({readingOrder: 'rtl'}),
            documentOverridesRaw: JSON.stringify({'/documents/legacy.pdf': {outputMode: 'color'}}),
        }});
        expect(localStorage.getItem('evb.scanCleanup.settings.v1')).toBeNull();
        expect(localStorage.getItem('evb.scanCleanup.documentOverrides.v1')).toBeNull();

        await loadScanCleanupDocumentSettings('e'.repeat(64), '/documents/next.pdf');

        expect(capability.value.getSettings).toHaveBeenCalledTimes(2);
        expect(capability.value.getSettings.mock.calls[1]?.[0]).not.toHaveProperty('legacyStorage');
    });

    it('does not enqueue a pending global snapshot equal to the latest main-process value', async () => {
        const remote = createDefaultScanCleanupSettingsFile();
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        capability.value.updateSettings.mockResolvedValue(remote);
        const preferences = getScanCleanupPreferencesStore();
        preferences.readingOrder = 'rtl';
        remote.settings.readingOrder = 'rtl';
        await nextTick();

        await saveScanCleanupDocumentPreferencesInStore(
            'f'.repeat(64),
            '/documents/remote-snapshot.pdf',
            {outputMode: 'color'},
        );
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledWith({document: {
            sourceSha256: 'f'.repeat(64),
            legacyDocumentKey: '/documents/remote-snapshot.pdf',
            patch: {outputMode: 'color'},
        }}));
        await Promise.resolve();
        await flushScanCleanupPreferencesStore();
        await Promise.resolve();

        const settingsUpdates = capability.value.updateSettings.mock.calls
            .map(([request]) => request)
            .filter(request => request.settings !== undefined);
        expect(settingsUpdates).toEqual([]);
    });

    it('sends only changed global fields so concurrent clients can merge them', async () => {
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const preferences = getScanCleanupPreferencesStore();
        preferences.readingOrder = 'rtl';
        await nextTick();
        await flushScanCleanupPreferencesStore();
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledWith({settingsPatch: {readingOrder: 'rtl'}}));
    });

    it('rebases a later global edit without replaying an acknowledged field', async () => {
        const durable = createDefaultScanCleanupSettingsFile();
        capability.value.getSettings.mockImplementation(async () => structuredClone(durable));
        capability.value.updateSettings.mockImplementation(async (request) => {
            if ('settingsPatch' in request) Object.assign(durable.settings, request.settingsPatch);
            return structuredClone(durable);
        });
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const preferences = getScanCleanupPreferencesStore();
        preferences.readingOrder = 'rtl';
        await nextTick();
        await flushScanCleanupPreferencesStore();
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledTimes(1));

        await loadScanCleanupDocumentSettings('a'.repeat(64), '/documents/rebased.pdf');
        preferences.binarization = 'sauvola';
        await nextTick();
        await flushScanCleanupPreferencesStore();

        expect(capability.value.updateSettings.mock.calls.map(([request]) => request)).toEqual([
            {settingsPatch: {readingOrder: 'rtl'}},
            {settingsPatch: {binarization: 'sauvola'}},
        ]);
        expect(durable.settings.readingOrder).toBe('rtl');
        expect(durable.settings.binarization).toBe('sauvola');
    });

    it('keeps a failed global write pending and retries it without another edit', async () => {
        vi.useFakeTimers();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failure = new Error('quota exceeded');
        capability.value.updateSettings
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce(createDefaultScanCleanupSettingsFile());
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const preferences = getScanCleanupPreferencesStore();
        preferences.readingOrder = 'rtl';
        await nextTick();
        await expect(flushScanCleanupPreferencesStore()).rejects.toThrow('quota exceeded');
        await Promise.resolve();
        expect(capability.value.updateSettings).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledTimes(2));
        consoleError.mockRestore();
    });

    it('explicitly retries a settled global failure with a fresh write promise', async () => {
        const durable = createDefaultScanCleanupSettingsFile();
        capability.value.updateSettings
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce(durable);
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const preferences = getScanCleanupPreferencesStore();
        preferences.readingOrder = 'rtl';
        await nextTick();
        await expect(flushScanCleanupPreferencesStore()).rejects.toThrow('temporary failure');
        await retryScanCleanupPreferences();
        expect(capability.value.updateSettings).toHaveBeenCalledTimes(2);
        expect(capability.value.updateSettings).toHaveBeenLastCalledWith({settingsPatch: {readingOrder: 'rtl'}});
    });

    it('drains failed document A after document B succeeds', async () => {
        vi.useFakeTimers();
        const sourceA = 'a'.repeat(64);
        const sourceB = 'b'.repeat(64);
        const durable = createDefaultScanCleanupSettingsFile();
        capability.value.updateSettings
            .mockRejectedValueOnce(new Error('temporary A failure'))
            .mockImplementation(async request => {
                const document = request.document;
                const entry = durable.documentOverrides[document.sourceSha256] ?? {lastUsedAtMs: 0};
                Object.assign(entry, document.patch);
                durable.documentOverrides[document.sourceSha256] = entry;
                return structuredClone(durable);
            });
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        await expect(saveScanCleanupDocumentPreferencesInStore(sourceA, '/a.pdf', {outputMode: 'color'}))
            .rejects.toThrow('temporary A failure');
        await saveScanCleanupDocumentPreferencesInStore(sourceB, '/b.pdf', {outputMode: 'grayscale'});
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledTimes(3));

        expect(durable.documentOverrides[sourceA]?.outputMode).toBe('color');
        expect(durable.documentOverrides[sourceB]?.outputMode).toBe('grayscale');
    });

    it('retains an edit made while initial file-backed hydration is unavailable', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const remote = createDefaultScanCleanupSettingsFile();
        remote.settings.readingOrder = 'ltr';
        capability.value.getSettings
            .mockRejectedValueOnce(new Error('temporary read failure'))
            .mockResolvedValueOnce(remote);
        getScanCleanupPreferencesStore();
        await expect(whenScanCleanupPreferencesReady()).rejects.toThrow('temporary read failure');

        const preferences = getScanCleanupPreferencesStore();
        preferences.readingOrder = 'rtl';
        await retryScanCleanupPreferences();

        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledWith({settingsPatch: {readingOrder: 'rtl'}}));
        consoleError.mockRestore();
    });

    it('does not flush a debounced override patch after document discard', async () => {
        const sourceSha256 = 'c'.repeat(64);
        const documentKey = '/documents/discard-after-edit.pdf';
        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => `${documentKey}\0revision-1`),
                legacyDocumentKey: computed(() => documentKey),
                sourceSha256: computed(() => sourceSha256),
            });
            return () => h('div');
        }}));
        app.mount(host);
        await whenScanCleanupPreferencesReady();
        await nextTick();
        vi.clearAllMocks();
        capability.value.updateSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());

        settings!.values.pageOverrides = {'1': {
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: null,
        }};
        await nextTick();
        await discardScanCleanupDocumentState(documentKey, sourceSha256);
        app.unmount();
        host.remove();

        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalled());
        const documentUpdates = capability.value.updateSettings.mock.calls
            .map(([request]) => request)
            .filter(request => 'document' in request);
        expect(documentUpdates).toEqual([{document: {
            sourceSha256,
            legacyDocumentKey: documentKey,
            patch: {resetOverrides: true},
        }}]);
    });
});
