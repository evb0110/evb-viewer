import {
    describe,
    expect,
    it,
} from 'vitest';
import {RuleTester} from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';
import stylelint from 'stylelint';

const customPlugin = (await import(new URL('../../../eslint-plugin-custom.mjs', import.meta.url).href)).default;
const stylelintConfigModule = await import(new URL('../../../stylelint.config.mjs', import.meta.url).href);
const stylelintConfig = stylelintConfigModule.default;
const stylelintCustomPlugins = stylelintConfigModule.stylelintCustomPlugins;

const tester = new RuleTester({languageOptions: {
    parser: vueParser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { parser: tsParser },
}});

const rules = (customPlugin as { rules: Record<string, unknown> }).rules;

describe('named-timestamps rule', () => {
    it('requires named epoch or ISO timestamp types on contract At properties', () => {
        tester.run(
            'named-timestamps',
            rules['named-timestamps'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    {
                        code: 'interface IValid { createdAt: TEpochMs; modifiedAt?: TIsoTimestamp | null; }',
                        filename: 'packages/contracts/timestamps.ts',
                    },
                    {
                        code: 'interface IValid { updatedAtMs: number; }',
                        filename: 'packages/contracts/timestamps.ts',
                    },
                    {
                        code: 'interface IValid { insertAt: number; }',
                        filename: 'packages/contracts/pageNumbers.ts',
                    },
                ],
                invalid: [
                    {
                        code: 'interface IInvalid { createdAt: number; }',
                        filename: 'packages/contracts/example.ts',
                        errors: [{message: 'Timestamp property "createdAt" must use TEpochMs or TIsoTimestamp.'}],
                    },
                    {
                        code: 'interface IInvalid { publishedAt?: string | null; }',
                        filename: 'packages/contracts/example.ts',
                        errors: [{message: 'Timestamp property "publishedAt" must use TEpochMs or TIsoTimestamp.'}],
                    },
                ],
            },
        );
    });
});

describe('commonjs-named-imports rule', () => {
    it('rejects runtime named imports and permits default and type-only UTIF imports', () => {
        tester.run(
            'commonjs-named-imports',
            rules['commonjs-named-imports'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: 'import UTIF from \'utif\';' },
                    { code: 'import type { IUtifFrame } from \'utif\';' },
                    { code: 'import UTIF, { type IUtifFrame } from \'utif\';' },
                ],
                invalid: [{
                    code: 'import { decode, type IUtifFrame } from \'utif\';',
                    errors: [{message: 'Import UTIF as the CommonJS default export; runtime named import(s) are unsafe: decode.'}],
                }],
            },
        );
    });
});

describe('no-removed-package-aliases rule', () => {
    it('rejects the contracts barrel and removed scoped aliases while allowing canonical subpaths', () => {
        tester.run('no-removed-package-aliases', rules['no-removed-package-aliases'] as Parameters<typeof tester.run>[1], {
            valid: [
                { code: 'import { requireDocumentRevisionToken } from \'@contracts/documentRevision\';' },
                { code: 'import { LOCALE_CODES } from \'@i18n-core/localeCodes\';' },
                { code: 'export { selectPreferredInstallers } from \'@releaseSelection\';' },
            ],
            invalid: [
                {
                    code: 'import { requireDocumentRevisionToken } from \'@contracts\';',
                    errors: [{message: 'Use a canonical package subpath instead of removed alias "@contracts".'}],
                },
                {
                    code: 'export { plural } from \'@evb/i18n-core/messageFormat\';',
                    errors: [{message: 'Use a canonical package subpath instead of removed alias "@evb/i18n-core/messageFormat".'}],
                },
            ],
        });
    });
});

describe('no-bare-page-number-type rule', () => {
    it('requires branded scalar and collection page addresses', () => {
        tester.run(
            'no-bare-page-number-type',
            rules['no-bare-page-number-type'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    {
                        code: 'interface IValid { pageNumber: TPageNumber; pageIndex?: TPageIndex | null; pageNumbers: readonly TPageNumber[]; }',
                        filename: 'packages/contracts/pageNumbers.ts',
                    },
                    {
                        code: 'function valid(pageNumber: TPageNumber, pageIndex: TPageIndex) { const pageNumbers: TPageNumber[] = []; return [pageNumber, pageIndex, pageNumbers]; }',
                        filename: 'app/modules/pdf-viewer/engine/page.ts',
                    },
                ],
                invalid: [
                    {
                        code: 'interface IInvalid { pageNumber: number; }',
                        filename: 'packages/contracts/pageNumbers.ts',
                        errors: [{message: 'Use TPageNumber or TPageIndex instead of a bare number page address type.'}],
                    },
                    {
                        code: 'function invalid(pageIndex: number | null) { const pageNumbers: Array<number> = []; return [pageIndex, pageNumbers]; }',
                        filename: 'app/modules/pdf-viewer/engine/page.ts',
                        errors: 2,
                    },
                ],
            },
        );
    });
});

