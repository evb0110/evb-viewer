import type {TTranslateFn} from '@i18n-app';
import type {IScanCleanupScratchShortfall} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {formatBytes} from '@app/utils/formatters';

/**
 * The one storage refusal a user can act on, stated entirely in their language.
 *
 * Detection analyses a document through a bounded window, so length alone never
 * refuses a run; this message appears when the run's bounded raster and merge
 * working set cannot fit the scratch budget. The main process sends the two
 * figures as numbers, which is what lets the sentence say how much space to
 * free without quoting an English exception. When the filesystem could not
 * report free space, the headline stands alone rather than inventing a number.
 */
export function formatScanCleanupScratchMessage(
    t: TTranslateFn,
    shortfall: IScanCleanupScratchShortfall | undefined,
) {
    const headline = t('scanCleanup.errors.insufficientScratch');
    if (
        shortfall === undefined
        || shortfall.requiredBytes === null
        || shortfall.availableBytes === null
    ) {
        return headline;
    }
    return `${headline} ${t('scanCleanup.errors.insufficientScratchSpace', {
        required: formatBytes(shortfall.requiredBytes),
        available: formatBytes(shortfall.availableBytes),
    })}`;
}
