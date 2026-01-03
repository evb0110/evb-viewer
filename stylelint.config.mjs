export default {
    extends: [
        'stylelint-config-standard-scss',
        'stylelint-config-recommended-vue/scss',
    ],
    rules: {
        // Disallow SCSS parent selector concatenation (&- and &_)
        // Vue scoped styles eliminate the need for BEM - use flat class names
        'selector-nested-pattern': '^(?!&[-_])',

        // Allow any class naming pattern
        'selector-class-pattern': null,

        // Allow SCSS partials with leading underscore
        'scss/load-no-partial-leading-underscore': null,

        // Don't enforce modern color notation (rgba -> rgb)
        'color-function-notation': null,
        'color-function-alias-notation': null,
        'alpha-value-notation': null,

        // Don't enforce precision limits
        'number-max-precision': null,
    },
};
