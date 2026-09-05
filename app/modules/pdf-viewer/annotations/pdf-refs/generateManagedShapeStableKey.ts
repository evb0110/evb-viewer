

const MANAGED_SHAPE_STABLE_KEY_PREFIX = 'evb-shape:';

export function generateManagedShapeStableKey() {
    return `${MANAGED_SHAPE_STABLE_KEY_PREFIX}${crypto.randomUUID()}`;
}
