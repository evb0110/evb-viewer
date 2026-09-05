

const MANAGED_SHAPE_STABLE_KEY_PREFIX = 'evb-shape:';

export function normalizeManagedShapeStableKey(stableKey: string | null | undefined) {
    const trimmed = stableKey?.trim();
    if (!trimmed || !trimmed.startsWith(MANAGED_SHAPE_STABLE_KEY_PREFIX)) {
        return null;
    }
    return trimmed;
}
