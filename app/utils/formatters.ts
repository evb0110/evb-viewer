export function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return '-';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = [
        'KB',
        'MB',
        'GB',
        'TB',
    ];
    let value = bytes;
    let unitIndex = -1;

    do {
        value /= 1024;
        unitIndex += 1;
    } while (value >= 1024 && unitIndex < units.length - 1);

    const digits = value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
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

export function formatRelativeTime(timestamp: number, labels: IRelativeTimeLabels) {
    const now = Date.now();
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
