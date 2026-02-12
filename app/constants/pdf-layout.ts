export const SIDEBAR = {
    DEFAULT_WIDTH: 272,
    MIN_WIDTH: 220,
    COLLAPSE_WIDTH: 160,
    MAX_WIDTH: 520,
    RESIZER_WIDTH: 8,
};

export const ZOOM = {
    STEP: 0.25,
    MIN: 0.25,
    MAX: 5,
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
};

export const CONCURRENT_RENDERS = 3;

export const THUMBNAIL_WIDTH = 150;
