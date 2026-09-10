import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDefaultScanCleanupSettingsFile,
    decodeScanCleanupSettingsUpdateRequest,
    SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS,
    SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
} from '@contracts/scanCleanupSettings';
import type {IScanCleanupPageOverride} from '@contracts/electronApiScanCleanup';
import {createScanCleanupSettingsStore} from '@electron/features/scan-cleanup/createScanCleanupSettingsStore';

const temporaryDirectories: string[] = [];

async function createStoreFile() {
    const directory = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-settings-'));
    temporaryDirectories.push(directory);
    return join(directory, 'scan-cleanup-settings.json');
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        recursive: true,
        force: true,
    })));
});

describe('file-backed scan-cleanup settings store', () => {
    it('keeps the previous file intact when replacement is interrupted', async () => {
        const filePath = await createStoreFile();
        const initial = createDefaultScanCleanupSettingsFile();
        await writeFile(filePath, `${JSON.stringify(initial)}\n`, 'utf8');
        const store = createScanCleanupSettingsStore({
            filePath,
            replace: async () => {
                throw new Error('simulated interrupted promotion');
            },
        });

        await expect(store.update({settings: {
            ...initial.settings,
            readingOrder: 'rtl',
        }})).rejects.toThrow('simulated interrupted promotion');
        expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(initial);
    });

    it('merges a global patch with fields written by another settings client', async () => {
        const filePath = await createStoreFile();
        const initial = createDefaultScanCleanupSettingsFile();
        initial.settings.readingOrder = 'rtl';
        await writeFile(filePath, `${JSON.stringify(initial)}\n`, 'utf8');
        const store = createScanCleanupSettingsStore({filePath});

        const updated = await store.update({settingsPatch: {firstRunGuidanceDismissed: true}});

        expect(updated.settings).toMatchObject({
            readingOrder: 'rtl',
            firstRunGuidanceDismissed: true,
        });
    });

    it('quarantines malformed JSON, preserves its bytes, and atomically writes defaults', async () => {
        const filePath = await createStoreFile();
        const corruptRaw = '{"schemaVersion":1,"settings":';
        await writeFile(filePath, corruptRaw, 'utf8');
        const logger = {warn: vi.fn()};
        const store = createScanCleanupSettingsStore({
            filePath,
            logger,
        });

        await expect(store.get()).resolves.toEqual(createDefaultScanCleanupSettingsFile());
        expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(createDefaultScanCleanupSettingsFile());
        const directory = join(filePath, '..');
        const quarantinedName = (await readdir(directory))
            .find(name => /^scan-cleanup-settings\.json\.\d+\.corrupt$/u.test(name));
        expect(quarantinedName).toBeDefined();
        await expect(readFile(join(directory, quarantinedName!), 'utf8')).resolves.toBe(corruptRaw);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Quarantined corrupt scan-cleanup settings'));
    });

    it('rejects an unsupported future schema without quarantining or overwriting it', async () => {
        const filePath = await createStoreFile();
        const futureRaw = `${JSON.stringify({
            schemaVersion: 99,
            settings: {},
            documentOverrides: {},
        }, null, 2)}\n`;
        await writeFile(filePath, futureRaw, 'utf8');
        const logger = {warn: vi.fn()};
        const store = createScanCleanupSettingsStore({
            filePath,
            logger,
        });

        await expect(store.get()).rejects.toThrow('Unsupported scan-cleanup settings schema version: 99');
        expect(await readFile(filePath, 'utf8')).toBe(futureRaw);
        expect(await readdir(join(filePath, '..'))).toEqual(['scan-cleanup-settings.json']);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('rewrites a pre-ink settings file at the current schema with ink as its alignment', async () => {
        const filePath = await createStoreFile();
        const base = createDefaultScanCleanupSettingsFile();
        await writeFile(filePath, `${JSON.stringify({
            ...base,
            schemaVersion: 1,
            settings: {
                ...base.settings,
                pageAlignment: 'top-center',
                readingOrder: 'rtl',
            },
        })}\n`, 'utf8');
        const store = createScanCleanupSettingsStore({filePath});

        const loaded = await store.get();
        expect(loaded.settings).toMatchObject({
            pageAlignment: 'ink',
            readingOrder: 'rtl',
        });
        expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
            schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
            settings: {pageAlignment: 'ink'},
        });
    });

    it('treats a legacy renderer export as pre-ink when seeding the settings file', async () => {
        const filePath = await createStoreFile();
        const store = createScanCleanupSettingsStore({filePath});

        const seeded = await store.get({legacyStorage: {
            settingsRaw: JSON.stringify({
                pageAlignment: 'top-center',
                readingOrder: 'rtl',
            }),
            documentOverridesRaw: '{}',
            exportedAtMs: 10,
        }});
        expect(seeded.settings).toMatchObject({
            pageAlignment: 'ink',
            readingOrder: 'rtl',
        });
    });

    it('merges the legacy export into a SHA-256 key with newest-wins semantics', async () => {
        const filePath = await createStoreFile();
        const sourceSha256 = 'A'.repeat(64);
        const legacyDocumentKey = '/documents/scan.pdf';
        const legacyOverrides = {[legacyDocumentKey]: {
            updatedAt: 20,
            overrides: {'1': {
                rotationDegrees: 90,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
            }},
        }};
        const store = createScanCleanupSettingsStore({
            filePath,
            now: () => 100,
        });

        const migrated = await store.get({
            legacyStorage: {
                settingsRaw: JSON.stringify({
                    readingOrder: 'rtl',
                    updatedAt: 10,
                }),
                documentOverridesRaw: JSON.stringify(legacyOverrides),
                exportedAtMs: 10,
            },
            sourceSha256,
            legacyDocumentKey,
        });
        expect(migrated.settings.readingOrder).toBe('rtl');
        expect(migrated.documentOverrides).toEqual({[sourceSha256.toLowerCase()]: expect.objectContaining({
            lastUsedAtMs: 20,
            overrides: legacyOverrides[legacyDocumentKey].overrides,
        })});
        expect(migrated.documentOverrides[legacyDocumentKey]).toBeUndefined();

        const updated = await store.update({document: {
            sourceSha256: sourceSha256.toLowerCase(),
            patch: {outputMode: 'grayscale'},
        }});
        expect(updated.documentOverrides[sourceSha256.toLowerCase()]).toMatchObject({
            outputMode: 'grayscale',
            lastUsedAtMs: 100,
        });
    });

    it('resets only page overrides while preserving document margins and output mode', async () => {
        const filePath = await createStoreFile();
        const sourceSha256 = 'd'.repeat(64);
        const initial = createDefaultScanCleanupSettingsFile();
        initial.documentOverrides[sourceSha256] = {
            overrides: {'1': {
                rotationDegrees: 90,
                layoutOverride: 'spread',
                excluded: false,
                manualSplit: null,
            }},
            marginsMm: {
                leftMm: 4,
                topMm: 5,
                rightMm: 6,
                bottomMm: 7,
            },
            outputMode: 'color',
            lastUsedAtMs: 1,
        };
        await writeFile(filePath, JSON.stringify(initial), 'utf8');
        const store = createScanCleanupSettingsStore({
            filePath,
            now: () => 2,
        });

        const updated = await store.update({document: {
            sourceSha256,
            patch: {resetOverrides: true},
        }});

        expect(updated.documentOverrides[sourceSha256]).toEqual({
            marginsMm: initial.documentOverrides[sourceSha256]!.marginsMm,
            outputMode: 'color',
            lastUsedAtMs: 2,
        });
    });

    it('stores a scalar page override default without materializing page entries', async () => {
        const filePath = await createStoreFile();
        const sourceSha256 = 's'.repeat(64);
        const pageOverrideDefaults: IScanCleanupPageOverride = {
            rotationDegrees: 90,
            layoutOverride: 'auto',
            excluded: true,
            manualSplit: null,
        };
        const store = createScanCleanupSettingsStore({
            filePath,
            now: () => 3,
        });

        const updated = await store.update({document: {
            sourceSha256,
            patch: {
                overrides: {},
                pageOverrideDefaults,
            },
        }});

        expect(updated.documentOverrides[sourceSha256]).toMatchObject({
            pageOverrideDefaults,
            lastUsedAtMs: 3,
        });
        expect(updated.documentOverrides[sourceSha256]?.overrides).toEqual({});

        const reset = await store.update({document: {
            sourceSha256,
            patch: {resetOverrides: true},
        }});
        expect(reset.documentOverrides[sourceSha256]).toBeUndefined();
    });

    it('skips one malformed legacy document while preserving valid siblings and globals', async () => {
        const filePath = await createStoreFile();
        const logger = {warn: vi.fn()};
        const validHash = 'e'.repeat(64);
        const store = createScanCleanupSettingsStore({
            filePath,
            logger,
        });

        const migrated = await store.get({legacyStorage: {
            settingsRaw: JSON.stringify({readingOrder: 'rtl'}),
            documentOverridesRaw: JSON.stringify({
                '/documents/broken.pdf': {overrides: {'01': {
                    rotationDegrees: 0,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplit: null,
                }}},
                [validHash]: {
                    outputMode: 'grayscale',
                    updatedAt: 20,
                },
            }),
        }});

        expect(migrated.settings.readingOrder).toBe('rtl');
        expect(migrated.documentOverrides[validHash]).toMatchObject({
            outputMode: 'grayscale',
            lastUsedAtMs: 20,
        });
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 document entry'));
    });

    it('skips malformed legacy globals without discarding valid documents', async () => {
        const filePath = await createStoreFile();
        const logger = {warn: vi.fn()};
        const validHash = 'f'.repeat(64);
        const store = createScanCleanupSettingsStore({
            filePath,
            logger,
        });

        const migrated = await store.get({legacyStorage: {
            settingsRaw: '[]',
            documentOverridesRaw: JSON.stringify({[validHash]: {outputMode: 'color'}}),
        }});

        expect(migrated.settings).toEqual(createDefaultScanCleanupSettingsFile().settings);
        expect(migrated.documentOverrides[validHash]?.outputMode).toBe('color');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 global'));
    });

    it('skips an oversized legacy envelope without altering an existing store', async () => {
        const filePath = await createStoreFile();
        const initial = createDefaultScanCleanupSettingsFile();
        initial.settings.readingOrder = 'rtl';
        await writeFile(filePath, JSON.stringify(initial), 'utf8');
        const logger = {warn: vi.fn()};
        const store = createScanCleanupSettingsStore({
            filePath,
            logger,
        });

        const loaded = await store.get({legacyStorage: {
            settingsRaw: JSON.stringify({readingOrder: 'ltr'}),
            documentOverridesRaw: 'x'.repeat(6 * 1024 * 1024),
        }});

        expect(loaded).toEqual(initial);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('1 envelope'));
        expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(initial);
    });

    it('keeps new page-override writes strict at the IPC boundary', () => {
        expect(() => decodeScanCleanupSettingsUpdateRequest({document: {
            sourceSha256: 'a'.repeat(64),
            patch: {overrides: {'01': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
            }}},
        }})).toThrow('page override number');
    });

    it('expires old document overrides on load and keeps recent entries', async () => {
        const filePath = await createStoreFile();
        const now = SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS * 2 + 1_000_000;
        const oldHash = 'b'.repeat(64);
        const freshHash = 'c'.repeat(64);
        const initial = createDefaultScanCleanupSettingsFile();
        initial.documentOverrides = {
            [oldHash]: {lastUsedAtMs: now - SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS - 1},
            [freshHash]: {lastUsedAtMs: now - SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS},
        };
        await writeFile(filePath, JSON.stringify(initial), 'utf8');
        const store = createScanCleanupSettingsStore({
            filePath,
            now: () => now,
        });

        const loaded = await store.get();
        expect(Object.keys(loaded.documentOverrides)).toEqual([freshHash]);
        const persisted = JSON.parse(await readFile(filePath, 'utf8'));
        expect(Object.keys(persisted.documentOverrides)).toEqual([freshHash]);
    });

    it('merges a legacy document when pruning also changes the store', async () => {
        const filePath = await createStoreFile();
        const now = SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS * 2 + 1_000_000;
        const expiredHash = 'b'.repeat(64);
        const sourceSha256 = 'c'.repeat(64);
        const legacyDocumentKey = '/documents/legacy-scan.pdf';
        const initial = createDefaultScanCleanupSettingsFile();
        initial.documentOverrides = {
            [expiredHash]: {lastUsedAtMs: now - SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_AGE_MS - 1},
        };
        await writeFile(filePath, JSON.stringify(initial), 'utf8');
        const store = createScanCleanupSettingsStore({
            filePath,
            now: () => now,
        });

        const loaded = await store.get({
            legacyStorage: {
                settingsRaw: null,
                documentOverridesRaw: JSON.stringify({[legacyDocumentKey]: {
                    updatedAt: now,
                    outputMode: 'grayscale',
                }}),
                exportedAtMs: now,
            },
            sourceSha256,
            legacyDocumentKey,
        });

        expect(loaded.documentOverrides).toEqual({
            [sourceSha256]: {
                outputMode: 'grayscale',
                lastUsedAtMs: now,
            },
        });
    });
});
