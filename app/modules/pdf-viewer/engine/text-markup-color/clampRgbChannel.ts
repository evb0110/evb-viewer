import {clamp} from 'es-toolkit/math';

export function clampRgbChannel(value: number) {
    return clamp(Math.round(value), 0, 255);
}
