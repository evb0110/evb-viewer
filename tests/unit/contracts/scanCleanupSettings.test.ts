import {
    describe,
    expect,
    it,
} from 'vitest';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {
    createDefaultScanCleanupSettingsFile,
    decodeScanCleanupGlobalPreferences,
    decodeScanCleanupSettingsFile,
    SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES,
    SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
} from '@contracts/scanCleanupSettings';

const pageOverride = {
    rotationDegrees: 0,
    layoutOverride: 'auto',
    excluded: false,
    manualSplit: null,
};

function sourceHash(index: number) {
    return index.toString(16).padStart(64, '0');
}

function pageOverrides(count: number) {
    return Object.fromEntries(Array.from({length: count}, (_, index) => [
        String(index + 1),
        pageOverride,
    ]));
}

describe('scan-cleanup settings file decoder', () => {
    it('defaults new preferences to ink placement', () => {
        expect(createDefaultScanCleanupSettingsFile().settings.pageAlignment).toBe('ink');
        expect(decodeScanCleanupGlobalPreferences({}).pageAlignment).toBe('ink');
        expect(decodeScanCleanupGlobalPreferences({pageAlignment: 'top-center'}).pageAlignment)
            .toBe('top-center');
    });

    it('migrates persisted thickness to the executable integer range', () => {
        expect(decodeScanCleanupGlobalPreferences({thickness: 0.5}).thickness).toBe(0);
        expect(decodeScanCleanupGlobalPreferences({thickness: -0.5}).thickness).toBe(-0);
        expect(decodeScanCleanupGlobalPreferences({thickness: 8.5}).thickness).toBe(5);
        expect(decodeScanCleanupGlobalPreferences({thickness: -8.5}).thickness).toBe(-5);
    });

    it('migrates the pre-ink schema: its un-chosen top-center becomes ink, explicit choices survive', () => {
        const base = createDefaultScanCleanupSettingsFile();
        const preInk = (pageAlignment: string) => ({
            ...base,
            schemaVersion: 1,
            settings: {
                ...base.settings,
                pageAlignment,
            },
        });
        expect(decodeScanCleanupSettingsFile(preInk('top-center'))).toMatchObject({
            schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
            settings: {pageAlignment: 'ink'},
        });
        expect(decodeScanCleanupSettingsFile(preInk('bottom-right')).settings.pageAlignment)
            .toBe('bottom-right');
        // Schema 2 already knows `ink`, so a stored top-center is a real choice.
        expect(decodeScanCleanupSettingsFile({
            ...preInk('top-center'),
            schemaVersion: SCAN_CLEANUP_SETTINGS_SCHEMA_VERSION,
        }).settings.pageAlignment).toBe('top-center');
        expect(() => decodeScanCleanupSettingsFile({
            ...base,
            schemaVersion: 0,
        })).toThrow('Unsupported scan-cleanup settings schema version: 0');
    });

    it('drops one corrupt document entry while preserving valid siblings', () => {
        const validOverrides = {'1': pageOverride};
        const firstValidHash = 'a'.repeat(64);
        const corruptHash = 'b'.repeat(64);
        const secondValidHash = 'c'.repeat(64);

        const decoded = decodeScanCleanupSettingsFile({
            ...createDefaultScanCleanupSettingsFile(),
            documentOverrides: {
                [firstValidHash]: {
                    overrides: validOverrides,
                    lastUsedAtMs: 10,
                },
                [corruptHash]: {
                    overrides: {'01': pageOverride},
                    lastUsedAtMs: 20,
                },
                [secondValidHash]: {
                    outputMode: 'grayscale',
                    lastUsedAtMs: 30,
                },
            },
        });

        expect(decoded.documentOverrides).toEqual({
            [firstValidHash]: {
                overrides: validOverrides,
                lastUsedAtMs: 10,
            },
            [secondValidHash]: {
                outputMode: 'grayscale',
                lastUsedAtMs: 30,
            },
        });
    });

    it('gives every legal document entry its own page budget', () => {
        const pagesPerDocument = Math.floor(
            SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES / SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES,
        ) + 1;
        const overrides = pageOverrides(pagesPerDocument);
        const documentOverrides = Object.fromEntries(Array.from(
            {length: SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES},
            (_, index) => [
                sourceHash(index),
                {
                    overrides,
                    lastUsedAtMs: index,
                },
            ],
        ));

        const decoded = decodeScanCleanupSettingsFile({
            ...createDefaultScanCleanupSettingsFile(),
            documentOverrides,
        });

        expect(Object.keys(decoded.documentOverrides))
            .toHaveLength(SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES);
        expect(Object.keys(decoded.documentOverrides[sourceHash(0)]!.overrides!))
            .toHaveLength(pagesPerDocument);
        expect(Object.keys(decoded.documentOverrides[
            sourceHash(SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES - 1)
        ]!.overrides!)).toHaveLength(pagesPerDocument);
    });
});