describe('file-naming rule', () => {
    it('enforces directory, file, Vue component, and main-export names', () => {
        tester.run(
            'file-naming',
            rules['file-naming'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    {
                        code: 'export function exampleTask() {}',
                        filename: 'scripts/exampleTask.ts',
                    },
                    {
                        code: '<template><div /></template>',
                        filename: 'app/components/ExamplePanel.vue',
                    },
                    {
                        code: '<template><div /></template>',
                        filename: 'app/pages/privacy-policy.vue',
                    },
                ],
                invalid: [
                    {
                        code: 'export function badName() {}',
                        filename: 'scripts/BadName.ts',
                        errors: [{ message: 'TypeScript filenames must be camelCase, with only approved dot suffixes.' }],
                    },
                    {
                        code: 'export function exampleTask() {}',
                        filename: 'scripts/Bad_Directory/exampleTask.ts',
                        errors: [{ message: 'Directory "Bad_Directory" must use lower kebab-case.' }],
                    },
                    {
                        code: 'export function runTask() {}',
                        filename: 'scripts/taskRunner.ts',
                        errors: [{ message: 'Filename must match its single/main export "runTask" (expected stem "runTask").' }],
                    },
                    {
                        code: '<template><div /></template>',
                        filename: 'app/components/example-panel.vue',
                        errors: [{ message: 'Vue components must be PascalCase; Nuxt route files may be lower kebab-case.' }],
                    },
                ],
            },
        );
    });
});

describe('no-core-correctness-timers rule', () => {
    it('rejects timeout and interval coordination only inside guarded viewer-core roots', () => {
        tester.run(
            'no-core-correctness-timers',
            rules['no-core-correctness-timers'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    {
                        code: 'setTimeout(run, 10);',
                        filename: 'app/modules/pdf-viewer/runtime/rendering/retry.ts',
                    },
                    {
                        code: 'await abortableWait(signal);',
                        filename: 'app/modules/pdf-viewer/runtime/viewport/wait.ts',
                    },
                ],
                invalid: [
                    {
                        code: 'setTimeout(run, 10);',
                        filename: 'app/modules/pdf-viewer/runtime/viewport/wait.ts',
                        errors: 1,
                    },
                    {
                        code: 'setInterval(poll, 10);',
                        filename: 'app/modules/pdf-viewer/runtime/page-slots/wait.ts',
                        errors: 1,
                    },
                ],
            },
        );
    });
});

