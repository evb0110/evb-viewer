import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_SETTINGS,
    migrateSettings,
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from '@contracts/settings';

describe('settings-sanitizer', () => {
    it('returns defaults when settings payload is missing', () => {
        expect(sanitizeSettings(undefined)).toEqual({
            ...DEFAULT_SETTINGS,
            skippedUpdateVersion: undefined,
            suppressDefaultViewerPrompt: undefined,
        });
    });

    it('preserves valid locale and dark theme', () => {
        expect(sanitizeSettings({
            version: 3,
            authorName: 'Alice',
            theme: 'dark',
            locale: 'fr',
        })).toEqual({
            ...DEFAULT_SETTINGS,
            version: 3,
            authorName: 'Alice',
            theme: 'dark',
            locale: 'fr',
            skippedUpdateVersion: undefined,
            suppressDefaultViewerPrompt: undefined,
        });
    });

    it('requires a finite settings version', () => {
        expect(sanitizeSettings({version: Number.POSITIVE_INFINITY}).version).toBe(DEFAULT_SETTINGS.version);
        expect(sanitizeSettings({version: Number.NaN}).version).toBe(DEFAULT_SETTINGS.version);
        expect(sanitizeSettings({version: -1.5}).version).toBe(-1.5);
    });

    it('migrates version one settings and preserves unknown storage fields', () => {
        expect(migrateSettings({
            version: 1,
            authorName: 'Alice',
            futureSetting: {enabled: true},
        })).toMatchObject({
            version: DEFAULT_SETTINGS.version,
            authorName: 'Alice',
            futureSetting: {enabled: true},
        });
    });

    it('normalizes invalid locale/theme and trims skipped update version', () => {
        expect(sanitizeSettings({
            version: 1,
            authorName: 'Bob',
            theme: 'midnight' as 'light',
            locale: 'xx' as 'en',
            skippedUpdateVersion: '  1.2.3  ',
            suppressDefaultViewerPrompt: true,
        })).toEqual({
            ...DEFAULT_SETTINGS,
            version: 1,
            authorName: 'Bob',
            theme: 'light',
            locale: 'en',
            skippedUpdateVersion: '1.2.3',
            suppressDefaultViewerPrompt: true,
        });
    });

    it('normalizes tab memory policy', () => {
        expect(sanitizeSettings({tabMemoryPolicy: 'aggressive'}).tabMemoryPolicy).toBe('aggressive');
        expect(sanitizeSettings({tabMemoryPolicy: 'unsupported' as never}).tabMemoryPolicy).toBe(DEFAULT_SETTINGS.tabMemoryPolicy);
    });

    it('defaults performance mode to auto', () => {
        expect(sanitizeSettings(undefined).performanceMode).toBe('auto');
        expect(DEFAULT_SETTINGS.performanceMode).toBe('auto');
    });

    it('normalizes every valid performance mode', () => {
        for (const mode of [
            'auto',
            'low',
            'medium',
            'high',
        ] as const) {
            expect(sanitizeSettings({performanceMode: mode}).performanceMode).toBe(mode);
        }
    });

    it('falls back to auto for an invalid performance mode', () => {
        expect(sanitizeSettings({performanceMode: 'turbo' as never}).performanceMode).toBe('auto');
        expect(sanitizeSettings({performanceMode: 42 as never}).performanceMode).toBe('auto');
    });

    it('discards resolved tier fields that are not part of the settings shape', () => {
        const sanitized = sanitizeSettings({
            performanceMode: 'low',
            tier: 'high',
            detectedTier: 'high',
            resolvedTier: 'high',
        } as never);
        expect(sanitized.performanceMode).toBe('low');
        expect(sanitized).not.toHaveProperty('tier');
        expect(sanitized).not.toHaveProperty('detectedTier');
        expect(sanitized).not.toHaveProperty('resolvedTier');
    });

    it('normalizes Save As PDF optimization setting', () => {
        expect(sanitizeSettings({optimizePdfOnSaveAs: true}).optimizePdfOnSaveAs).toBe(true);
        expect(sanitizeSettings({optimizePdfOnSaveAs: 'yes'}).optimizePdfOnSaveAs).toBe(false);
    });

    it('normalizes agent MCP setting', () => {
        expect(sanitizeSettings({agentMcpEnabled: true}).agentMcpEnabled).toBe(true);
        expect(sanitizeSettings({agentMcpEnabled: 'yes'}).agentMcpEnabled).toBe(false);
    });

    it('normalizes assistant panel setting', () => {
        expect(sanitizeSettings({assistantPanelEnabled: true}).assistantPanelEnabled).toBe(true);
        expect(sanitizeSettings({assistantPanelEnabled: 'no'}).assistantPanelEnabled).toBe(false);
    });

    it('normalizes the optional client diagnostics preference to unknown', () => {
        expect(DEFAULT_SETTINGS.clientDiagnosticsPreference).toBe('unknown');
        expect(sanitizeSettings({}).clientDiagnosticsPreference).toBe('unknown');
        expect(sanitizeSettings({clientDiagnosticsPreference: 'granted'}).clientDiagnosticsPreference).toBe('granted');
        expect(sanitizeSettings({clientDiagnosticsPreference: 'unsupported'}).clientDiagnosticsPreference).toBe('unknown');
        expect(sanitizeSettings({clientDiagnosticsPreference: false}).clientDiagnosticsPreference).toBe('unknown');
    });

    it('trims and clamps unbounded string settings', () => {
        expect(sanitizeSettings({
            authorName: `  ${'A'.repeat(300)}  `,
            skippedUpdateVersion: `  ${'1'.repeat(160)}  `,
        })).toMatchObject({
            authorName: 'A'.repeat(256),
            skippedUpdateVersion: '1'.repeat(128),
        });
    });

    it('exposes locale/theme normalizers for shared callers', () => {
        expect(normalizeTheme('dark')).toBe('dark');
        expect(normalizeTheme('contrast')).toBe('light');
        expect(normalizeLocale('ru')).toBe('ru');
        expect(normalizeLocale('xx')).toBe('en');
    });
});
