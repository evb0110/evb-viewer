import {describe, expect, it} from 'vitest';
import stylelint from 'stylelint';
const stylelintConfigModule = await import(new URL('../../../stylelint.config.mjs', import.meta.url).href);
const stylelintConfig = stylelintConfigModule.default;
const stylelintCustomPlugins = stylelintConfigModule.stylelintCustomPlugins;

describe('Stylelint invariants', () => {
    async function lintStyle(ruleName: string, code: string, codeFilename: string) {
        const result = await stylelint.lint({
            code,
            codeFilename,
            config: {
                plugins: stylelintCustomPlugins,
                rules: {[ruleName]: stylelintConfig.rules[ruleName]},
            },
        });
        return result.results[0]?.warnings ?? [];
    }

    it('rejects unknown guarded custom properties while allowing known, local, and fallback values', async () => {
        await expect(lintStyle(
            'evb/known-custom-properties',
            '.fixture { color: var(--app-space-sm); }',
            'app/components/fixture.css',
        )).resolves.toHaveLength(0);
        await expect(lintStyle(
            'evb/known-custom-properties',
            '.fixture { --app-local: red; color: var(--app-local); background: var(--app-missing, red); }',
            'app/components/fixture.css',
        )).resolves.toHaveLength(0);
        await expect(lintStyle(
            'evb/known-custom-properties',
            '.fixture { color: var(--app-typo); }',
            'app/components/fixture.css',
        )).resolves.toMatchObject([{rule: 'evb/known-custom-properties'}]);
    });

    it('rejects raw layout dimensions, font sizes, and z-indexes through Stylelint', async () => {
        await expect(lintStyle(
            'declaration-property-value-disallowed-list',
            '.fixture { width: var(--app-width); font-size: var(--app-font-size); z-index: var(--app-z); }',
            'app/components/fixture.css',
        )).resolves.toHaveLength(0);
        await expect(lintStyle(
            'declaration-property-value-disallowed-list',
            '.fixture { width: 12px; font-size: 1rem; z-index: 2; }',
            'app/components/fixture.css',
        )).resolves.toHaveLength(3);
    });

    it('rejects unapproved important declarations through Stylelint', async () => {
        await expect(lintStyle(
            'evb/important-policy',
            '.fixture { color: red; }',
            'app/components/fixture.css',
        )).resolves.toHaveLength(0);
        await expect(lintStyle(
            'evb/important-policy',
            '/* css-important-allow: native override */\n.fixture { color: red !important; }',
            'app/components/fixture.css',
        )).resolves.toHaveLength(0);
        await expect(lintStyle(
            'evb/important-policy',
            '.fixture { color: red !important; }',
            'app/components/fixture.css',
        )).resolves.toMatchObject([{rule: 'evb/important-policy'}]);
    });

    it('rejects invalid app-owned style asset names and CSS extensions', async () => {
        await expect(lintStyle(
            'evb/style-asset-conventions',
            '.fixture { color: red; }',
            'app/assets/css/_good-name.scss',
        )).resolves.toHaveLength(0);
        await expect(lintStyle(
            'evb/style-asset-conventions',
            '.fixture { color: red; }',
            'app/assets/css/Bad_Name.css',
        )).resolves.toHaveLength(2);
    });
});

