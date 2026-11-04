import type {MaybeRefOrGetter} from 'vue';
import type {TTranslateFn} from '@i18n-app';

export interface IByteSizeFormat {
    t: TTranslateFn;
    locale: MaybeRefOrGetter<string>;
}

const BYTE_SIZE_UNITS = [
    'common.unitKilobyte',
    'common.unitMegabyte',
    'common.unitGigabyte',
    'common.unitTerabyte',
] as const;

/** A byte count in the app's language: its units and its decimal separator. */
export function formatBytes(bytes: number, {
    t,
    locale,
}: IByteSizeFormat) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return '-';
    }
    if (bytes < 1024) {
        return `${new Intl.NumberFormat(toValue(locale)).format(bytes)} ${t('common.unitByte')}`;
    }
    let value = bytes;
    let unitIndex = -1;
    do {
        value /= 1024;
        unitIndex += 1;
    } while (value >= 1024 && unitIndex < BYTE_SIZE_UNITS.length - 1);
    const digits = value >= 10 ? 1 : 2;
    const number = new Intl.NumberFormat(toValue(locale), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    }).format(value);
    return `${number} ${t(BYTE_SIZE_UNITS[unitIndex] ?? 'common.unitTerabyte')}`;
}

interface IRelativeTimeLabels {
    yesterday: string;
    daysAgo: (count: number) => string;
    oneHourAgo: string;
    hoursAgo: (count: number) => string;
    oneMinuteAgo: string;
    minutesAgo: (count: number) => string;
    justNow: string;
}

export function formatRelativeTime(
    timestamp: number,
    labels: IRelativeTimeLabels,
    now = Date.now(),
) {
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return days === 1 ? labels.yesterday : labels.daysAgo(days);
    }
    if (hours > 0) {
        return hours === 1 ? labels.oneHourAgo : labels.hoursAgo(hours);
    }
    if (minutes > 0) {
        return minutes === 1 ? labels.oneMinuteAgo : labels.minutesAgo(minutes);
    }
    return labels.justNow;
}
