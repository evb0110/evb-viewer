import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_LOCALE,
    isSupportedLocale,
    LOCALE_CODES,
    resolveLocale,
} from '@i18n-core';
import { LOCALE_DEFINITIONS } from '@i18n-core/localeDefinitions';
import { LOCALE_MESSAGES } from '@i18n-app/locales';

function listLocaleFiles(relativeDirectory: string) {
    return readdirSync(path.join(process.cwd(), relativeDirectory))
        .filter(fileName => fileName.endsWith('.ts') && fileName !== 'index.ts')
        .sort();
}

describe('locale registry', () => {
    it('keeps locale codes, definitions, and app messages synchronized', () => {
        const codes = [...LOCALE_CODES];
        const definitionCodes = LOCALE_DEFINITIONS.map(definition => definition.code);
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

    it('keeps runtime locale stubs aligned with package message files', () => {
        const definitionFiles = LOCALE_DEFINITIONS
            .map(definition => definition.file)
            .toSorted();

        expect(listLocaleFiles('packages/i18n-app/messages')).toEqual(definitionFiles);
        expect(listLocaleFiles('app/i18n/runtime-locales')).toEqual(definitionFiles);
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