describe('migrated core ESLint and Stylelint rules', () => {
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

describe('arrow-composable rule', () => {
    it('reports exported composable declarations and function expressions', () => {
        tester.run(
            'arrow-composable',
            rules['arrow-composable'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: 'export const useFoo = () => value;' },
                    { code: 'function useInternal() { return value; }' },
                    { code: 'export function buildFoo() { return value; }' },
                ],
                invalid: [
                    {
                        code: 'export function useFoo(options: IOptions) { return options; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export async function useFoo<T>(options: T): Promise<T> { return options; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nuseFoo();',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'const value = useFoo();\nexport function useFoo() { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo(value: string): string;\nexport function useFoo(value: string) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'function useFoo() { return value; }\nexport { useFoo };',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export default function useFoo() { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'function useFoo() { return value; }\nexport default useFoo;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export const useFoo = function () { return value; };',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'const useFoo = function () { return value; };\nexport { useFoo };',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                ],
            },
        );
    });

    it('reports unsafe function semantics without autofix', () => {
        tester.run(
            'arrow-composable',
            rules['arrow-composable'] as Parameters<typeof tester.run>[1],
            {
                valid: [],
                invalid: [
                    {
                        code: 'export function useFoo(this: Ctx, value: number) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return this.value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return arguments[0]; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return new.target; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo(value = arguments[0]) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo(value = this.value) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo({ value = new.target } = {}) { return value; }',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nnew useFoo();',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nuseFoo.prototype.extra = 1;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nuseFoo = () => 2;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nnew (useFoo as any)();',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\n(useFoo as any).prototype.extra = 1;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nclass Child extends useFoo {}',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nclass Child extends (useFoo as any) {}',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nvalue instanceof useFoo;',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nReflect.construct(useFoo, []);',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nnew (condition ? useFoo : Other)();',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nclass Child extends (condition ? useFoo : Base) {}',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nvalue instanceof (condition ? useFoo : Other);',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nReflect[\'construct\'](useFoo, []);',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                    {
                        code: 'export function useFoo() { return 1; }\nReflect.construct(Date, [], useFoo);',
                        output: null,
                        errors: [{ message: 'Exported composables should use arrow constants.' }],
                    },
                ],
            },
        );
    });
});

describe('vue-define-emits-tuple rule', () => {
    it('converts defineEmits call signatures to tuple properties', () => {
        tester.run(
            'vue-define-emits-tuple',
            rules['vue-define-emits-tuple'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<script setup lang="ts">const emit = defineEmits<{save: [];}>();</script>' },
                    { code: '<script setup lang="ts">const emit = defineEmits<IEmits>();</script>' },
                    { code: '<script setup lang="ts">const emit = defineEmits<{<T>(e: \'select\', value: T): void;}>();</script>' },
                ],
                invalid: [
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'activate\'): void;}>();</script>',
                        output: '<script setup lang="ts">const emit = defineEmits<{activate: [];}>();</script>',
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: `<script setup lang="ts">
const emit = defineEmits<{
    (e: 'update:open', value: boolean): void
    (e: 'resize-start', event: PointerEvent): void;
}>();
</script>`,
                        output: `<script setup lang="ts">
const emit = defineEmits<{
    'update:open': [value: boolean];
    'resize-start': [event: PointerEvent];
}>();
</script>`,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{save: []; (e: \'cancel\'): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'cancel\');}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'save\', value): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'save\', ...args): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e?: \'save\'): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(this: void, e: \'save\'): void;}>();</script>',
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: `<script setup lang="ts">
const emit = defineEmits<{
    // Fired after save.
    (e: 'save'): void;
}>();
</script>`,
                        output: null,
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                    {
                        code: '<script setup lang="ts">const emit = defineEmits<{(e: \'save\\\\nnow\'): void;}>();</script>',
                        output: '<script setup lang="ts">const emit = defineEmits<{\'save\\\\nnow\': [];}>();</script>',
                        errors: [{ message: 'Use tuple-style defineEmits type literals.' }],
                    },
                ],
            },
        );
    });
});

describe('nuxt-ui-semantic-utilities rule', () => {
    it('passes RuleTester valid/invalid scenarios', () => {
        tester.run(
            'nuxt-ui-semantic-utilities',
            rules['nuxt-ui-semantic-utilities'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<template><div class="text-default" /></template>' },
                    { code: '<template><div :class="`bg-muted`" /></template>' },
                ],
                invalid: [
                    {
                        code: '<template><div class="text-(--ui-text-muted)" /></template>',
                        output: '<template><div class="text-muted" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div class="text-[color:var(--ui-text)]" /></template>',
                        output: '<template><div class="text-default" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div :class="`bg-(--ui-bg-muted)`" /></template>',
                        output: '<template><div :class="`bg-muted`" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div :class="`border-[color:var(--ui-border)] bg-[color:var(--ui-bg-elevated)]`" /></template>',
                        output: '<template><div :class="`border-default bg-elevated`" /></template>',
                        errors: 1,
                    },
                ],
            },
        );
    });
});

describe('tailwind-class-policy rule', () => {
    it('keeps layout-token and conflicting-utility checks', () => {
        tester.run(
            'tailwind-class-shorthand',
            rules['tailwind-class-shorthand'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<template><div class="py-2" /></template>' },
                    { code: '<template><div class="grid-cols-3" /></template>' },
                ],
                invalid: [
                    {
                        code: '<template><div class="grid-cols-[13]" /></template>',
                        output: null,
                        errors: [{message: 'Use layout tokens instead of arbitrary numeric Tailwind utilities: grid-cols-[13]'}],
                    },
                    {
                        code: '<template><div class="md:-mt-[13%]" /></template>',
                        output: null,
                        errors: [{message: 'Use layout tokens instead of arbitrary numeric Tailwind utilities: md:-mt-[13%]'}],
                    },
                    {
                        code: '<template><div class="p-2 p-4" /></template>',
                        output: null,
                        errors: [{message: 'Conflicting Tailwind utilities: p -> p-2 vs p-4'}],
                    },
                ],
            },
        );
    });
});
describe('app-tooltip-only rule', () => {
    it('rejects raw tooltip APIs but allows AppTooltip and component title props', () => {
        tester.run(
            'app-tooltip-only',
            rules['app-tooltip-only'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<template><AppTooltip text="Open"><button aria-label="Open" /></AppTooltip></template>' },
                    { code: '<template><UModal :title="title" /></template>' },
                    { code: '<template><PdfPanelEmptyState :title="title" /></template>' },
                    { code: '<template><button aria-label="Open" /></template>' },
                ],
                invalid: [
                    {
                        code: '<template><UTooltip text="Open"><button /></UTooltip></template>',
                        errors: [{ message: 'Use AppTooltip instead of UTooltip so tooltip usefulness is centralized.' }],
                    },
                    {
                        code: '<template><button title="Open" /></template>',
                        errors: [{ message: 'Do not use native title tooltips. Use AppTooltip for useful tooltips, or aria-label for accessibility-only labels.' }],
                    },
                    {
                        code: '<template><div :title="label" /></template>',
                        errors: [{ message: 'Do not use native title tooltips. Use AppTooltip for useful tooltips, or aria-label for accessibility-only labels.' }],
                    },
                ],
            },
        );
    });
});
