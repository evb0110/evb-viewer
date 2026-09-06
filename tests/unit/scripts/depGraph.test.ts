import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const {
    buildDependencyGraph,
    findStronglyConnectedComponents,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/architecture/dep-graph.mjs')).href);
const {
    checkArchitectureBoundaryEdge,
    checkArchitectureBoundaryNode,
    checkArchitectureBoundarySource,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/architecture/boundary-check.mjs')).href
);
const {
    ANNOTATION_GRAPH_SCAN_ROOTS,
    ANNOTATION_LATE_BOUND_EDGES,
    checkAnnotationDependencyEdge,
    checkAnnotationDependencyGraph,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/architecture/annotation-dependency-graph.mjs')).href
);

const temporaryProjectRoots: string[] = [];

async function createTemporaryProjectRoot() {
    const projectRoot = await mkdtemp(join(tmpdir(), 'evb-dep-graph-'));
    temporaryProjectRoots.push(projectRoot);
    return projectRoot;
}

afterEach(async () => {
    const roots = temporaryProjectRoots.splice(0);
    await Promise.all(roots.map(projectRoot => rm(projectRoot, {
        force: true,
        recursive: true,
    })));
});

describe('dependency graph', () => {
    it('blocks pdfjs-dist imports outside renderer and adapter roots', () => {
        expect(checkArchitectureBoundarySource(
            'app/utils/exportTextAsDocx.ts',
            'import type { PDFPageProxy } from \'pdfjs-dist/types/src/display/api\';\n',
        )).toEqual([{
            rule: 'pdfjs-import-boundary',
            source: 'app/utils/exportTextAsDocx.ts',
            target: 'pdfjs-dist/types/src/display/api',
            specifier: 'pdfjs-dist/types/src/display/api',
            message: 'pdfjs-dist imports belong only in the renderer or its PDF.js adapter roots.',
        }]);
        expect(checkArchitectureBoundarySource(
            'app/modules/pdf-viewer/runtime/rendering/example.ts',
            'import * as pdfjs from \'pdfjs-dist\';\n',
        )).toEqual([]);
        expect(checkArchitectureBoundarySource(
            'app/components/PdfViewer.vue',
            '<script setup lang="ts">\nimport type { IPdfPage } from \'pdfjs-dist\';\n</script>',
        )).toHaveLength(1);
        expect(checkArchitectureBoundarySource(
            'app/utils/pdfPrint.ts',
            'const pdfjs = await import(\'pdfjs-dist/legacy/build/pdf.mjs\');\n',
        )).toHaveLength(1);
        expect(checkArchitectureBoundarySource(
            'app/utils/pdfPrint.ts',
            'const pdfjs = require(\'pdfjs-dist\');\n',
        )).toHaveLength(1);
    });
    it('fails when a configured root does not exist', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'packages/release-selection'), { recursive: true });

        await expect(buildDependencyGraph({
            projectRoot,
            roots: ['packages/releaseSelection'],
        })).rejects.toThrow('packages/releaseSelection');
    });

    it('includes the release-selection package root', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'packages/release-selection'), { recursive: true });
        await writeFile(join(projectRoot, 'packages/release-selection/index.ts'), 'export const releaseSelection = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['packages/release-selection'],
        });

        expect(graph.nodes.map((node: { file: string }) => node.file)).toEqual(['packages/release-selection/index.ts']);
    });

    it('accepts a source file as a configured root', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'app'), { recursive: true });
        await writeFile(join(projectRoot, 'app/session.ts'), 'export const session = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['app/session.ts'],
        });

        expect(graph.nodes.map((node: { file: string }) => node.file)).toEqual(['app/session.ts']);
    });

    it('ignores generated Vercel output when scanning all architecture roots', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'landing/app'), { recursive: true });
        await mkdir(join(projectRoot, 'landing/.vercel/output/server'), { recursive: true });
        await writeFile(join(projectRoot, 'landing/app/app.ts'), 'export const app = true;\n');
        await writeFile(join(projectRoot, 'landing/.vercel/output/server/index.ts'), 'export const generated = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['landing'],
        });

        expect(graph.nodes.map((node: { file: string }) => node.file)).toEqual(['landing/app/app.ts']);
    });

    it('treats external scoped packages that share internal alias prefixes as external', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'scripts/release'), { recursive: true });
        await writeFile(
            join(projectRoot, 'scripts/release/assert-packaged-app-contents.mjs'),
            'import asar from \'@electron/asar\';\nexport const read = asar.listPackage;\n',
        );

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['scripts'],
        });

        expect(graph.unresolvedInternalImports).toEqual([]);
    });

    it('resolves @evb workspace package aliases into package graph edges', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'app'), { recursive: true });
        await mkdir(join(projectRoot, 'packages/contracts'), { recursive: true });
        await mkdir(join(projectRoot, 'packages/i18n-core'), { recursive: true });
        await writeFile(
            join(projectRoot, 'app/usesContracts.ts'),
            'import { contract } from \'@evb/contracts\';\nexport const appContract = contract;\n',
        );
        await writeFile(join(projectRoot, 'packages/contracts/index.ts'), 'export const contract = true;\n');
        await writeFile(
            join(projectRoot, 'packages/i18n-core/index.ts'),
            'import { format } from \'@evb/i18n-core/messageFormat\';\nexport const i18n = format;\n',
        );
        await writeFile(join(projectRoot, 'packages/i18n-core/messageFormat.ts'), 'export const format = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: [
                'app',
                'packages/contracts',
                'packages/i18n-core',
            ],
        });

        expect(graph.unresolvedInternalImports).toEqual([]);
        expect(graph.edges).toEqual(expect.arrayContaining([
            {
                source: 'app/usesContracts.ts',
                specifier: '@evb/contracts',
                target: 'packages/contracts/index.ts',
            },
            {
                source: 'packages/i18n-core/index.ts',
                specifier: '@evb/i18n-core/messageFormat',
                target: 'packages/i18n-core/messageFormat.ts',
            },
        ]));
    });

    it('reports strongly connected import components as dependency cycles', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'app'), { recursive: true });
        await writeFile(join(projectRoot, 'app/a.ts'), 'import \'./b\';\nexport const a = true;\n');
        await writeFile(join(projectRoot, 'app/b.ts'), 'import \'./a\';\nexport const b = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['app'],
        });

        expect(graph.cycles).toEqual([{ files: [
            'app/a.ts',
            'app/b.ts',
        ] }]);
        expect(findStronglyConnectedComponents(graph.nodes, graph.edges)).toEqual([[
            'app/a.ts',
            'app/b.ts',
        ]]);
    });

    it('does not report type-only import cycles as runtime dependency cycles', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'app'), { recursive: true });
        await writeFile(join(projectRoot, 'app/a.ts'), 'import type { B } from \'./b\';\nexport const a = true;\n');
        await writeFile(join(projectRoot, 'app/b.ts'), 'import type { A } from \'./a\';\nexport const b = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['app'],
        });

        expect(graph.cycles).toEqual([]);
        expect(graph.edges).toHaveLength(2);
    });

    it('keeps a module with both type-only and runtime imports as a runtime edge', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'app'), { recursive: true });
        await writeFile(
            join(projectRoot, 'app/a.ts'),
            'import type { B } from \'./b\';\nimport { b } from \'./b\';\nexport const a = b as B;\n',
        );
        await writeFile(
            join(projectRoot, 'app/b.ts'),
            'import type { A } from \'./a\';\nimport { a } from \'./a\';\nexport const b = a as A;\n',
        );

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['app'],
        });

        expect(graph.cycles).toEqual([{ files: [
            'app/a.ts',
            'app/b.ts',
        ] }]);
    });

    it('does not turn JSDoc module type imports into runtime dependency edges', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'packages/contracts/diagnostics'), { recursive: true });
        await writeFile(
            join(projectRoot, 'packages/contracts/diagnostics/identity.js'),
            '/** @returns {import(\'./identity.js\').Identity} */\nexport const identity = true;\n',
        );

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['packages/contracts/diagnostics'],
        });

        expect(graph.edges).toEqual([]);
        expect(graph.cycles).toEqual([]);
    });

    it('keeps the contracts package dependency graph acyclic', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ['packages/contracts'],
        });

        expect(graph.cycles).toEqual([]);
    });

    it('keeps electron code from importing app runtime modules', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ['electron'],
        });

        const electronToAppEdges = graph.edges.filter((edge: {
            source: string;
            target: string;
        }) => edge.source.startsWith('electron/')
            && edge.target.startsWith('app/'));
        expect(electronToAppEdges).toEqual([]);
    });

    it('requires cross-feature app module component imports to go through public entrypoints', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/components/NewInternalPanel.vue',
            specifier: '@app/modules/pdf-viewer/components/NewInternalPanel.vue',
        })).toEqual([{
            rule: 'app-cross-feature-deep-import',
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/components/NewInternalPanel.vue',
            specifier: '@app/modules/pdf-viewer/components/NewInternalPanel.vue',
            message: 'Cross-feature imports in app/modules must use public entrypoints only.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/components/PdfViewer.vue',
            specifier: '@app/modules/pdf-viewer/components/PdfViewer.vue',
        })).toEqual([{
            rule: 'app-cross-feature-deep-import',
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/components/PdfViewer.vue',
            specifier: '@app/modules/pdf-viewer/components/PdfViewer.vue',
            message: 'Cross-feature imports in app/modules must use public entrypoints only.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/public.ts',
            specifier: '@app/modules/pdf-viewer/public',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/public/component-exports/pdfViewer.ts',
            specifier: '@app/modules/pdf-viewer/public/component-exports/pdfViewer',
        })).toEqual([]);
    });

    it('requires app pages to import modules through public entrypoints', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/index.vue',
            target: 'app/modules/workspace-shell/components/AppShellRoot.vue',
            specifier: '@app/modules/workspace-shell/components/AppShellRoot.vue',
        })).toEqual([{
            rule: 'app-pages-module-deep-import',
            source: 'app/pages/index.vue',
            target: 'app/modules/workspace-shell/components/AppShellRoot.vue',
            specifier: '@app/modules/workspace-shell/components/AppShellRoot.vue',
            message: 'app/pages imports from app/modules must use module public entrypoints only.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/mobile-reader-proof.vue',
            target: 'app/modules/workspace-shell/composables/usePdfFile.ts',
            specifier: '@app/modules/workspace-shell/composables/usePdfFile',
        })).toEqual([{
            rule: 'app-pages-module-deep-import',
            source: 'app/pages/mobile-reader-proof.vue',
            target: 'app/modules/workspace-shell/composables/usePdfFile.ts',
            specifier: '@app/modules/workspace-shell/composables/usePdfFile',
            message: 'app/pages imports from app/modules must use module public entrypoints only.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/index.vue',
            target: 'app/modules/workspace-shell/public/component-exports/appShellRoot.ts',
            specifier: '@app/modules/workspace-shell/public/component-exports/appShellRoot',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/mobile-reader-proof.vue',
            target: 'app/modules/workspace-shell/public.ts',
            specifier: '@app/modules/workspace-shell/public',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/mobile-reader-proof.vue',
            target: 'app/modules/pdf-viewer/public/component-exports/pdfViewer.ts',
            specifier: '@app/modules/pdf-viewer/public/component-exports/pdfViewer',
        })).toEqual([]);
    });

    it('keeps retired PDF migration paths from returning', () => {
        expect(checkArchitectureBoundaryNode('app/components/pdf/PdfViewer.vue')).toEqual([{
            rule: 'retired-pdf-component-path',
            source: 'app/components/pdf/PdfViewer.vue',
            target: 'app/components/pdf/PdfViewer.vue',
            specifier: 'filesystem',
            message: 'Retired PDF components must not be recreated under app/components/pdf; use app/modules/pdf-viewer public entrypoints.',
        }]);

        expect(checkArchitectureBoundaryNode('app/composables/usePdfFile.ts')).toEqual([{
            rule: 'retired-top-level-use-pdf-file',
            source: 'app/composables/usePdfFile.ts',
            target: 'app/composables/usePdfFile.ts',
            specifier: 'filesystem',
            message: 'The retired app/composables/usePdfFile.ts path must stay retired; use app/modules/workspace-shell public entrypoints.',
        }]);
    });

    it('blocks top-level PDF composables after migration', () => {
        expect(checkArchitectureBoundaryNode('app/composables/usePdfSearch.ts')).toEqual([{
            rule: 'top-level-pdf-composable',
            source: 'app/composables/usePdfSearch.ts',
            target: 'app/composables/usePdfSearch.ts',
            specifier: 'filesystem',
            message: 'Top-level app/composables/usePdf*.ts files are blocked; keep PDF composables in feature modules.',
        }]);

        expect(checkArchitectureBoundaryNode('app/composables/usePdfAnnotations.ts')).toEqual([{
            rule: 'top-level-pdf-composable',
            source: 'app/composables/usePdfAnnotations.ts',
            target: 'app/composables/usePdfAnnotations.ts',
            specifier: 'filesystem',
            message: 'Top-level app/composables/usePdf*.ts files are blocked; keep PDF composables in feature modules.',
        }]);
    });

    it('requires browser platform API imports to go through the public entrypoint', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/services/pdf/combinePdfFiles.ts',
            target: 'app/platform/browser-api/createCombinedPdfFromPaths.ts',
            specifier: '@app/platform/browser-api/createCombinedPdfFromPaths',
        })).toEqual([{
            rule: 'browser-api-public-entrypoint',
            source: 'app/services/pdf/combinePdfFiles.ts',
            target: 'app/platform/browser-api/createCombinedPdfFromPaths.ts',
            specifier: '@app/platform/browser-api/createCombinedPdfFromPaths',
            message: 'Browser platform API consumers must import through app/platform/browser-api/public.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/services/pdf/combinePdfFiles.ts',
            target: 'app/platform/browser-api/public.ts',
            specifier: '@app/platform/browser-api/public',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/platform/browser-api/createBrowserDocumentsCapability.ts',
            target: 'app/platform/browser-api/browserWorkingCopyService.ts',
            specifier: '@app/platform/browser-api/browserWorkingCopyService',
        })).toEqual([]);
    });

    it('keeps the aggregate platform API limited to composition points', () => {
        const aggregatePlatformApiViolation = (source: string) => [{
            rule: 'platform-api-aggregate-import',
            source,
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
            message: 'Import narrow platform capability contracts instead of the aggregate IPlatformApi contract.',
        }];

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/composables/usePdfFile.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
        })).toEqual(aggregatePlatformApiViolation('app/modules/workspace-shell/composables/usePdfFile.ts'));

        expect(checkArchitectureBoundaryEdge({
            source: 'app/utils/getViewerHostApi.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
        })).toEqual(aggregatePlatformApiViolation('app/utils/getViewerHostApi.ts'));

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/menu/registerTabsMenuBindings.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
        })).toEqual(aggregatePlatformApiViolation('app/modules/workspace-shell/menu/registerTabsMenuBindings.ts'));

        for (const source of [
            'app/platform/browserPlatformPathDescriptors.ts',
            'app/platform/browserPlatformApi.ts',
            'app/platform/lazyBrowserPlatformApi.ts',
            'app/types/electron.d.ts',
            'app/utils/platform.ts',
            'packages/contracts/electronApi.ts',
            'packages/contracts/index.ts',
        ]) {
            expect(checkArchitectureBoundaryEdge({
                source,
                target: 'packages/contracts/platformApi.ts',
                specifier: '@contracts/platformApi',
            })).toEqual([]);
        }
    });

    it('denies scripts to app imports except approved diagnostic trace type edges', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'scripts/checkSomething.ts',
            target: 'app/modules/workspace-shell/public.ts',
            specifier: '@app/modules/workspace-shell/public',
        })).toEqual([{
            rule: 'scripts-to-app',
            source: 'scripts/checkSomething.ts',
            target: 'app/modules/workspace-shell/public.ts',
            specifier: '@app/modules/workspace-shell/public',
            message: 'scripts/** must not import app runtime code; diagnostic scripts may use only approved app trace/test types.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'scripts/diagnostics/pdfTraceEntryGuards.ts',
            target: 'app/utils/logPdfNav.ts',
            specifier: '@app/utils/logPdfNav',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'scripts/diagnostics/pdfTraceEntryGuards.ts',
            target: 'app/modules/workspace-shell/public.ts',
            specifier: '@app/modules/workspace-shell/public',
        })).toEqual([{
            rule: 'scripts-to-app',
            source: 'scripts/diagnostics/pdfTraceEntryGuards.ts',
            target: 'app/modules/workspace-shell/public.ts',
            specifier: '@app/modules/workspace-shell/public',
            message: 'scripts/** must not import app runtime code; diagnostic scripts may use only approved app trace/test types.',
        }]);
    });

    it('denies production runtime imports from scripts while allowing shared contracts', () => {
        for (const violation of [
            {
                source: 'app/composables/useStartup.ts',
                rule: 'app-to-scripts',
                message: 'App runtime code must not import scripts/** tooling; move shared contracts into packages/**.',
            },
            {
                source: 'electron/bootstrap/runInitSequence.ts',
                rule: 'electron-to-scripts',
                message: 'Electron runtime code must not import scripts/** tooling; move shared contracts into packages/**.',
            },
            {
                source: 'packages/contracts/startup.ts',
                rule: 'packages-to-scripts',
                message: 'Shared runtime packages must not import scripts/** tooling; keep shared contracts inside packages/**.',
            },
        ]) {
            expect(checkArchitectureBoundaryEdge({
                source: violation.source,
                target: 'scripts/releaseVerificationHelpers.ts',
                specifier: '@scripts/releaseVerificationHelpers',
            })).toEqual([{
                rule: violation.rule,
                source: violation.source,
                target: 'scripts/releaseVerificationHelpers.ts',
                specifier: '@scripts/releaseVerificationHelpers',
                message: violation.message,
            }]);
        }

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/bootstrap/runInitSequence.ts',
            target: 'packages/contracts/packagedStartupReadyMarker.ts',
            specifier: '@contracts/packagedStartupReadyMarker',
        })).toEqual([]);
    });

    it('enforces workspace package dependency layers', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'packages/contracts/settings.ts',
            target: 'packages/i18n-core/index.ts',
            specifier: '@i18n-core',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'packages/contracts/settings.ts',
            target: 'packages/pdf-core/index.ts',
            specifier: '@pdf-core',
        })).toEqual([{
            rule: 'packages-contracts-layer',
            source: 'packages/contracts/settings.ts',
            target: 'packages/pdf-core/index.ts',
            specifier: '@pdf-core',
            message: 'packages/contracts may depend only on itself and i18n-core leaf utilities.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'packages/pdf-core/pdfSearchCore.ts',
            target: 'packages/contracts/search.ts',
            specifier: '@contracts/search',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'packages/i18n-app/index.ts',
            target: 'packages/contracts/index.ts',
            specifier: '@contracts',
        })).toEqual([
            {
                rule: 'packages-i18n-app-layer',
                source: 'packages/i18n-app/index.ts',
                target: 'packages/contracts/index.ts',
                specifier: '@contracts',
                message: 'packages/i18n-app may depend only on itself and i18n-core.',
            },
            {
                rule: 'packages-contracts-reverse-edge',
                source: 'packages/i18n-app/index.ts',
                target: 'packages/contracts/index.ts',
                specifier: '@contracts',
                message: 'Only approved leaf packages may depend on contracts; do not add reverse package edges into contracts.',
            },
        ]);
    });

    it('keeps current workspace package layer imports clean', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: [
                'packages/contracts',
                'packages/pdf-core',
                'packages/electron-worker-bundles',
                'packages/i18n-core',
                'packages/i18n-app',
                'packages/release-selection',
            ],
        });
        const packageLayerRules = new Set([
            'packages-contracts-layer',
            'packages-pdf-core-layer',
            'packages-i18n-core-layer',
            'packages-i18n-app-layer',
            'packages-release-selection-layer',
            'packages-electron-worker-bundles-layer',
            'packages-contracts-reverse-edge',
        ]);
        const violations = graph.edges
            .flatMap(checkArchitectureBoundaryEdge)
            .filter((violation: { rule: string }) => packageLayerRules.has(violation.rule));

        expect(violations).toEqual([]);
    });

    it('blocks app production calls to the aggregate platform runtime getter', () => {
        const runtimeGetterViolation = (source: string) => [{
            rule: 'platform-api-runtime-getter',
            source,
            target: 'app/utils/platform.ts',
            specifier: '@app/utils/platform#getPlatformAPI',
            message: 'App code must use a narrow platform capability getter instead of calling getPlatformAPI() directly.',
        }];

        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/usePlatformEscape.ts',
            'import { getPlatformAPI } from \'@app/utils/platform\';\nexport function readShell() {\n    return getPlatformAPI().shell;\n}\n',
        )).toEqual(runtimeGetterViolation('app/modules/workspace-shell/composables/usePlatformEscape.ts'));

        expect(checkArchitectureBoundarySource(
            'app/utils/getAgentCapability.ts',
            'import { getPlatformAPI } from \'@app/utils/platform\';\nexport function getAgentCapability() {\n    return getPlatformAPI().agent;\n}\n',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/usePlatformText.ts',
            'import { getPlatformAPI } from \'@app/utils/platform\';\nconst label = \'getPlatformAPI()\';\n// getPlatformAPI()\nexport const getterName = getPlatformAPI.name;\n',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'app/utils/platform.ts',
            'export function getPlatformAPI() {\n    return window.electronAPI;\n}\n',
        )).toEqual([]);
    });

    it('blocks production imports of compatibility policy from contracts', () => {
        const policyViolation = (source: string, target: string, specifier: string) => [{
            rule: 'contract-compat-policy-import',
            source,
            target,
            specifier,
            message: 'Production app/electron code must import moved search and native PDF policy from @pdf-core or the owning Electron feature, not contract compatibility modules.',
        }];

        expect(checkArchitectureBoundarySource(
            'app/platform/browser-api/createBrowserSearchCapability.ts',
            'import { buildPdfSearchRegex } from \'@contracts/search\';\nexport const regex = buildPdfSearchRegex;\n',
        )).toEqual(policyViolation(
            'app/platform/browser-api/createBrowserSearchCapability.ts',
            '@contracts/search',
            'buildPdfSearchRegex',
        ));

        expect(checkArchitectureBoundarySource(
            'electron/features/documents/createDocumentsPreloadFileClient.ts',
            'import { normalizePdfNativeMutationSet } from \'@contracts/nativePdfMutations\';\nexport const normalize = normalizePdfNativeMutationSet;\n',
        )).toEqual(policyViolation(
            'electron/features/documents/createDocumentsPreloadFileClient.ts',
            '@contracts/nativePdfMutations',
            'normalizePdfNativeMutationSet',
        ));

        expect(checkArchitectureBoundarySource(
            'electron/features/search/main/ipc.ts',
            'import { normalizePdfSearchRequestPayload } from \'@contracts\';\nexport const normalize = normalizePdfSearchRequestPayload;\n',
        )).toEqual(policyViolation(
            'electron/features/search/main/ipc.ts',
            '@contracts',
            'normalizePdfSearchRequestPayload',
        ));

        expect(checkArchitectureBoundarySource(
            'electron/features/search/main/ipc.ts',
            'import * as searchContracts from \'@contracts/search\';\nexport const normalize = searchContracts.normalizePdfSearchRequestPayload;\n',
        )).toEqual(policyViolation(
            'electron/features/search/main/ipc.ts',
            '@contracts/search',
            '*',
        ));

        expect(checkArchitectureBoundarySource(
            'app/platform/browser-api/public.ts',
            'export { buildPdfSearchRegex } from \'@contracts/search\';\n',
        )).toEqual(policyViolation(
            'app/platform/browser-api/public.ts',
            '@contracts/search',
            'buildPdfSearchRegex',
        ));

        expect(checkArchitectureBoundarySource(
            'app/platform/browser-api/public.ts',
            'export * from \'@contracts/nativePdfMutations\';\n',
        )).toEqual(policyViolation(
            'app/platform/browser-api/public.ts',
            '@contracts/nativePdfMutations',
            '*',
        ));

        expect(checkArchitectureBoundarySource(
            'app/components/document-viewer/DocumentSearchBar.vue',
            '<script setup lang="ts">\nimport type { IResolvedSearchMatchOptions } from \'@contracts/search\';\nconst options = {} as IResolvedSearchMatchOptions;\n</script>\n',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'tests/unit/contracts/search.test.ts',
            'import { findPdfSearchMatches } from \'@contracts/search\';\nexpect(findPdfSearchMatches).toBeDefined();\n',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'packages/contracts/index.ts',
            'export { normalizePdfNativeMutationSet } from \'@contracts/nativePdfMutations\';\n',
        )).toEqual([]);
    });

    it('blocks PDF viewer engine imports back to runtime module layers', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/pdf-viewer/engine/pdf-rerender-restoration/createPdfRerenderRestorationLogger.ts',
            target: 'app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol.ts',
            specifier: '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol',
        })).toEqual([{
            rule: 'pdf-viewer-engine-layer-back-edge',
            source: 'app/modules/pdf-viewer/engine/pdf-rerender-restoration/createPdfRerenderRestorationLogger.ts',
            target: 'app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol.ts',
            specifier: '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol',
            message: 'PDF viewer engine code must not import runtime, component, tool, or public module layers; move pure contracts/helpers into engine.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/pdf-viewer/engine/pdf-search-match-scroller/createPdfSearchMatchScroller.ts',
            target: 'app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses.ts',
            specifier: '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol.ts',
            target: 'app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocolTypes.ts',
            specifier: '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocolTypes',
        })).toEqual([]);
    });

    it('keeps current PDF viewer engine imports inside allowed module layers', {timeout: 20_000}, async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ['app/modules/pdf-viewer'],
        });

        const engineLayerViolations = graph.edges
            .flatMap(checkArchitectureBoundaryEdge)
            .filter((violation: { rule: string }) => violation.rule === 'pdf-viewer-engine-layer-back-edge');

        expect(engineLayerViolations).toEqual([]);
    });

    it('keeps legacy Electron feature re-export shims thin', () => {
        expect(checkArchitectureBoundarySource(
            'electron/djvu/convert.ts',
            'export * from \'@electron/features/djvu/public\';\n',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'electron/search/protocol.ts',
            'export type * from \'@electron/features/search/protocol\';\n',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'electron/djvu/convert.ts',
            'import { convertDjvuToPdfFile } from \'@electron/features/djvu/public\';\nexport { convertDjvuToPdfFile };\n',
        )).toEqual([{
            rule: 'electron-legacy-feature-reexport-shim',
            source: 'electron/djvu/convert.ts',
            target: 'electron/djvu/convert.ts',
            specifier: 'source',
            message: 'Legacy Electron feature shims must stay one-line re-exports to their feature entrypoint.',
        }]);

        expect(checkArchitectureBoundarySource(
            'electron/search/protocol.ts',
            'export * from \'@electron/features/search/protocol\';\n',
        )).toEqual([{
            rule: 'electron-legacy-feature-reexport-shim',
            source: 'electron/search/protocol.ts',
            target: 'electron/search/protocol.ts',
            specifier: 'source',
            message: 'Legacy Electron feature shims must stay one-line re-exports to their feature entrypoint.',
        }]);
    });

    it('allows worker-safe Electron feature publicNative entrypoints but still blocks main internals', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'electron/djvu/embedBookmarksIntoPdfFile.ts',
            target: 'electron/features/page-ops/publicNative.ts',
            specifier: '@electron/features/page-ops/publicNative',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/djvu/embedBookmarksIntoPdfFile.ts',
            target: 'electron/features/page-ops/main/nativeCrop.ts',
            specifier: '@electron/features/page-ops/main/nativeCrop',
        })).toEqual([{
            rule: 'electron-feature-main-private',
            source: 'electron/djvu/embedBookmarksIntoPdfFile.ts',
            target: 'electron/features/page-ops/main/nativeCrop.ts',
            specifier: '@electron/features/page-ops/main/nativeCrop',
            message: 'Electron feature main internals must be consumed through feature public or service entrypoints.',
        }]);
    });

    it('locks Finding 7 native-tool ownership boundaries', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'electron/native-tools/resolveNativeToolsBase.ts',
            target: 'electron/ocr/resolveOcrResourcesBase.ts',
            specifier: '@electron/ocr/resolveOcrResourcesBase',
        })).toEqual([{
            rule: 'native-tools-domain-import',
            source: 'electron/native-tools/resolveNativeToolsBase.ts',
            target: 'electron/ocr/resolveOcrResourcesBase.ts',
            specifier: '@electron/ocr/resolveOcrResourcesBase',
            message: 'Generic native-tool code must not import OCR, PDF, or DjVu domain modules.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/native-tools/getNativeToolBinaryPath.ts',
            target: 'electron/pdf/nativeToolPaths.ts',
            specifier: '@electron/pdf/nativeToolPaths',
        })).toEqual([{
            rule: 'native-tools-domain-import',
            source: 'electron/native-tools/getNativeToolBinaryPath.ts',
            target: 'electron/pdf/nativeToolPaths.ts',
            specifier: '@electron/pdf/nativeToolPaths',
            message: 'Generic native-tool code must not import OCR, PDF, or DjVu domain modules.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/features/image-export/main/export.ts',
            target: 'electron/ocr/worker/dpiDetection.ts',
            specifier: '@electron/ocr/worker/dpiDetection',
        })).toEqual([{
            rule: 'ocr-native-tool-boundary-import',
            source: 'electron/features/image-export/main/export.ts',
            target: 'electron/ocr/worker/dpiDetection.ts',
            specifier: '@electron/ocr/worker/dpiDetection',
            message: 'Non-OCR Electron code must not import OCR-owned native-tool, resource, or DPI helpers.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/features/ocr/main/ocrOperations.ts',
            target: 'electron/ocr/paths.ts',
            specifier: '@electron/ocr/paths',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/features/image-export/main/export.ts',
            target: 'electron/image/imageDpi.ts',
            specifier: '@electron/image/imageDpi',
        })).toEqual([]);
    });

    it('keeps current Electron native-tool ownership imports clean', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ['electron'],
        });
        const nativeToolOwnershipRules = new Set([
            'native-tools-domain-import',
            'ocr-native-tool-boundary-import',
        ]);
        const violations = graph.edges
            .flatMap(checkArchitectureBoundaryEdge)
            .filter((violation: { rule: string }) => nativeToolOwnershipRules.has(violation.rule));

        expect(violations).toEqual([]);
    });

    it('blocks direct PDF.js annotationStorage dirty-state access outside diagnostics', () => {
        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            'pdfDocument.value?.annotationStorage?.resetModified();',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            target: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage internals may only be read by the retained runtime diagnostics module.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            'const storage = document.annotationStorage;\nreturn storage?.serializable;',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            target: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage internals may only be read by the retained runtime diagnostics module.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            'const annotationStorage = document.annotationStorage;\nreturn annotationStorage["modifiedIds"];',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            target: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage internals may only be read by the retained runtime diagnostics module.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics.ts',
            'const storage = document.annotationStorage;\nreturn storage?.serializable;',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics.ts',
            'annotationStorage.onSetModified = handler;',
        )).toEqual([]);
    });

    it('keeps the annotation dependency graph explicit and acyclic', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ANNOTATION_GRAPH_SCAN_ROOTS,
        });
        const result = checkAnnotationDependencyGraph(graph, { includeDirectEdgeViolations: true });

        expect(ANNOTATION_LATE_BOUND_EDGES).toEqual([]);
        expect(result.violations).toEqual([]);
        expect(result.cycles).toEqual([]);
        expect(result.inventory.lateBoundEdges.length).toBe(ANNOTATION_LATE_BOUND_EDGES.length);
    });

    it('blocks new hidden annotation runtime/tool crossings', () => {
        expect(checkAnnotationDependencyEdge({
            source: 'app/modules/pdf-viewer/tools/usePdfShapeTool.ts',
            target: 'app/modules/pdf-viewer/runtime/annotations/fixtureRuntime.ts',
            specifier: '@app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud',
        })).toEqual([{
            rule: 'annotation-tools-to-runtime',
            source: 'app/modules/pdf-viewer/tools/usePdfShapeTool.ts',
            target: 'app/modules/pdf-viewer/runtime/annotations/fixtureRuntime.ts',
            specifier: '@app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud',
            message: 'PDF annotation tools must not import runtime annotation composables; share pure helpers through engine/types ports.',
        }]);

        expect(checkAnnotationDependencyEdge({
            source: 'app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes.ts',
            target: 'app/modules/pdf-viewer/tools/useAnnotationShapes.ts',
            specifier: '@app/modules/pdf-viewer/tools/useAnnotationShapes',
        })).toEqual([{
            rule: 'annotation-runtime-to-tools',
            source: 'app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes.ts',
            target: 'app/modules/pdf-viewer/tools/useAnnotationShapes.ts',
            specifier: '@app/modules/pdf-viewer/tools/useAnnotationShapes',
            message: 'Runtime annotation composables may only compose tools through the explicit shape-tool boundary.',
        }]);

        expect(checkAnnotationDependencyEdge({
            source: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            target: 'app/modules/pdf-viewer/runtime/save/nativeMutationProjection.ts',
            specifier: '@app/modules/pdf-viewer/runtime/save/nativeMutationProjection',
        })).toEqual([{
            rule: 'annotation-save-public-entrypoint',
            source: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            target: 'app/modules/pdf-viewer/runtime/save/nativeMutationProjection.ts',
            specifier: '@app/modules/pdf-viewer/runtime/save/nativeMutationProjection',
            message: 'Annotation save internals must be consumed through app/modules/pdf-viewer/public.',
        }]);
    });

    it('reports annotation cycle paths for negative fixtures', () => {
        const fixtureGraph = { edges: [
            {
                source: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
                target: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight.ts',
                specifier: 'fixture-crud-to-highlight',
            },
            {
                source: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight.ts',
                target: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
                specifier: 'fixture-highlight-to-crud',
            },
        ] };
        const result = checkAnnotationDependencyGraph(fixtureGraph, { includeKnownLateBoundEdges: false });

        expect(result.violations).toEqual([{
            rule: 'annotation-dependency-cycle',
            source: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
            target: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight.ts',
            specifier: 'direct import / late-bound annotation dependency graph',
            message: 'Disallowed annotation dependency cycle: app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts -> app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight.ts -> app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
        }]);
    });
});
