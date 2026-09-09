import { existsSync } from 'node:fs';
import path from 'node:path';
import {
    build,
    type BuildOptions,
    type Plugin,
} from 'esbuild';

export const GUEST_WORKER_ENTRY_POINT = path.join(
    'scripts',
    'windows-test',
    'guest',
    'guestWorkerMain.ts',
);

export const GUEST_WORKER_IMPORT_META_IDENTIFIER = '__guestWorkerImportMetaUrl';

export const guestWorkerAliasPrefixes = {
    '@scripts/': 'scripts',
    '@tests/': 'tests',
    '@contracts/': path.join('packages', 'contracts'),
    '@app/': 'app',
    '@electron/': 'electron',
} as const;

const CANDIDATE_SUFFIXES = [
    '',
    '.ts',
    '.tsx',
    '.json',
    path.join(path.sep, 'index.ts'),
];

export function resolveGuestWorkerAlias(repoRoot: string, specifier: string) {
    for (const [
        prefix,
        directory,
    ] of Object.entries(guestWorkerAliasPrefixes)) {
        if (!specifier.startsWith(prefix)) {
            continue;
        }
        const relative = specifier.slice(prefix.length).split('/').join(path.sep);
        const base = path.join(repoRoot, directory, relative);
        const resolved = CANDIDATE_SUFFIXES
            .map(suffix => `${base}${suffix}`)
            .find(candidate => existsSync(candidate));
        if (resolved === undefined) {
            throw new Error(`Cannot resolve workspace import ${specifier} under ${repoRoot}`);
        }
        return resolved;
    }
    return null;
}

export function guestWorkerAliasPlugin(repoRoot: string): Plugin {
    return {
        name: 'evb-guest-worker-aliases',
        setup: (buildContext) => {
            buildContext.onResolve({ filter: /^@(app|contracts|electron|scripts|tests)(\/|$)/ }, (args) => {
                const resolved = resolveGuestWorkerAlias(repoRoot, args.path);
                return resolved === null ? null : {
                    path: resolved,
                    // Fixture-generation imports belong to the host. The guest
                    // uses UI helpers whose unused fixture readers can be pruned.
                    ...(args.path === '@tests/e2e/electron/helpers/fixtures' ? { sideEffects: false } : {}),
                };
            });
        },
    };
}

export interface IBundleGuestWorkerOptions {
    outFile: string;
    repoRoot?: string;
    minify?: boolean;
    external?: readonly string[];
}

export function guestWorkerBuildOptions({
    outFile,
    repoRoot = process.cwd(),
    minify = false,
    external = [],
}: IBundleGuestWorkerOptions): BuildOptions {
    return {
        entryPoints: [path.join(repoRoot, GUEST_WORKER_ENTRY_POINT)],
        outfile: path.resolve(repoRoot, outFile),
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        sourcemap: 'linked',
        minify,
        external: [
            '@napi-rs/canvas',
            ...external,
        ],
        legalComments: 'none',
        logLevel: 'warning',
        define: { 'import.meta.url': GUEST_WORKER_IMPORT_META_IDENTIFIER },
        banner: {js: [
            `const ${GUEST_WORKER_IMPORT_META_IDENTIFIER} = require('node:url')`,
            '.pathToFileURL(__filename).href;',
        ].join('')},
        plugins: [guestWorkerAliasPlugin(repoRoot)],
    };
}

export async function bundleGuestWorker(options: IBundleGuestWorkerOptions) {
    const buildOptions = guestWorkerBuildOptions(options);
    const result = await build({
        ...buildOptions,
        metafile: true,
    });
    return {
        outFile: buildOptions.outfile ?? options.outFile,
        errors: result.errors.length,
        warnings: result.warnings.length,
        bytes: Object.values(result.metafile.outputs)
            .reduce((total, output) => total + output.bytes, 0),
    };
}
