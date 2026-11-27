export type TQuarterTurn = 0 | 90 | 180 | 270;

function normalizeQuarterTurn(value: number): TQuarterTurn {
    const normalized = ((Math.trunc(value) % 360) + 360) % 360;
    if (normalized === 90 || normalized === 180 || normalized === 270) {
        return normalized;
    }
    return 0;
}

export function resolveClockwiseRotationDelta(currentRotation: number, targetRotation: number): TQuarterTurn {
    return normalizeQuarterTurn(normalizeQuarterTurn(targetRotation) - normalizeQuarterTurn(currentRotation));
}
