export const SIDEBAR = {
    DEFAULT_WIDTH: 272,
    MIN_WIDTH: 220,
    MAX_WIDTH: 520,
    RESIZER_WIDTH: 8,
    MIN_VIEWER_WIDTH: 320,
};

export const ZOOM = {
    STEP: 0.25,
    MIN: 0.25,
    FIT_MIN: 0.1,
    MAX: 10,
    PRESETS: [
        {
            value: 0.5,
            label: '50%',
        },
        {
            value: 0.75,
            label: '75%',
        },
        {
            value: 1,
            label: '100%',
        },
        {
            value: 1.25,
            label: '125%',
        },
        {
            value: 1.5,
            label: '150%',
        },
        {
            value: 2,
            label: '200%',
        },
        {
            value: 3,
            label: '300%',
        },
    ],
} as const;

export const NOTE_WINDOW = {
    MARGIN: 8,
    MIN_WIDTH: 260,
    MIN_HEIGHT: 240,
    DEFAULT_WIDTH: 380,
    DEFAULT_HEIGHT: 360,
    DEFAULT_Z_INDEX: 55,
    ACTIVE_Z_INDEX_BASE: 90,
    ACTIVE_Z_INDEX_SLOTS: 8,
    ANCHOR_Z_INDEX_BASE: 25,
    ANCHOR_Z_INDEX_SLOTS: 8,
    MARKER_DRAG_TOOLTIP_RELEASE_MS: 80,
};

export function resolveNoteWindowAnchorZIndex(order: number) {
    const normalizedOrder = Number.isFinite(order) ? Math.max(0, Math.trunc(order)) : 0;
    return NOTE_WINDOW.ANCHOR_Z_INDEX_BASE + Math.min(
        normalizedOrder,
        NOTE_WINDOW.ANCHOR_Z_INDEX_SLOTS - 1,
    );
}
