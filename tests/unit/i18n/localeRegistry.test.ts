import {readdirSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {DEFAULT_LOCALE, isSupportedLocale, LOCALE_CODES, resolveLocale} from '@i18n-core';
import {LOCALE_DEFINITIONS} from '@i18n-core/localeDefinitions';
import {LOCALE_MESSAGES} from '@i18n-app/locales';

function listLocaleFiles(relativeDirectory: string) {
    return readdirSync(path.join(process.cwd(), relativeDirectory))
        .filter((fileName) => fileName.endsWith('.ts') && fileName !== 'index.ts')
        .sort();
}

describe('locale registry', () => {
    it('keeps locale codes, definitions, and app messages synchronized', () => {
        const codes = [...LOCALE_CODES];
        const definitionCodes = LOCALE_DEFINITIONS.map((definition) => definition.code);
        const messageCodes = Object.keys(LOCALE_MESSAGES);

        expect(new Set(codes).size).toBe(codes.length);
        expect(definitionCodes).toEqual(codes);
        expect(messageCodes).toEqual(codes);
        expect(codes).toContain(DEFAULT_LOCALE);
        expect(DEFAULT_LOCALE in LOCALE_MESSAGES).toBe(true);

        for (const definition of LOCALE_DEFINITIONS) {
            expect(definition.language).toBe(definition.code);
            expect(definition.file.endsWith('.ts')).toBe(true);
        }
    });

    it('keeps package message files aligned with definitions and uses a single shared runtime loader', () => {
        const definitionFiles = LOCALE_DEFINITIONS.map((definition) => definition.file).toSorted();

        expect(listLocaleFiles('packages/i18n-app/messages')).toEqual(definitionFiles);
        expect(listLocaleFiles('app/i18n/runtime-locales')).toEqual(['loadLocale.ts']);
    });

    it('loads each registered locale dynamically through the shared runtime loader', async () => {
        vi.stubGlobal('defineI18nLocale', <T>(loader: T) => loader);
        try {
            const {default: loadLocale} = (await import('@app/i18n/runtime-locales/loadLocale')) as {
                default: (locale: string) => Promise<Record<string, unknown>>;
            };

            for (const code of LOCALE_CODES) {
                expect(await loadLocale(code), code).toBe(LOCALE_MESSAGES[code]);
            }

            expect(await loadLocale('pt-br')).toBe(LOCALE_MESSAGES['pt-BR']);
            expect(await loadLocale('fr-CA')).toBe(LOCALE_MESSAGES.fr);
            expect(await loadLocale('unknown')).toBe(LOCALE_MESSAGES[DEFAULT_LOCALE]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('resolves regional browser tags before falling back to a base locale', () => {
        expect(isSupportedLocale('pt-BR')).toBe(true);
        expect(isSupportedLocale('fr-CA')).toBe(true);
        expect(isSupportedLocale('unknown')).toBe(false);
        expect(resolveLocale('pt-BR')).toBe('pt-BR');
        expect(resolveLocale('pt-br')).toBe('pt-BR');
        expect(resolveLocale('fr-CA')).toBe('fr');
        expect(resolveLocale('unknown')).toBe(DEFAULT_LOCALE);
    });
});
