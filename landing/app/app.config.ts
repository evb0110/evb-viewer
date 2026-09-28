export default defineAppConfig({ui: {
    colors: {
        primary: 'accent',
        neutral: 'slate',
    },
    // The color mode button's icons ship in the client bundle with the other Phosphor icons.
    icons: {
        light: 'i-ph-sun',
        dark: 'i-ph-moon',
    },
}});
