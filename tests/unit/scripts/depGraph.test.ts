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
    it('runs the workspace format-comparison rule for the whole workspace shell', () => {
        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/viewers/legacyDriver.ts',
            'const usesDjvu = driver.id === \'djvu\';\n',
        )).toEqual([{
            rule: 'workspace-format-comparison',
            source: 'app/modules/workspace-shell/viewers/legacyDriver.ts',
            target: 'app/modules/workspace-shell/viewers/legacyDriver.ts:1:18',
            specifier: 'driver.id',
            message: 'Format comparison on driver.id uses "djvu".',
        }]);
        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/useWorkspaceShell.ts',
            'const usesDjvu = driver.id === \'djvu\';\n',
        )).toEqual([{
            rule: 'workspace-format-comparison',
            source: 'app/modules/workspace-shell/composables/useWorkspaceShell.ts',
            target: 'app/modules/workspace-shell/composables/useWorkspaceShell.ts:1:18',
            specifier: 'driver.id',
            message: 'Format comparison on driver.id uses "djvu".',
        }]);
    });

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

    it('resolves canonical workspace package aliases into package graph edges', async () => {
        const projectRoot = await createTemporaryProjectRoot();
        await mkdir(join(projectRoot, 'app'), { recursive: true });
        await mkdir(join(projectRoot, 'packages/contracts'), { recursive: true });
        await mkdir(join(projectRoot, 'packages/i18n-core'), { recursive: true });
        await writeFile(
            join(projectRoot, 'app/usesContracts.ts'),
            'import { contract } from \'@contracts/contract\';\nexport const appContract = contract;\n',
        );
        await writeFile(join(projectRoot, 'packages/contracts/contract.ts'), 'export const contract = true;\n');
        await writeFile(
            join(projectRoot, 'packages/i18n-core/index.ts'),
            'import { format } from \'@i18n-core/messageFormat\';\nexport const i18n = format;\n',
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
                specifier: '@contracts/contract',
                target: 'packages/contracts/contract.ts',
            },
            {
                source: 'packages/i18n-core/index.ts',
                specifier: '@i18n-core/messageFormat',
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
            'packages/contracts/electronApi.ts',
        ]) {
            expect(checkArchitectureBoundaryEdge({
                source,
                target: 'packages/contracts/documentRef.ts',
                specifier: '@contracts/documentRef',
            })).toEqual([]);
        }
    });

    it('denies scripts to app imports while allowing shared contracts', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'scripts/checkSomething.ts',
            target: 'app/modules/workspace-shell/public.ts',
            specifier: '@app/modules/workspace-shell/public',
        })).toEqual([{
            rule: 'scripts-to-app',
            source: 'scripts/checkSomething.ts',
            target: 'app/modules/workspace-shell/public.ts',
            specifier: '@app/modules/workspace-shell/public',
            message: 'scripts/** must not import app runtime code; shared diagnostic contracts belong in packages/contracts.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'scripts/diagnostics/pdfTraceEntryGuards.ts',
            target: 'app/utils/logPdfNav.ts',
            specifier: '@app/utils/logPdfNav',
        })).toEqual([{
            rule: 'scripts-to-app',
            source: 'scripts/diagnostics/pdfTraceEntryGuards.ts',
            target: 'app/utils/logPdfNav.ts',
            specifier: '@app/utils/logPdfNav',
            message: 'scripts/** must not import app runtime code; shared diagnostic contracts belong in packages/contracts.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'scripts/diagnostics/pdfTraceEntryGuards.ts',
            target: 'packages/contracts/pdfDiagnostics.ts',
            specifier: '@contracts/pdfDiagnostics',
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
            message: 'scripts/** must not import app runtime code; shared diagnostic contracts belong in packages/contracts.',
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
            target: 'packages/contracts/documentRef.ts',
            specifier: '@contracts/documentRef',
        })).toEqual([
            {
                rule: 'packages-i18n-app-layer',
                source: 'packages/i18n-app/index.ts',
                target: 'packages/contracts/documentRef.ts',
                specifier: '@contracts/documentRef',
                message: 'packages/i18n-app may depend only on itself and i18n-core.',
            },
            {
                rule: 'packages-contracts-reverse-edge',
                source: 'packages/i18n-app/index.ts',
                target: 'packages/contracts/documentRef.ts',
                specifier: '@contracts/documentRef',
                message: 'Only approved leaf packages may depend on contracts; do not add reverse package edges into contracts.',
            },
        ]);
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

    it('allows worker-safe Electron feature publicNative entrypoints but still blocks main internals', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'electron/features/djvu/main/embedBookmarksIntoPdfFile.ts',
            target: 'electron/features/page-ops/publicNative.ts',
            specifier: '@electron/features/page-ops/publicNative',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/features/djvu/main/embedBookmarksIntoPdfFile.ts',
            target: 'electron/features/page-ops/main/nativeCrop.ts',
            specifier: '@electron/features/page-ops/main/nativeCrop',
        })).toEqual([
            {
                rule: 'electron-cross-feature-deep-import',
                source: 'electron/features/djvu/main/embedBookmarksIntoPdfFile.ts',
                target: 'electron/features/page-ops/main/nativeCrop.ts',
                specifier: '@electron/features/page-ops/main/nativeCrop',
                message: 'Cross-feature imports in electron/features must use public entrypoints only.',
            },
            {
                rule: 'electron-feature-main-private',
                source: 'electron/features/djvu/main/embedBookmarksIntoPdfFile.ts',
                target: 'electron/features/page-ops/main/nativeCrop.ts',
                specifier: '@electron/features/page-ops/main/nativeCrop',
                message: 'Electron feature main internals must be consumed through feature public or service entrypoints.',
            },
        ]);
    });

    it('locks Finding 7 native-tool ownership boundaries', () => {
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
            target: 'electron/features/ocr/worker/dpiDetection.ts',
            specifier: '@electron/features/ocr/worker/dpiDetection',
        })).toEqual([
            {
                rule: 'electron-cross-feature-deep-import',
                source: 'electron/features/image-export/main/export.ts',
                target: 'electron/features/ocr/worker/dpiDetection.ts',
                specifier: '@electron/features/ocr/worker/dpiDetection',
                message: 'Cross-feature imports in electron/features must use public entrypoints only.',
            },
            {
                rule: 'ocr-native-tool-boundary-import',
                source: 'electron/features/image-export/main/export.ts',
                target: 'electron/features/ocr/worker/dpiDetection.ts',
                specifier: '@electron/features/ocr/worker/dpiDetection',
                message: 'Non-OCR Electron code must not import OCR-owned native-tool, resource, or DPI helpers.',
            },
        ]);

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/features/ocr/main/ocrOperations.ts',
            target: 'electron/features/ocr/main/paths.ts',
            specifier: '@electron/features/ocr/main/paths',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'electron/features/image-export/main/export.ts',
            target: 'electron/image/imageDpi.ts',
            specifier: '@electron/image/imageDpi',
        })).toEqual([]);
    });

    it('blocks direct PDF.js annotationStorage dirty-state access', () => {
        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            'pdfDocument.value?.annotationStorage?.resetModified();',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            target: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage internals must be accessed through the public annotation diagnostics accessor.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            'const storage = document.annotationStorage;\nreturn storage?.serializable;',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            target: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage internals must be accessed through the public annotation diagnostics accessor.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            'const annotationStorage = document.annotationStorage;\nreturn annotationStorage["modifiedIds"];',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            target: 'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage internals must be accessed through the public annotation diagnostics accessor.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics.ts',
            'const storage = document.annotationStorage;\nreturn storage?.serializable;',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics.ts',
            target: 'app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage internals must be accessed through the public annotation diagnostics accessor.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/pdf-viewer/runtime/save/pdfjsAnnotationDiagnostics.ts',
            'annotationStorage.onSetModified = handler;',
        )).toEqual([]);
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
