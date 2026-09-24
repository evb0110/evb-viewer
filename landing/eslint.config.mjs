import withNuxt from './.nuxt/eslint.config.mjs';
import stylistic from '@stylistic/eslint-plugin';
import {
    arrayTypeRules,
    namingRules,
    strictTypeRules,
    stylisticRules,
} from '../eslint.shared.mjs';

export default withNuxt(
    { ignores: [
        '.nuxt/**',
        '.output/**',
        'dist/**',
        'node_modules/**',
    ] },
    {
        plugins: { '@stylistic': stylistic },
        rules: {
            ...stylisticRules,
            'vue/html-self-closing': 'off',
        },
    },
    {
        files: ['**/*.ts'],
        ignores: [
            '*.config.ts',
            'nuxt.config.ts',
            '**/*.d.ts',
        ],
        languageOptions: { parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        } },
        rules: {
            ...strictTypeRules,
            ...arrayTypeRules,
            ...namingRules,
            '@typescript-eslint/no-empty-object-type': [
                'error',
                { allowInterfaces: 'with-single-extends' },
            ],
            '@typescript-eslint/require-await': 'error',
            'no-return-await': 'off',
        },
    },
    {
        files: ['**/*.vue'],
        languageOptions: { parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        } },
        rules: {
            ...strictTypeRules,
            ...arrayTypeRules,
            ...namingRules,
            '@typescript-eslint/no-empty-object-type': [
                'error',
                { allowInterfaces: 'with-single-extends' },
            ],
            '@typescript-eslint/require-await': 'error',
            'no-return-await': 'off',
            'vue/no-restricted-syntax': [
                'error',
                {
                    selector:
                        'VExpressionContainer > * Identifier[name="$props"]',
                    message:
                        'Use destructured props from defineProps() instead of $props',
                },
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'Identifier[name="$props"]',
                    message:
                        'Use destructured props from defineProps() instead of $props',
                },
                {
                    selector: 'Identifier[name="withDefaults"]',
                    message:
                        'use props destructuring. beware that withDefaults is not compatible with destructured props. Use default values in destructuring pattern directly, vue 3.5 supports them',
                },
                {
                    selector: 'TSAsExpression[expression.type="TSAsExpression"][expression.typeAnnotation.type="TSUnknownKeyword"]',
                    message: 'Avoid "as unknown as" double assertion. Use a type guard, generic parameter, or fix the underlying type instead.',
                },
            ],
            '@typescript-eslint/no-restricted-imports': [
                'error',
                { paths: [{
                    name: 'vue',
                    message: 'Vue APIs are auto-imported by Nuxt. Use them directly without importing. Type imports (import type) are still allowed.',
                    allowTypeImports: true,
                }] },
            ],
        },
    },
    {
        files: ['app/pages/**/*.vue'],
        rules: {'vue/multi-word-component-names': 'off'},
    },
    {
        files: ['app/types/i18nComposer.ts'],
        rules: {'@typescript-eslint/naming-convention': 'off'},
    },
);
