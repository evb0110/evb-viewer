import {readFileSync} from 'node:fs';
import path from 'node:path';
import stylelint from 'stylelint';

const CUSTOM_PROPERTY_RULE = 'evb/known-custom-properties';
const IMPORTANT_POLICY_RULE = 'evb/important-policy';
const STYLE_ASSET_RULE = 'evb/style-asset-conventions';
const IMPORTANT_ALLOWANCE_WINDOW_LINES = 8;
const STYLE_ASSET_FILE_PATTERN = /^_?[a-z0-9]+(?:-[a-z0-9]+)*\.(?:css|scss)$/u;
const CUSTOM_PROPERTY_DECLARATION_PATTERN = /(?:^|[^A-Za-z0-9_-])['"]?(--[A-Za-z0-9_-]+)['"]?\s*:/gu;
const VALIDATED_CUSTOM_PROPERTY_PATTERN = /^(?:--app-|--ui-|--radius-|--toolbar-control-height$)/u;
const KNOWN_EXTERNAL_UI_TOKENS = new Set(
    `
--ui-bg
--ui-bg-accented
--ui-bg-elevated
--ui-bg-inverted
--ui-bg-muted
--ui-border
--ui-border-hover
--ui-color-neutral-50
--ui-color-neutral-100
--ui-color-neutral-200
--ui-color-neutral-300
--ui-color-neutral-400
--ui-color-neutral-500
--ui-color-neutral-600
--ui-color-neutral-700
--ui-color-neutral-800
--ui-color-neutral-900
--ui-color-neutral-950
--ui-color-primary-400
--ui-color-primary-700
--ui-error
--ui-error-50
--ui-error-400
--ui-error-600
--ui-primary
--ui-primary-fg
--ui-radius
--ui-shadow-lg
--ui-success
--ui-text
--ui-text-dimmed
--ui-text-highlighted
--ui-text-muted
--ui-text-toned
--ui-warning
`
        .trim()
        .split('\n'),
);

function collectDeclaredCustomProperties(source) {
    return new Set(Array.from(source.matchAll(CUSTOM_PROPERTY_DECLARATION_PATTERN), (match) => match[1]).filter(Boolean));
}

const CANONICAL_APP_TOKENS = collectDeclaredCustomProperties(readFileSync(new URL('./app/assets/css/main.css', import.meta.url), 'utf8'));

function collectVarReferences(value) {
    const references = [];
    for (let index = 0; index < value.length; index += 1) {
        if (!value.startsWith('var(', index)) {
            continue;
        }

        let depth = 0;
        let end = -1;
        for (let cursor = index; cursor < value.length; cursor += 1) {
            if (value[cursor] === '(') {
                depth += 1;
            } else if (value[cursor] === ')' && --depth === 0) {
                end = cursor;
                break;
            }
        }
        if (end === -1) {
            continue;
        }

        const body = value.slice(index + 4, end);
        const name = body.match(/^\s*(--[A-Za-z0-9_-]+)/u)?.[1];
        let nestedDepth = 0;
        const hasFallback = Array.from(body).some((character) => {
            if (character === '(') {
                nestedDepth += 1;
            } else if (character === ')') {
                nestedDepth -= 1;
            }
            return character === ',' && nestedDepth === 0;
        });
        if (name) {
            references.push({
                hasFallback,
                name,
            });
        }
    }
    return references;
}

const knownCustomPropertiesRule = () => (root, result) => {
    const localTokens = new Set();
    root.walkDecls(/^--/u, (declaration) => localTokens.add(declaration.prop));
    root.walkDecls((declaration) => {
        for (const reference of collectVarReferences(declaration.value)) {
            if (
                !VALIDATED_CUSTOM_PROPERTY_PATTERN.test(reference.name) ||
                reference.hasFallback ||
                CANONICAL_APP_TOKENS.has(reference.name) ||
                localTokens.has(reference.name) ||
                KNOWN_EXTERNAL_UI_TOKENS.has(reference.name)
            ) {
                continue;
            }
            stylelint.utils.report({
                message: `${reference.name} is not a known app/UI token, local declaration, or var() with fallback.`,
                node: declaration,
                result,
                ruleName: CUSTOM_PROPERTY_RULE,
            });
        }
    });
};
knownCustomPropertiesRule.ruleName = CUSTOM_PROPERTY_RULE;

const importantPolicyRule = () => (root, result) => {
    const allowanceLines = [];
    root.walkComments((comment) => {
        if (comment.text.includes('css-important-allow:') && comment.source?.start?.line) {
            allowanceLines.push(comment.source.start.line);
        }
    });
    root.walkDecls((declaration) => {
        if (!declaration.important) {
            return;
        }

        const line = declaration.source?.start?.line ?? 1;
        const allowed = allowanceLines.some(
            (allowanceLine) => allowanceLine <= line && allowanceLine >= line - IMPORTANT_ALLOWANCE_WINDOW_LINES,
        );
        if (!allowed) {
            stylelint.utils.report({
                message: 'Unexpected !important declaration; use normal cascade or add a css-important-allow rationale.',
                node: declaration,
                result,
                ruleName: IMPORTANT_POLICY_RULE,
            });
        }
    });
};
importantPolicyRule.ruleName = IMPORTANT_POLICY_RULE;

const styleAssetConventionsRule = () => (root, result) => {
    const absolutePath = root.source?.input?.file;
    if (!absolutePath) {
        return;
    }

    const repoPath = path.relative(process.cwd(), absolutePath).split(path.sep).join('/');
    const assetRoot = repoPath.startsWith('app/assets/css/')
        ? 'app/assets/css/'
        : repoPath.startsWith('landing/app/assets/css/')
          ? 'landing/app/assets/css/'
          : null;
    if (!assetRoot || repoPath.startsWith('app/assets/css/vendor/')) {
        return;
    }

    const relativePath = repoPath.slice(assetRoot.length);
    const fileName = path.posix.basename(relativePath);
    const messages = [];
    if (!STYLE_ASSET_FILE_PATTERN.test(fileName)) {
        messages.push('Style asset filenames must be lower kebab-case with an optional Sass partial underscore.');
    }
    if (fileName.endsWith('.css') && relativePath !== 'main.css') {
        messages.push('App-owned asset styles should use .scss; keep .css for main.css and vendor/generated CSS.');
    }

    for (const message of messages) {
        stylelint.utils.report({
            message,
            node: root,
            result,
            ruleName: STYLE_ASSET_RULE,
        });
    }
};
styleAssetConventionsRule.ruleName = STYLE_ASSET_RULE;

export const stylelintCustomPlugins = [
    stylelint.createPlugin(CUSTOM_PROPERTY_RULE, knownCustomPropertiesRule),
    stylelint.createPlugin(IMPORTANT_POLICY_RULE, importantPolicyRule),
    stylelint.createPlugin(STYLE_ASSET_RULE, styleAssetConventionsRule),
];

const RAW_DIMENSION_VALUE_PATTERN = /^-?(?!0(?:\.0+)?(?:\D|$))\d*\.?\d+(?:px|rem|em)\b/u;
const RAW_LAYOUT_VALUE_RULES = {
    '/^(?:width|height|min-width|max-width|min-height|max-height|inline-size|block-size|min-inline-size|max-inline-size|min-block-size|max-block-size|padding(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|margin(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap|top|right|bottom|left|inset(?:-(?:inline|block)(?:-(?:start|end))?)?|border-radius)$/':
        [RAW_DIMENSION_VALUE_PATTERN],
    'font-size': [/^\d*\.?\d+(?:px|rem|em)\b/u],
    'z-index': [/^-?\d+\b/u],
};

export default {
    extends: ['stylelint-config-standard-scss', 'stylelint-config-recommended-vue/scss'],
    plugins: stylelintCustomPlugins,
    ignoreFiles: ['app/assets/css/vendor/**/*.css'],
    rules: {
        [CUSTOM_PROPERTY_RULE]: true,
        [IMPORTANT_POLICY_RULE]: true,
        [STYLE_ASSET_RULE]: true,
        'declaration-property-value-disallowed-list': RAW_LAYOUT_VALUE_RULES,
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
    overrides: [
        {
            files: ['landing/app/**/*.{css,scss,vue}'],
            rules: {
                [CUSTOM_PROPERTY_RULE]: null,
                'declaration-property-value-disallowed-list': null,
            },
        },
        {
            files: ['app/assets/css/main.css'],
            rules: {
                'declaration-property-value-disallowed-list': null,
            },
        },
        {
            // Both entry stylesheets are hand-written Tailwind 4 token sheets
            // (`@theme`, `#__nuxt`), so they share one exception list.
            files: ['app/assets/css/**/*.{css,scss}', 'landing/app/assets/css/**/*.{css,scss}'],
            rules: {
                'scss/at-rule-no-unknown': null,
                'hue-degree-notation': null,
                'custom-property-empty-line-before': null,
                'color-hex-length': null,
                'value-keyword-case': null,
                'selector-id-pattern': null,
                'property-no-vendor-prefix': null,
                'declaration-empty-line-before': null,
                'custom-property-pattern': null,
                'rule-empty-line-before': null,
                'no-duplicate-selectors': null,
                'no-descending-specificity': null,
            },
        },
        {
            files: ['app/assets/css/pdfjs-overrides.scss'],
            rules: {
                [IMPORTANT_POLICY_RULE]: null,
            },
        },
        {
            files: ['**/*.css'],
            rules: {
                'media-query-no-invalid': true,
                'declaration-property-value-no-unknown': true,
            },
        },
    ],
};
