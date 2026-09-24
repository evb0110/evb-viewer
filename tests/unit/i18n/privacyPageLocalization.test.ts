import {
    describe,
    expect,
    it,
} from 'vitest';
import { LOCALE_CODES } from '@i18n-core/localeCodes';
import { PRIVACY_MESSAGES } from '@i18n-core';


function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected a privacy message object');
    }

    return value as Record<string, unknown>;
}

function flattenLeafPaths(tree: unknown, prefix = ''): string[] {
    return Object.entries(asRecord(tree)).flatMap(([
        key,
        value,
    ]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof value === 'string' ? [path] : flattenLeafPaths(value, path);
    });
}

function getLeaf(tree: unknown, dottedPath: string): unknown {
    return dottedPath.split('.').reduce<unknown>((value, key) => {
        if (typeof value !== 'object' || value === null || !(key in value)) {
            return undefined;
        }

        return (value as Record<string, unknown>)[key];
    }, tree);
}

describe('privacy localization', () => {
    it('keeps one typed privacy tree in exact nine-locale leaf parity', () => {
        const expectedPaths = flattenLeafPaths(PRIVACY_MESSAGES.en).sort();

        expect(Object.keys(PRIVACY_MESSAGES).sort()).toEqual([...LOCALE_CODES].sort());

        for (const locale of LOCALE_CODES) {
            const messages = PRIVACY_MESSAGES[locale];

            expect(flattenLeafPaths(messages).sort(), locale).toEqual(expectedPaths);

            for (const path of expectedPaths) {
                const value = getLeaf(messages, path);

                expect(typeof value === 'string' && value.trim().length > 0, `${locale}:${path}`).toBe(true);
            }
        }
    });

    it('keeps translated privacy copy for every non-English locale', () => {
        for (const locale of LOCALE_CODES) {
            if (locale === 'en') {
                continue;
            }

            const messages = PRIVACY_MESSAGES[locale];

            expect(messages.hero.title, locale).not.toBe(PRIVACY_MESSAGES.en.hero.title);
            expect(messages.documents.body, locale).not.toBe(PRIVACY_MESSAGES.en.documents.body);
            expect(messages.contact.body, locale).not.toBe(PRIVACY_MESSAGES.en.contact.body);
        }
    });

    it('states the public Sentry notice in every locale', () => {
        for (const locale of LOCALE_CODES) {
            const diagnostics = PRIVACY_MESSAGES[locale].diagnostics;
            expect(diagnostics.heading, locale).toMatch(/Sentry/iu);
            expect(diagnostics.body, locale).toMatch(/Sentry/iu);
            expect(diagnostics.body, locale).toMatch(/90/iu);

            expect(PRIVACY_MESSAGES[locale].contact.body, locale).toMatch(/Error ID|Fehler-ID/iu);
            expect(PRIVACY_MESSAGES[locale].contact.body, locale).not.toMatch(
                /github|issue|tracker|seguimiento|suivi|tracciamento|rastreador|трекер/iu,
            );
            expect(diagnostics.body, locale).not.toMatch(
                /issue|tracker|seguimiento|suivi|tracciamento|rastreador|трекер/iu,
            );
        }
    });
});
