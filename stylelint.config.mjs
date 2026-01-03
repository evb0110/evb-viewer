export default {
    extends: [
        'stylelint-config-standard-scss',
        'stylelint-config-recommended-vue/scss',
    ],
    rules: {
        // Disallow nested BEM modifiers (&--modifier)
        // Forces flat declarations: .block--modifier instead of .block { &--modifier }
        'selector-nested-pattern': '^(?!&--)',

        // Allow BEM naming: block__element--modifier
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
