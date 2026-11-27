import {clamp} from 'es-toolkit/math';

export function clamp01(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return clamp(value, 0, 1);
}
