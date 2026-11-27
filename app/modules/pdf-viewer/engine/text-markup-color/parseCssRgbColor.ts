import {clampRgbChannel} from '@app/modules/pdf-viewer/engine/text-markup-color/clampRgbChannel';
import type {IRgbColor} from '@app/modules/pdf-viewer/engine/text-markup-color/rgbColor';

export function parseCssRgbColor(value: string | null | undefined): IRgbColor | null {
    if (!value) {
        return null;
    }

    const trimmed = value.trim();
    const hexMatch = /^#(?<hex>[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
    const hex = hexMatch?.groups?.hex;
    if (hex) {
        const expanded =
            hex.length === 3
                ? hex
                      .split('')
                      .map((channel) => channel + channel)
                      .join('')
                : hex;
        return {
            r: Number.parseInt(expanded.slice(0, 2), 16),
            g: Number.parseInt(expanded.slice(2, 4), 16),
            b: Number.parseInt(expanded.slice(4, 6), 16),
        };
    }

    const rgbMatch = /^rgba?\((?<channels>.+)\)$/i.exec(trimmed);
    const rawChannels = rgbMatch?.groups?.channels;
    if (!rawChannels) {
        return null;
    }

    const channels = rawChannels
        .match(/-?\d*\.?\d+%?/g)
        ?.slice(0, 3)
        .map((channel) => {
            const isPercent = channel.endsWith('%');
            const parsed = Number.parseFloat(isPercent ? channel.slice(0, -1) : channel);
            return Number.isFinite(parsed) ? clampRgbChannel(isPercent ? (parsed / 100) * 255 : parsed) : Number.NaN;
        });
    if (!channels || channels.length < 3 || channels.some((channel) => !Number.isFinite(channel))) {
        return null;
    }

    const [red, green, blue] = channels;
    if (red === undefined || green === undefined || blue === undefined) {
        return null;
    }
    return {
        r: red,
        g: green,
        b: blue,
    };
}
