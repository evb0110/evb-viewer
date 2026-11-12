import {describe, it} from 'vitest';
import {RuleTester} from 'oxlint/plugins-dev';

const plugin = (await import(new URL('../../../oxlint-plugin-invariants.mjs', import.meta.url).href)).default;
const rules: Record<string, Parameters<RuleTester['run']>[1]> = plugin.rules;
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({cwd: process.cwd()});

tester.run('annotation-storage-public-access', rules['annotation-storage-public-access']!, {
    valid: [{code: 'annotationDiagnostics.snapshot();', filename: 'app/fixture.ts'}],
    invalid: [
        'const storage = document.annotationStorage; storage.resetModified();',
        'const storage =\n    document\n        .annotationStorage;\nstorage.resetModified();',
    ].map(code => ({
        code,
        filename: 'app/fixture.ts',
        errors: [{message: 'PDF.js annotationStorage internals must be accessed through the public annotation diagnostics accessor.'}],
    })),
});

tester.run('platform-api-narrow-getter', rules['platform-api-narrow-getter']!, {
    valid: [
        {code: 'import {getShellCapability} from "@app/utils/getShellCapability"; getShellCapability();', filename: 'app/fixture.ts'},
        {code: 'import {getPlatformAPI} from "@app/utils/platform"; getPlatformAPI();', filename: 'app/utils/getShellCapability.ts'},
    ],
    invalid: [{
        code: 'import {getPlatformAPI as api} from "@app/utils/platform"; api();',
        filename: 'app/fixture.ts',
        errors: [{message: 'App code must use a narrow platform capability getter instead of calling getPlatformAPI() directly.'}],
    }],
});

tester.run('workspace-format-comparison', rules['workspace-format-comparison']!, {
    valid: [{code: 'if (document.capabilities.print) print();', filename: 'app/modules/workspace-shell/fixture.ts'}],
    invalid: [{
        code: 'if (document.format === "pdf") print();', filename: 'app/modules/workspace-shell/fixture.ts',
        errors: [{message: 'Format comparison on document.format uses "pdf".'}],
    }],
});

tester.run('component-directory-source', rules['component-directory-source']!, {
    valid: [{code: 'export const helper = 1;', filename: 'app/utils/fixture.ts'}],
    invalid: [{
        code: 'export const helper = 1;', filename: 'app/components/fixture.ts',
        errors: [{message: 'Component directories must contain Vue SFCs only; move helpers, state, and schedulers into feature modules.'}],
    }],
});

tester.run('top-level-pdf-composable', rules['top-level-pdf-composable']!, {
    valid: [{code: 'export const usePdfFixture = () => 1;', filename: 'app/modules/pdf-viewer/usePdfFixture.ts'}],
    invalid: [{
        code: 'export const usePdfFixture = () => 1;', filename: 'app/composables/usePdfFixture.ts',
        errors: [{message: 'Top-level app/composables/usePdf*.ts files are blocked; keep PDF composables in feature modules.'}],
    }],
});

tester.run(
            'no-core-correctness-timers',
            rules['no-core-correctness-timers']!,
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
                    {
                        code: 'scheduler.setTimeout(run, 10);',
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
                    {
                        code: 'window.setTimeout(run, 10);',
                        filename: 'app/modules/document-viewer/viewport/wait.ts',
                        errors: 1,
                    },
                    {
                        code: 'globalThis.setInterval(poll, 10);',
                        filename: 'app/modules/pdf-viewer/runtime/viewport/wait.ts',
                        errors: 1,
                    },
                ],
            },
        );

tester.run('no-raw-red-presentation', rules['no-raw-red-presentation']!, {
    valid: [{code: 'toast.add({color: "error", failure});', filename: 'app/composables/useFailureToast.ts'}],
    invalid: [{
        code: 'useToast().add({color: "error"});', filename: 'app/fixture.ts',
        errors: [{message: 'Route red failure presentation through the shared receipt-aware presenter.'}],
    }],
});

tester.run('e2e-click-as-user', rules['e2e-click-as-user']!, {
    valid: [
        'await clickAsUser(page, handle);',
        'await page.mouse.click(10, 20);',
        'await page.evaluate(() => document.querySelector(".tab")?.click());',
    ].map(code => ({code, filename: 'tests/e2e/electron/fixture.test.ts'})),
    invalid: [
        'await handle.click();',
        'await page.click(".tab");',
        'const probe = (index: number) => { tabs[index]?.click(); };',
    ].map(code => ({
        code, filename: 'tests/e2e/electron/fixture.test.ts',
        errors: [{message: 'Click through clickAsUser from tests/e2e/electron/helpers/userInput.ts; ElementHandle.click and page.click do not check what covers the target.'}],
    })),
});
