import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

const projectRoot = process.cwd();
const {buildDependencyGraph} = await import(pathToFileURL(resolve(projectRoot, 'scripts/architecture/dep-graph.mjs')).href);
const {
    checkArchitectureBoundarySource,
    SENTRY_BUILD_CONFIG_ROOTS,
    SENTRY_CANARY_TOOL_ROOTS,
    SENTRY_RELEASE_TOOL_ROOTS,
    SENTRY_RUNTIME_ADAPTER_ROOTS,
    SENTRY_VERIFICATION_TOOL_ROOTS,
} = await import(
    pathToFileURL(resolve(projectRoot, 'scripts/architecture/boundary-check.mjs')).href
);

const SENTRY_BOUNDARY_RULES = new Set([
    'sentry-capture-boundary',
    'sentry-cli-boundary',
    'sentry-dsn-boundary',
    'sentry-event-boundary',
    'sentry-import-boundary',
    'sentry-upload-token-boundary',
]);

function sentryViolations(source: string, sourceText: string) {
    return checkArchitectureBoundarySource(source, sourceText)
        .filter(({rule}: {rule: string}) => SENTRY_BOUNDARY_RULES.has(rule));
}

describe('Sentry SDK and CLI architecture policy', () => {
    it('pins the approved runtime packages and keeps the Electron SDK absent', async () => {
        const packageJson = JSON.parse(
            await readFile(resolve(projectRoot, 'package.json'), 'utf8'),
        ) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        expect(packageJson.dependencies).toMatchObject({
            '@sentry/browser': '10.71.0',
            '@sentry/core': '10.71.0',
            '@sentry/node': '10.71.0',
        });
        expect(packageJson.devDependencies).toMatchObject({'@sentry/cli': '3.6.2'});
        expect(packageJson.dependencies).not.toHaveProperty('@sentry/electron');
        expect(packageJson.devDependencies).not.toHaveProperty('@sentry/electron');
        expect(await readFile(resolve(projectRoot, 'pnpm-workspace.yaml'), 'utf8'))
            .toContain('  - \'@sentry/cli\'');
    });

    it('keeps the renderer source graph free of Sentry modules', async () => {
        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['app'],
        });
        const violations = graph.nodes.flatMap((node: {
            file: string;
            sourceText?: string
        }) => (
            sentryViolations(node.file, node.sourceText ?? '')
        ));

        expect(violations).toEqual([]);
    }, 60_000);

    it('rejects imports from features, scripts, runners, preload, and workers', () => {
        const fixtures = [
            [
                'app/modules/workspace-shell/feature.ts',
                'import * as Sentry from \'@sentry/browser\';\n',
            ],
            [
                'scripts/check-diagnostics.mjs',
                'const Sentry = require(\'@sentry/node\');\n',
            ],
            [
                'scripts/electron-run/runner.ts',
                'await import(\'@sentry/core\');\n',
            ],
            [
                'electron/preload.ts',
                'import type { Event } from \'@sentry/core\';\n',
            ],
            [
                'electron/ocr/worker/main.ts',
                'import { captureException } from \'@sentry/node\';\n',
            ],
        ] as const;

        for (const [
            source,
            sourceText,
        ] of fixtures) {
            expect(sentryViolations(source, sourceText), source).toEqual([expect.objectContaining({rule: 'sentry-import-boundary'})]);
        }
    });

    it('rejects DSN, capture, and event construction outside runtime adapters', () => {
        const fixtures = [
            [
                'packages/contracts/electronApi.ts',
                'const dsn = process.env.SENTRY_DSN;\n',
                'sentry-dsn-boundary',
            ],
            [
                'app/modules/workspace-shell/feature.ts',
                'Sentry.captureException(error);\n',
                'sentry-capture-boundary',
            ],
            [
                'scripts/release/stage-private-sourcemaps.mjs',
                'const sentryEvent = {type: \'error\'};\n',
                'sentry-event-boundary',
            ],
        ] as const;

        for (const [
            source,
            sourceText,
            rule,
        ] of fixtures) {
            expect(sentryViolations(source, sourceText), source).toEqual([expect.objectContaining({rule})]);
        }
    });

    it('allows only the exact runtime adapters to use approved SDK packages', () => {
        const runtimeFixtures = [
            [
                'electron/features/diagnostics/sentryNodeAdapter.ts',
                'import { captureException } from \'@sentry/node\';\n'
                    + 'const dsn = process.env.SENTRY_DSN;\n'
                    + 'Sentry.captureException(error);\n'
                    + 'const sentryEvent = {};\n',
            ],
            [
                'app/utils/browserDiagnosticsTransport.ts',
                'import { captureEvent } from \'@sentry/browser\';\n'
                    + 'const dsn = process.env.SENTRY_DSN;\n'
                    + 'Sentry.captureEvent(event);\n'
                    + 'const sentryEvent = {};\n',
            ],
            [
                'server/utils/sentryNitroAdapter.ts',
                'import { captureEvent } from \'@sentry/core\';\n'
                    + 'const dsn = process.env.SENTRY_DSN;\n'
                    + 'Sentry.captureEvent(event);\n'
                    + 'const sentryEvent = {};\n',
            ],
        ] as const;

        for (const [
            source,
            sourceText,
        ] of runtimeFixtures) {
            expect(sentryViolations(source, sourceText), source).toEqual([]);
        }
    });

    it('allows DSN pass-through only in the exact build configuration roots', () => {
        const buildSource = [
            'const browserDsn = process.env.SENTRY_BROWSER_DSN ?? \'\';',
            'const nitroDsn = process.env.SENTRY_NITRO_DSN ?? \'\';',
            'const dsn = browserDsn;',
        ].join('\n');

        for (const source of SENTRY_BUILD_CONFIG_ROOTS) {
            expect(sentryViolations(source, buildSource), source).toEqual([]);
        }

        expect(sentryViolations('scripts/release/build-receipt.mjs', buildSource))
            .toEqual([expect.objectContaining({rule: 'sentry-dsn-boundary'})]);
        expect(SENTRY_BUILD_CONFIG_ROOTS).toEqual(new Set([
            'scripts/build-electron.mjs',
            'nuxt.config.ts',
        ]));
    });

    it('allows the exact canary tool to send closed envelopes without capture APIs', () => {
        const source = 'import { createEventEnvelope } from \'@sentry/core\';\n'
            + 'const dsn = process.env.SENTRY_DESKTOP_DSN;\n'
            + 'createEventEnvelope(event, dsn);\n';
        expect(sentryViolations(
            'scripts/release/send-sentry-sourcemap-canaries.mjs',
            source,
        )).toEqual([]);
        expect(sentryViolations(
            'scripts/release/send-sentry-sourcemap-canaries.mjs',
            `${source}Sentry.captureEvent(event);\n`,
        )).toEqual([expect.objectContaining({rule: 'sentry-capture-boundary'})]);
        expect(SENTRY_CANARY_TOOL_ROOTS).toEqual(new Set(['scripts/release/send-sentry-sourcemap-canaries.mjs']));
    });

    it('allows only the exact release tools to spawn the CLI and read its token', () => {
        const releaseSource = 'import { SentryCli } from \'@sentry/cli\';\n'
            + 'import { spawn } from \'node:child_process\';\n'
            + 'const token = process.env.SENTRY_AUTH_TOKEN;\n'
            + 'spawn(\'sentry-cli\', [\'sourcemaps\', \'inject\']);\n';

        for (const source of SENTRY_RELEASE_TOOL_ROOTS) {
            expect(sentryViolations(source, releaseSource), source).toEqual([]);
        }

        expect(sentryViolations(
            'scripts/electron-run/runner.ts',
            releaseSource,
        ).map(({rule}: {rule: string}) => rule)).toEqual([
            'sentry-import-boundary',
            'sentry-upload-token-boundary',
            'sentry-cli-boundary',
        ]);
    });

    it('allows only the exact verification tool to read its read-only token', () => {
        const verificationSource = 'const token = process.env.SENTRY_VERIFICATION_TOKEN;\n';

        expect(sentryViolations(
            'scripts/release/verify-sentry-sourcemap-canaries.mjs',
            verificationSource,
        )).toEqual([]);
        expect(sentryViolations(
            'scripts/electron-run/runner.ts',
            verificationSource,
        )).toEqual([expect.objectContaining({
            rule: 'sentry-upload-token-boundary',
            specifier: 'verification-token-read',
        })]);
        expect(SENTRY_VERIFICATION_TOOL_ROOTS).toEqual(new Set(['scripts/release/verify-sentry-sourcemap-canaries.mjs']));
    });

    it('rejects client imports and capture calls even in release tools', () => {
        for (const source of SENTRY_RELEASE_TOOL_ROOTS) {
            expect(sentryViolations(source, 'import \'@sentry/core\';\n')).toEqual([expect.objectContaining({rule: 'sentry-import-boundary'})]);
            expect(sentryViolations(source, 'Sentry.captureEvent(event);\n')).toEqual([expect.objectContaining({rule: 'sentry-capture-boundary'})]);
        }
    });

    it('keeps the allowlist exact rather than accepting directory prefixes', () => {
        const sourceText = 'import \'@sentry/browser\';\n';
        expect(sentryViolations(
            'app/utils/nested/browserDiagnosticsTransport.ts',
            sourceText,
        )).toEqual([expect.objectContaining({rule: 'sentry-import-boundary'})]);
        expect(SENTRY_RUNTIME_ADAPTER_ROOTS).toEqual(new Set([
            'electron/features/diagnostics/sentryNodeAdapter.ts',
            'app/utils/browserDiagnosticsTransport.ts',
            'server/utils/sentryNitroAdapter.ts',
        ]));
    });

    it('ignores comments and ordinary non-Sentry strings', () => {
        const sourceText = [
            '// Sentry.captureException(error);',
            'const label = \'captureException\';',
            'const url = \'https://example.test/errors\';',
        ].join('\n');

        expect(sentryViolations('app/modules/workspace-shell/feature.ts', sourceText)).toEqual([]);
    });
});
