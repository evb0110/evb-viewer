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

describe('no-relative-imports rule', () => {
    it('rejects static, dynamic, re-export, and type import sources', () => {
        tester.run(
            'no-relative-imports',
            rules['no-relative-imports'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: 'import { value } from \'@app/utils/value\';' },
                    { code: 'const module = import(\'@scripts/task\');' },
                    { code: 'type TModule = typeof import(\'@contracts\');' },
                ],
                invalid: [
                    {
                        code: 'import { value } from \'./value\';',
                        errors: [{ message: 'Use an absolute alias import instead of a relative import.' }],
                    },
                    {
                        code: 'export { value } from \'../value\';',
                        errors: [{ message: 'Use an absolute alias import instead of a relative import.' }],
                    },
                    {
                        code: 'const module = import(\'./value\');',
                        errors: [{ message: 'Use an absolute alias import instead of a relative import.' }],
                    },
                    {
                        code: 'type TModule = typeof import(\'../value\');',
                        errors: [{ message: 'Use an absolute alias import instead of a relative import.' }],
                    },
                ],
            },
        );
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

describe('tailwind-class-shorthand rule', () => {
    it('passes RuleTester valid/invalid scenarios', () => {
        tester.run(
            'tailwind-class-shorthand',
            rules['tailwind-class-shorthand'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: '<template><div class="py-2" /></template>' },
                    { code: '<template><div :class="`px-3`" /></template>' },
                ],
                invalid: [
                    {
                        code: '<template><div class="pt-2 pb-2" /></template>',
                        output: '<template><div class="py-2" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div :class="`pl-3 pr-3`" /></template>',
                        output: '<template><div :class="`px-3`" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div class="px-2 px-2" /></template>',
                        output: '<template><div class="px-2" /></template>',
                        errors: 1,
                    },
                    {
                        code: '<template><div class="grid-cols-[13]" /></template>',
                        output: null,
                        errors: [{message: 'Use layout tokens instead of arbitrary numeric Tailwind utilities: grid-cols-[13]'}],
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

describe('destructuring-property-newline rule', () => {
    it('splits properties without discarding annotations, rest elements, or comments', () => {
        tester.run(
            'destructuring-property-newline',
            rules['destructuring-property-newline'] as Parameters<typeof tester.run>[1],
            {
                valid: [
                    { code: 'const {alpha} = source;' },
                    { code: 'const {\n    alpha,\n    beta,\n} = source;' },
                ],
                invalid: [
                    {
                        code: 'const {alpha, beta} = source;',
                        output: 'const {\n    alpha,\n    beta,\n} = source;',
                        errors: [{message: 'Destructuring properties should be on separate lines when there are 2 or more'}],
                    },
                    {
                        code: 'function useThing({alpha, beta}: IThing) {}',
                        output: 'function useThing({\n    alpha,\n    beta,\n}: IThing) {}',
                        errors: 1,
                    },
                    {
                        code: 'function useThing({\n    alpha,\n    beta, gamma\n}: IThing) {}',
                        output: 'function useThing({\n    alpha,\n    beta,\n    gamma,\n}: IThing) {}',
                        errors: [{message: 'Each destructuring property should be on its own line'}],
                    },
                    {
                        code: 'function maybe({alpha, beta}: IOpts = {}) {}',
                        output: 'function maybe({\n    alpha,\n    beta,\n}: IOpts = {}) {}',
                        errors: 1,
                    },
                    {
                        code: 'const {alpha, ...rest} = source;',
                        output: 'const {\n    alpha,\n    ...rest\n} = source;',
                        errors: 1,
                    },
                    {
                        code: 'const {alpha, /* load-bearing */ beta} = source;',
                        output: null,
                        errors: 1,
                    },
                ],
            },
        );
    });
});
