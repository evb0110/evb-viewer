// @vitest-environment happy-dom

import {
    mkdir, mkdtemp, readFile, rm,
} from 'node:fs/promises';
import {join} from 'node:path';
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
    ref,
} from 'vue';
import {BrowserLogger} from '@app/utils/browserLogger';
import {createScanCleanupSettingsStore} from '@electron/features/scan-cleanup/createScanCleanupSettingsStore';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {createDefaultScanCleanupSettingsFile} from '@contracts/scanCleanupSettings';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {DEFAULT_SCAN_CLEANUP_DOCUMENT_OUTPUT_MODE} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/runtime/discardScanCleanupDocumentState';
import {
    flushScanCleanupDocumentPreferencesStore,
    flushScanCleanupPreferencesStore,
    getScanCleanupPreferencesStore,
    loadScanCleanupDocumentSettings,
    resetScanCleanupPreferencesStore,
    retryScanCleanupPreferences,
    saveScanCleanupDocumentPreferencesInStore,
    scheduleScanCleanupDocumentPreferencesInStore,
    whenScanCleanupPreferencesReady,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

const capability = vi.hoisted(() => ({value: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
}}));
const temporaryDirectories: string[] = [];

async function createDurableSettingsStore() {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    const directory = await mkdtemp(join(process.cwd(), '.devkit', 'p8-settings-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'scan-cleanup-settings.json');
    return {
        filePath,
        store: createScanCleanupSettingsStore({filePath}),
    };
}

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

    afterEach(async () => {
        vi.useRealTimers();
        resetScanCleanupPreferencesStore();
        await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
            recursive: true,
            force: true,
        })));
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

    it('rebases independently hydrated renderer stores through a second edit', async () => {
        vi.resetModules();
        const firstStoreModule = await import('@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore');
        const {
            filePath, store,
        } = await createDurableSettingsStore();
        capability.value.getSettings.mockImplementation(store.get);
        capability.value.updateSettings.mockImplementation(store.update);

        const firstPreferences = firstStoreModule.getScanCleanupPreferencesStore();
        await firstStoreModule.whenScanCleanupPreferencesReady();

        vi.resetModules();
        const secondStoreModule = await import('@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore');
        const secondPreferences = secondStoreModule.getScanCleanupPreferencesStore();
        await secondStoreModule.whenScanCleanupPreferencesReady();

        firstPreferences.readingOrder = 'rtl';
        await nextTick();
        await firstStoreModule.flushScanCleanupPreferencesStore();

        secondPreferences.binarization = 'sauvola';
        await nextTick();
        await secondStoreModule.flushScanCleanupPreferencesStore();
        expect(secondPreferences.readingOrder).toBe('rtl');

        secondPreferences.normalizeIllumination = false;
        await nextTick();
        await secondStoreModule.flushScanCleanupPreferencesStore();

        const durable = await createScanCleanupSettingsStore({filePath}).get();
        expect(durable.settings.readingOrder).toBe('rtl');
        expect(durable.settings.binarization).toBe('sauvola');
        expect(durable.settings.normalizeIllumination).toBe(false);
        firstStoreModule.resetScanCleanupPreferencesStore();
        secondStoreModule.resetScanCleanupPreferencesStore();

        vi.resetModules();
        const reloadedStoreModule = await import('@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore');
        const reloadedPreferences = reloadedStoreModule.getScanCleanupPreferencesStore();
        await reloadedStoreModule.whenScanCleanupPreferencesReady();
        expect(reloadedPreferences.readingOrder).toBe('rtl');
        expect(reloadedPreferences.binarization).toBe('sauvola');
        expect(reloadedPreferences.normalizeIllumination).toBe(false);
        reloadedStoreModule.resetScanCleanupPreferencesStore();
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
        const {
            filePath, store,
        } = await createDurableSettingsStore();
        const sourceSha256 = 'e'.repeat(64);
        const stored = await store.update({document: {
            sourceSha256,
            patch: {
                outputMode: 'grayscale',
                marginsMm: {
                    leftMm: 11,
                    topMm: 12,
                    rightMm: 13,
                    bottomMm: 14,
                },
                overrides: {
                    '1': createScanCleanupPageOverride({layoutOverride: 'spread'}),
                    '2': createScanCleanupPageOverride({rotationDegrees: 180}),
                    '3': createScanCleanupPageOverride({rotationDegrees: 270}),
                },
                pageOverrideDefaults: createScanCleanupPageOverride({manualSkewDegrees: 1}),
            },
        }});
        capability.value.updateSettings.mockImplementation(store.update);
        let resolveSettings!: (value: ReturnType<typeof createDefaultScanCleanupSettingsFile>) => void;
        capability.value.getSettings.mockImplementationOnce(() => new Promise(resolve => {
            resolveSettings = resolve;
        }));
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
        settings!.setMarginsLinked(false);
        settings!.updateMargin('topMm', 19);
        settings!.values.pageOverrides = {'1': createScanCleanupPageOverride({rotationDegrees: 90})};
        settings!.values.pageOverrides['3'] = createScanCleanupPageOverride({rotationDegrees: 90});
        settings!.values.pageOverrideDefaults!.excluded = true;
        await nextTick();
        delete settings!.values.pageOverrides['3'];
        await nextTick();
        await flushScanCleanupDocumentPreferencesStore();
        expect(capability.value.updateSettings).not.toHaveBeenCalled();
        expect(settings!.documentSettingsReady.value).toBe(false);
        resolveSettings(stored);
        await whenScanCleanupPreferencesReady();
        await vi.waitFor(() => expect(settings!.documentSettingsReady.value).toBe(true));
        await flushScanCleanupDocumentPreferencesStore();

        expect(settings!.values.outputMode).toBe('color');
        expect(settings!.values.marginsMm).toEqual({
            leftMm: 11,
            topMm: 19,
            rightMm: 13,
            bottomMm: 14,
        });
        expect(settings!.values.pageOverrides['1']?.rotationDegrees).toBe(90);
        expect(settings!.values.pageOverrides['1']?.layoutOverride).toBe('spread');
        expect(settings!.values.pageOverrides['2']?.rotationDegrees).toBe(180);
        expect(settings!.values.pageOverrides['3']).toBeUndefined();
        expect(settings!.values.pageOverrideDefaults).toMatchObject({
            manualSkewDegrees: 1,
            excluded: true,
        });
        expect(settings!.documentSettingsReady.value).toBe(true);
        const persisted = await createScanCleanupSettingsStore({filePath}).get();
        expect(persisted.documentOverrides[sourceSha256]).toMatchObject({
            outputMode: 'color',
            marginsMm: {
                leftMm: 11,
                topMm: 19,
                rightMm: 13,
                bottomMm: 14,
            },
            overrides: {
                '1': {
                    rotationDegrees: 90,
                    layoutOverride: 'spread',
                },
                '2': {rotationDegrees: 180},
            },
            pageOverrideDefaults: {
                manualSkewDegrees: 1,
                excluded: true,
            },
        });
        expect(persisted.documentOverrides[sourceSha256]?.overrides?.['3']).toBeUndefined();
        expect(capability.value.updateSettings).toHaveBeenCalledOnce();
        app.unmount();
        host.remove();
    });

    it('promotes edits made before source hashing to the same document record', async () => {
        const legacyDocumentKey = '/documents/source-promotion.pdf';
        const sourceSha256 = 'd'.repeat(64);
        const {
            filePath, store,
        } = await createDurableSettingsStore();
        await store.update({document: {
            sourceSha256,
            patch: {outputMode: 'grayscale'},
        }});
        capability.value.getSettings.mockImplementation(store.get);
        capability.value.updateSettings.mockImplementation(store.update);
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();

        const source = ref<string | null>(null);
        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => `${source.value ?? legacyDocumentKey}\0revision-1`),
                documentRevision: computed(() => 'revision-1'),
                sourceSha256: computed(() => source.value),
                legacyDocumentKey: computed(() => legacyDocumentKey),
            });
            return () => h('div');
        }}));
        app.mount(host);
        await vi.waitFor(() => expect(settings!.documentSettingsReady.value).toBe(true));

        settings!.values.outputMode = 'color';
        await nextTick();
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(350);
        expect(capability.value.updateSettings).not.toHaveBeenCalled();
        vi.useRealTimers();
        source.value = sourceSha256;
        await nextTick();
        await vi.waitFor(() => expect(settings!.documentSettingsReady.value).toBe(true));
        await flushScanCleanupDocumentPreferencesStore();

        expect(settings!.values.outputMode).toBe('color');
        expect((await createScanCleanupSettingsStore({filePath}).get()).documentOverrides[sourceSha256]?.outputMode).toBe('color');
        expect(capability.value.updateSettings).toHaveBeenCalledOnce();
        app.unmount();
        host.remove();

        resetScanCleanupPreferencesStore();
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const reloaded = await loadScanCleanupDocumentSettings(sourceSha256, legacyDocumentKey);
        expect(reloaded.outputMode).toBe('color');
    });

    it('does not promote a discarded unresolved document edit after source hashing', async () => {
        const legacyDocumentKey = '/documents/discarded-before-hash.pdf';
        const sourceSha256 = 'c'.repeat(64);
        const durable = createDefaultScanCleanupSettingsFile();
        capability.value.getSettings.mockResolvedValue(structuredClone(durable));
        capability.value.updateSettings.mockResolvedValue(structuredClone(durable));
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();

        scheduleScanCleanupDocumentPreferencesInStore(null, legacyDocumentKey, {outputMode: 'color'});
        await discardScanCleanupDocumentState(legacyDocumentKey);
        await loadScanCleanupDocumentSettings(sourceSha256, legacyDocumentKey);
        await flushScanCleanupDocumentPreferencesStore();

        expect(capability.value.updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({document: expect.anything()}));
    });

    it('retains unresolved queued patches through the debounce until source promotion', async () => {
        const {
            filePath, store,
        } = await createDurableSettingsStore();
        const legacyDocumentKey = '/documents/queued-before-hash.pdf';
        const sourceSha256 = 'c'.repeat(64);
        capability.value.getSettings.mockImplementation(store.get);
        capability.value.updateSettings.mockImplementation(store.update);
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        vi.useFakeTimers();
        await scheduleScanCleanupDocumentPreferencesInStore(null, legacyDocumentKey, {outputMode: 'color'});
        await vi.advanceTimersByTimeAsync(350);
        expect(capability.value.updateSettings).not.toHaveBeenCalled();
        vi.useRealTimers();
        await loadScanCleanupDocumentSettings(sourceSha256, legacyDocumentKey);
        await flushScanCleanupDocumentPreferencesStore();
        expect((await createScanCleanupSettingsStore({filePath}).get()).documentOverrides[sourceSha256]?.outputMode).toBe('color');
        expect(capability.value.updateSettings).toHaveBeenCalledOnce();
    });

    it('does not carry unresolved edits into a different document revision', async () => {
        const legacyDocumentKey = '/documents/reused-path.pdf';
        const sourceSha256 = 'e'.repeat(64);
        const durable = createDefaultScanCleanupSettingsFile();
        durable.documentOverrides[sourceSha256] = {
            outputMode: 'grayscale',
            lastUsedAtMs: 1,
        };
        capability.value.getSettings.mockResolvedValue(structuredClone(durable));
        capability.value.updateSettings.mockResolvedValue(structuredClone(durable));
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();

        const source = ref<string | null>(null);
        const revision = ref('revision-1');
        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => `${source.value ?? legacyDocumentKey}\0${revision.value}`),
                documentRevision: computed(() => revision.value),
                sourceSha256: computed(() => source.value),
                legacyDocumentKey: computed(() => legacyDocumentKey),
            });
            return () => h('div');
        }}));
        app.mount(host);
        await vi.waitFor(() => expect(settings!.documentSettingsReady.value).toBe(true));

        settings!.values.outputMode = 'color';
        await nextTick();
        revision.value = 'revision-2';
        source.value = sourceSha256;
        await nextTick();
        await vi.waitFor(() => expect(settings!.documentSettingsReady.value).toBe(true));
        await flushScanCleanupDocumentPreferencesStore();

        expect(settings!.values.outputMode).toBe('grayscale');
        expect(capability.value.updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({document: expect.anything()}));
        app.unmount();
        host.remove();
    });

    it.each([
        'switch',
        'dispose',
        'discard',
    ] as const)('rejects stale document hydration after %s', async action => {
        const {
            filePath, store,
        } = await createDurableSettingsStore();
        capability.value.getSettings.mockImplementation(store.get);
        capability.value.updateSettings.mockImplementation(store.update);
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const firstHash = 'a'.repeat(64);
        const secondHash = 'b'.repeat(64);
        await store.update({document: {
            sourceSha256: firstHash,
            patch: {outputMode: 'grayscale'},
        }});
        const stored = await store.update({document: {
            sourceSha256: secondHash,
            patch: {outputMode: 'bw'},
        }});
        let resolveRead!: (value: typeof stored) => void;
        const delayedRead = new Promise<typeof stored>(resolve => { resolveRead = resolve; });
        capability.value.getSettings.mockImplementationOnce(() => delayedRead);
        const source = ref(firstHash);
        let settings!: ReturnType<typeof useScanCleanupDocumentSettings>;
        const host = document.createElement('div');
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => source.value),
                sourceSha256: computed(() => source.value),
                legacyDocumentKey: computed(() => source.value),
            });
            return () => h('div');
        }}));
        app.mount(host);
        await nextTick();
        settings.values.outputMode = 'color';
        settings.updateMargin('topMm', 18);
        await nextTick();
        if (action === 'switch') {
            source.value = secondHash;
            await vi.waitFor(() => expect(settings.documentSettingsReady.value).toBe(true));
        } else if (action === 'dispose') {
            app.unmount();
        } else {
            await discardScanCleanupDocumentState(firstHash, firstHash);
        }
        vi.useFakeTimers();
        resolveRead(stored);
        await vi.advanceTimersByTimeAsync(0);
        await flushScanCleanupDocumentPreferencesStore();
        vi.useRealTimers();
        expect(settings.values.outputMode).toBe(action === 'switch' ? 'bw' : 'color');
        expect((await createScanCleanupSettingsStore({filePath}).get()).documentOverrides[firstHash]?.outputMode).toBe('grayscale');
        expect(capability.value.updateSettings).toHaveBeenCalledTimes(action === 'discard' ? 1 : 0);
        if (action !== 'dispose') app.unmount();
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

    it.each([
        'initial',
        'document',
    ] as const)('retries failed %s hydration without persisting defaults and retains edits during the recovered write', async stage => {
        const {
            filePath, store,
        } = await createDurableSettingsStore();
        const sourceSha256 = 'f'.repeat(64);
        if (stage === 'document') {
            capability.value.getSettings.mockImplementation(store.get);
            getScanCleanupPreferencesStore();
            await whenScanCleanupPreferencesReady();
        }
        await store.update({document: {
            sourceSha256,
            patch: {
                marginsMm: {
                    leftMm: 21,
                    topMm: 22,
                    rightMm: 23,
                    bottomMm: 24,
                },
                outputMode: 'grayscale',
                overrides: {'2': createScanCleanupPageOverride({rotationDegrees: 180})},
            },
        }});
        const originalBytes = await readFile(filePath, 'utf8');
        let rejectRead!: (error: Error) => void;
        capability.value.getSettings.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
        let settings!: ReturnType<typeof useScanCleanupDocumentSettings>;
        const host = document.createElement('div');
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => 'retry-hydration'),
                sourceSha256: computed(() => sourceSha256),
            });
            return () => h('div');
        }}));
        app.mount(host);
        await vi.waitFor(() => expect(capability.value.getSettings).toHaveBeenCalledTimes(stage === 'initial' ? 1 : 2));
        settings.setMarginsLinked(true);
        settings.updateMargin('topMm', 17);
        settings.values.outputMode = 'color';
        settings.resetPageOverrides();
        rejectRead(new Error('read failed'));
        await vi.waitFor(() => expect(settings.documentSettingsLoadFailure.value).not.toBeNull());
        await flushScanCleanupDocumentPreferencesStore();
        expect(settings.documentSettingsReady.value).toBe(false);
        expect(settings.values.marginsMm.topMm).toBe(17);
        expect(capability.value.updateSettings).not.toHaveBeenCalled();
        expect(await readFile(filePath, 'utf8')).toBe(originalBytes);

        capability.value.getSettings.mockImplementation(store.get);
        let releaseWrite!: () => void;
        const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
        capability.value.updateSettings.mockImplementationOnce(async request => {
            await writeGate;
            return store.update(request);
        }).mockImplementation(store.update);
        settings.documentSettingsLoadFailure.value?.actions?.[0]?.onClick();
        await vi.waitFor(() => expect(settings.documentSettingsReady.value).toBe(true));
        expect(settings.documentSettingsLoadFailure.value).toBeNull();
        const firstFlush = flushScanCleanupDocumentPreferencesStore();
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledOnce());
        settings.values.outputMode = 'bw';
        settings.values.pageOverrides['3'] = createScanCleanupPageOverride({manualSkewDegrees: 2});
        delete settings.values.pageOverrides['3'];
        releaseWrite();
        await firstFlush;
        await flushScanCleanupDocumentPreferencesStore();
        const reloaded = await createScanCleanupSettingsStore({filePath}).get();
        expect(reloaded.documentOverrides[sourceSha256]).toMatchObject({
            outputMode: 'bw',
            marginsMm: {
                leftMm: 17,
                topMm: 17,
                rightMm: 17,
                bottomMm: 17,
            },
        });
        expect(reloaded.documentOverrides[sourceSha256]?.overrides ?? {}).toEqual({});
        expect(settings.values.outputMode).toBe('bw');
        app.unmount();
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

    it('waits for a global edit admitted during the close flush', async () => {
        const durable = createDefaultScanCleanupSettingsFile();
        capability.value.getSettings.mockImplementation(async () => structuredClone(durable));
        let releaseFirst!: () => void;
        const firstWrite = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        capability.value.updateSettings.mockImplementation(async request => {
            if ('settingsPatch' in request) {
                if (capability.value.updateSettings.mock.calls.length === 1) {
                    await firstWrite;
                }
                Object.assign(durable.settings, request.settingsPatch);
            }
            return structuredClone(durable);
        });
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const preferences = getScanCleanupPreferencesStore();
        preferences.readingOrder = 'rtl';
        await nextTick();
        const firstFlush = flushScanCleanupPreferencesStore();
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledTimes(1));

        const closeFlush = flushScanCleanupPreferencesStore();
        preferences.binarization = 'sauvola';
        await nextTick();
        releaseFirst();

        await closeFlush;

        expect(capability.value.updateSettings).toHaveBeenCalledTimes(2);
        expect(durable.settings.readingOrder).toBe('rtl');
        expect(durable.settings.binarization).toBe('sauvola');
        await firstFlush;
    });

    it('waits for global settings hydration before the close flush', async () => {
        const durable = createDefaultScanCleanupSettingsFile();
        let resolveHydration!: (value: ReturnType<typeof createDefaultScanCleanupSettingsFile>) => void;
        capability.value.getSettings.mockImplementationOnce(() => new Promise(resolve => {
            resolveHydration = resolve;
        }));
        capability.value.updateSettings.mockImplementation(async request => {
            if ('settingsPatch' in request) {
                Object.assign(durable.settings, request.settingsPatch);
            }
            return structuredClone(durable);
        });
        getScanCleanupPreferencesStore();
        const preferences = getScanCleanupPreferencesStore();
        preferences.binarization = 'sauvola';
        await nextTick();

        const closeFlush = flushScanCleanupPreferencesStore();
        await Promise.resolve();
        expect(capability.value.updateSettings).not.toHaveBeenCalled();

        resolveHydration(structuredClone(durable));
        await closeFlush;

        expect(capability.value.updateSettings).toHaveBeenCalledWith({settingsPatch: {binarization: 'sauvola'}});
        expect(durable.settings.binarization).toBe('sauvola');
    });

    it('waits for a document edit admitted during the close flush', async () => {
        const durable = createDefaultScanCleanupSettingsFile();
        const sourceSha256 = 'a'.repeat(64);
        const legacyDocumentKey = '/documents/close-flush.pdf';
        let releaseFirst!: () => void;
        const firstWrite = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        capability.value.updateSettings.mockImplementation(async request => {
            if ('document' in request) {
                if (capability.value.updateSettings.mock.calls.length === 1) {
                    await firstWrite;
                }
                const document = request.document;
                const entry = durable.documentOverrides[document.sourceSha256] ?? {lastUsedAtMs: 0};
                Object.assign(entry, document.patch);
                durable.documentOverrides[document.sourceSha256] = entry;
            }
            return structuredClone(durable);
        });
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();

        const firstWritePromise = saveScanCleanupDocumentPreferencesInStore(
            sourceSha256,
            legacyDocumentKey,
            {outputMode: 'color'},
        );
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledTimes(1));
        const closeFlush = flushScanCleanupDocumentPreferencesStore();
        const finalWritePromise = saveScanCleanupDocumentPreferencesInStore(
            sourceSha256,
            legacyDocumentKey,
            {marginsMm: {
                topMm: 12,
                rightMm: 12,
                bottomMm: 12,
                leftMm: 12,
            }},
        );
        releaseFirst();

        await closeFlush;

        expect(capability.value.updateSettings).toHaveBeenCalledTimes(2);
        expect(durable.documentOverrides[sourceSha256]?.outputMode).toBe('color');
        expect(durable.documentOverrides[sourceSha256]?.marginsMm).toEqual({
            topMm: 12,
            rightMm: 12,
            bottomMm: 12,
            leftMm: 12,
        });
        await Promise.all([
            firstWritePromise,
            finalWritePromise,
        ]);
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

    it('does not retry a document that is already waiting in the write queue', async () => {
        vi.useFakeTimers();
        const sourceA = 'a'.repeat(64);
        const sourceB = 'b'.repeat(64);
        const durable = createDefaultScanCleanupSettingsFile();
        let releaseB!: (value: ReturnType<typeof createDefaultScanCleanupSettingsFile>) => void;
        capability.value.updateSettings
            .mockRejectedValueOnce(new Error('temporary A failure'))
            .mockImplementationOnce(request => new Promise(resolve => {
                releaseB = () => {
                    if (request.document) {
                        const entry = durable.documentOverrides[request.document.sourceSha256] ?? {lastUsedAtMs: 0};
                        Object.assign(entry, request.document.patch);
                        durable.documentOverrides[request.document.sourceSha256] = entry;
                    }
                    resolve(structuredClone(durable));
                };
            }))
            .mockImplementation(async request => {
                if (request.document) {
                    const entry = durable.documentOverrides[request.document.sourceSha256] ?? {lastUsedAtMs: 0};
                    Object.assign(entry, request.document.patch);
                    durable.documentOverrides[request.document.sourceSha256] = entry;
                }
                return structuredClone(durable);
            });
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        await expect(saveScanCleanupDocumentPreferencesInStore(sourceA, '/a.pdf', {outputMode: 'color'}))
            .rejects.toThrow('temporary A failure');
        const bWrite = saveScanCleanupDocumentPreferencesInStore(sourceB, '/b.pdf', {outputMode: 'grayscale'});
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledTimes(2));

        await vi.advanceTimersByTimeAsync(1_000);
        expect(capability.value.updateSettings.mock.calls.filter(([request]) => request.document?.sourceSha256 === sourceB)).toHaveLength(1);

        releaseB(structuredClone(durable));
        await bWrite;
        await vi.runAllTimersAsync();
        await vi.waitFor(() => expect(capability.value.updateSettings.mock.calls.filter(([request]) => request.document?.sourceSha256 === sourceA)).toHaveLength(2));
        expect(capability.value.updateSettings.mock.calls.filter(([request]) => request.document?.sourceSha256 === sourceB)).toHaveLength(1);
    });

    it('does not reset a failed document retry budget when another document saves', async () => {
        vi.useFakeTimers();
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const firstHash = 'a'.repeat(64);
        const secondHash = 'b'.repeat(64);
        let fail = true;
        let attempts = 0;
        capability.value.updateSettings.mockImplementation(async request => {
            if (request.document?.sourceSha256 === firstHash) {
                attempts += 1;
                if (fail) throw new Error('storage unavailable');
            }
            return createDefaultScanCleanupSettingsFile();
        });
        await expect(saveScanCleanupDocumentPreferencesInStore(firstHash, 'A', {outputMode: 'color'})).rejects.toThrow('storage unavailable');
        for (const delay of [
            1000,
            2000,
            4000,
            8000,
            16000,
        ]) {
            await saveScanCleanupDocumentPreferencesInStore(secondHash, 'B', {outputMode: 'bw'});
            await vi.advanceTimersByTimeAsync(delay);
        }
        expect(attempts).toBe(6);
        await vi.advanceTimersByTimeAsync(30000);
        expect(attempts).toBe(6);
        fail = false;
        await flushScanCleanupDocumentPreferencesStore();
        expect(attempts).toBe(7);
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
