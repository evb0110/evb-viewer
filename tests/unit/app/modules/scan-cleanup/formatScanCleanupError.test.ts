import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    formatScanCleanupErrorByCode,
    formatScanCleanupErrorMessage,
} from '@app/modules/scan-cleanup/runtime/formatScanCleanupErrorMessage';
import {formatScanCleanupScratchMessage} from '@app/modules/scan-cleanup/composables/useScanCleanupDetectionSession';
import {LOCALE_MESSAGES} from '@i18n-app/locales';

describe('formatScanCleanupErrorMessage', () => {
    it('keeps the localized fallback as the main message and appends raw detail', () => {
        expect(formatScanCleanupErrorMessage(
            'scanCleanup.failed',
            new Error('native bridge failed'),
        )).toBe('scanCleanup.failed (native bridge failed)');
    });

    it('does not duplicate an already-localized detail', () => {
        expect(formatScanCleanupErrorMessage('Page detection failed.', 'Page detection failed.'))
            .toBe('Page detection failed.');
    });

    it('bounds opaque technical detail', () => {
        const detail = 'x'.repeat(300);
        expect(formatScanCleanupErrorMessage('scanCleanup.failed', detail))
            .toBe(`scanCleanup.failed (${`${'x'.repeat(237)}...`})`);
    });
});

describe('formatScanCleanupErrorByCode', () => {
    const translate = ((key: string) => key) as never;

    it('selects a distinct localized sentence for each native cause family', () => {
        expect(formatScanCleanupErrorByCode(translate, 'encrypted', 'native encrypted detail'))
            .toBe('scanCleanup.errors.encrypted (native encrypted detail)');
        expect(formatScanCleanupErrorByCode(translate, 'needs-password', 'native password detail'))
            .toBe('scanCleanup.errors.needsPassword (native password detail)');
    });

    it('uses the typed scratch figures instead of the native exception text', () => {
        expect(formatScanCleanupErrorByCode(
            translate,
            'insufficient-scratch',
            'English native scratch exception',
            {
                availableBytes: null,
                requiredBytes: null,
            },
        )).toBe('scanCleanup.errors.insufficientScratch');
    });
});

describe('formatScanCleanupScratchMessage', () => {
    const en = LOCALE_MESSAGES.en;
    const translate = (messages: object) => ((key: string, params?: Record<string, string>) => {
        const leaf = key.split('.').reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)[part],
            messages,
        ) as string;
        return Object.entries(params ?? {}).reduce(
            (text, [
                name,
                value,
            ]) => text.replaceAll(`{${name}}`, value),
            leaf,
        );
    }) as never;

    it('states both figures without any raw technical detail', () => {
        const message = formatScanCleanupScratchMessage(translate(LOCALE_MESSAGES.ru), {
            availableBytes: 520 * 1024 * 1024,
            requiredBytes: 1_100 * 1024 * 1024,
        });

        expect(message).toBe(
            'На временном диске недостаточно свободного места для анализа этого документа.'
            + ' Освободите место на диске и повторите попытку: требуется 1.07 GB, свободно 520.0 MB.',
        );
        // Nothing English, and nothing from an exception, reaches the alert.
        expect(message).not.toMatch(/[A-Za-z]{4}/u);
    });

    it('states the headline alone when the filesystem reported no free space figure', () => {
        expect(formatScanCleanupScratchMessage(translate(en), {
            availableBytes: null,
            requiredBytes: 1_024,
        })).toBe(en.scanCleanup.errors.insufficientScratch);
        expect(formatScanCleanupScratchMessage(translate(en), undefined))
            .toBe(en.scanCleanup.errors.insufficientScratch);
    });
});
