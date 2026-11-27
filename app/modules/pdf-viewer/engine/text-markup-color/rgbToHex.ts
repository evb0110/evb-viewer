import {clampRgbChannel} from '@app/modules/pdf-viewer/engine/text-markup-color/clampRgbChannel';
import type {IRgbColor} from '@app/modules/pdf-viewer/engine/text-markup-color/rgbColor';

export function rgbToHex(color: IRgbColor) {
    return `#${[color.r, color.g, color.b].map((channel) => clampRgbChannel(channel).toString(16).padStart(2, '0')).join('')}`;
}
