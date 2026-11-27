import {isPdfDateString, type TPdfDateString} from '@contracts/pdfDateString';

export function toPdfDateString(date: Date = new Date()): TPdfDateString {
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    const timezoneMinutes = -date.getTimezoneOffset();
    const sign = timezoneMinutes >= 0 ? '+' : '-';
    const absOffset = Math.abs(timezoneMinutes);
    const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
    const offsetMinutes = String(absOffset % 60).padStart(2, '0');

    const value = `D:${year}${month}${day}${hours}${minutes}${seconds}${sign}${offsetHours}'${offsetMinutes}'`;
    if (!isPdfDateString(value)) {
        throw new Error(`Formatted PDF date is not a valid PDF date string: ${value}`);
    }
    return value;
}

function toDatePart(value: string | undefined, fallback: number) {
    const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toTimezoneOffsetMinutes(value: string | undefined) {
    if (!value || value.toUpperCase() === 'Z') {
        return value ? 0 : null;
    }

    const match = value.match(/^([+-])(\d{2})'?(\d{2})'?$/u);
    if (!match?.[1] || !match[2] || !match[3]) {
        return null;
    }

    const hours = Number.parseInt(match[2], 10);
    const minutes = Number.parseInt(match[3], 10);
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (hours * 60 + minutes);
}

export function parsePdfDateStringTimestamp(value: string | null | undefined) {
    const normalized = value?.trim();
    if (!normalized) {
        return null;
    }

    const match = normalized.match(/^D:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz]|[+-]\d{2}'?\d{2}'?)?/u);
    if (!match?.[1]) {
        return null;
    }

    const year = toDatePart(match[1], Number.NaN);
    const month = toDatePart(match[2], 1);
    const day = toDatePart(match[3], 1);
    const hours = toDatePart(match[4], 0);
    const minutes = toDatePart(match[5], 0);
    const seconds = toDatePart(match[6], 0);
    if (!Number.isFinite(year)) {
        return null;
    }

    const timezoneOffsetMinutes = toTimezoneOffsetMinutes(match[7]);
    if (timezoneOffsetMinutes === null) {
        return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
    }

    return Date.UTC(year, month - 1, day, hours, minutes, seconds) - timezoneOffsetMinutes * 60_000;
}
