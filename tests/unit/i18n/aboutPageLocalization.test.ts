import {describe, expect, it} from 'vitest';
import {LOCALE_CODES} from '@i18n-core/localeCodes';
import {LOCALE_MESSAGES} from '@i18n-app';

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected an About message object');
    }

    return value as Record<string, unknown>;
}

function flattenLeafPaths(tree: unknown, prefix = ''): string[] {
    return Object.entries(asRecord(tree)).flatMap(([key, value]) => {
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

describe('About and Acknowledgements localization', () => {
    it('keeps exact About key parity across all nine app locales', () => {
        const expectedPaths = flattenLeafPaths(LOCALE_MESSAGES.en.about).sort();

        expect(Object.keys(LOCALE_MESSAGES).sort()).toEqual([...LOCALE_CODES].sort());
        for (const locale of LOCALE_CODES) {
            const messages = LOCALE_MESSAGES[locale];

            expect(flattenLeafPaths(messages.about).sort(), locale).toEqual(expectedPaths);
            for (const path of expectedPaths) {
                const value = getLeaf(messages.about, path);
                expect(typeof value === 'string' && value.trim().length > 0, `${locale}:about.${path}`).toBe(true);
            }
            expect(messages.menu.acknowledgements.trim().length, locale).toBeGreaterThan(0);
            expect(messages.settings.aboutTitle.trim().length, locale).toBeGreaterThan(0);
            expect(messages.settings.aboutDescription.trim().length, locale).toBeGreaterThan(0);
            expect(messages.settings.openAbout.trim().length, locale).toBeGreaterThan(0);
        }
    });

    it('provides translated acknowledgement copy outside English', () => {
        for (const locale of LOCALE_CODES) {
            if (locale === 'en') {
                continue;
            }

            expect(LOCALE_MESSAGES[locale].about.sentryAcknowledgement.message, locale).not.toBe(
                LOCALE_MESSAGES.en.about.sentryAcknowledgement.message,
            );
            expect(LOCALE_MESSAGES[locale].menu.acknowledgements, locale).not.toBe(LOCALE_MESSAGES.en.menu.acknowledgements);
        }
    });
});
