#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
    getAllArchitectureRoots,
    getFocusedArchitectureRoots,
} from '../workspace-roots.mjs';
import {
    parseArchitectureRootsArg,
    parseArchitectureScopeArg,
} from './architectureCliArgs.mjs';

const SOURCE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.vue',
];

const IGNORED_DIRECTORY_NAMES = new Set([
    'node_modules',
    '.nuxt',
    '.vercel',
    'nuxt-output',
    '.output',
    'dist',
    'dist-electron',
    '.git',
    '.idea',
    '.tmp',
    '.cache',
    'coverage',
]);

const IGNORED_PATH_SEGMENTS = new Set([
    '.pnpm',
    '.ignored',
]);

const IMPORT_PATTERNS = [
    /\bimport\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*['"]([^'"]+)['"]/gu,
    /\bexport\s+[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
];

const INTERNAL_LIKE_PREFIXES = [
    '@evb/contracts',
    '@evb/contracts/',
    '@evb/electron-worker-bundles/',
    '@evb/i18n-app',
    '@evb/i18n-app/',
    '@evb/i18n-core',
    '@evb/i18n-core/',
    '@evb/pdf-core',
    '@evb/pdf-core/',
    '@evb/releaseSelection',
    '@evb/releaseSelection/',
    '@app/',
    '@contracts',
    '@contracts/',
    '@pdf-core',
    '@pdf-core/',
    '@electron-worker-bundles/',
    '@electron/',
    '@i18n-core',
    '@i18n-core/',
    '@i18n-app',
    '@i18n-app/',
    '@releaseSelection',
    '@releaseSelection/',
    'app/',
    'electron/',
    'landing/',
    'scripts/',
    'server/',
    'packages/contracts/',
    'packages/pdf-core/',
    'packages/electron-worker-bundles/',
    'packages/i18n-core/',
    'packages/i18n-app/',
    'packages/release-selection/',
    '~/',
    '~~/',
];

const EXTERNAL_PACKAGE_SPECIFIERS = new Set(['@electron/asar']);

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function isSourceFile(filePath) {
    if (
        filePath.endsWith('.d.ts')
        || filePath.endsWith('.d.mts')
        || filePath.endsWith('.d.cts')
    ) {
        return false;
    }
    return SOURCE_EXTENSIONS.includes(path.extname(filePath));
}

function shouldSkipDirectory(relDir) {
    if (!relDir) {
        return false;
    }
    const segments = toPosixPath(relDir).split('/').filter(Boolean);
    return segments.some(segment => (
        IGNORED_DIRECTORY_NAMES.has(segment)
        || IGNORED_PATH_SEGMENTS.has(segment)
    ));
}

async function collectFiles(rootDir, relDir = '') {
    const scanDir = path.join(rootDir, relDir);
    if (!(await pathExists(scanDir))) {
        return [];
    }
    const scanTarget = await fs.stat(scanDir);
    if (scanTarget.isFile()) {
        return isSourceFile(scanDir) ? [toPosixPath(relDir)] : [];
    }

    const entries = await fs.readdir(scanDir, { withFileTypes: true });
    const files = await Promise.all(entries.map(async entry => {
        const nextRel = relDir ? path.join(relDir, entry.name) : entry.name;
        const abs = path.join(rootDir, nextRel);
        if (entry.isDirectory()) {
            if (shouldSkipDirectory(nextRel)) {
                return [];
            }
            return collectFiles(rootDir, nextRel);
        }

        if (entry.isFile() && isSourceFile(abs)) {
            return [toPosixPath(nextRel)];
        }

        return [];
    }));

    return files.flat();
}

async function assertRootsExist(projectRoot, roots) {
    const missingRoots = [];
    for (const root of roots) {
        const absoluteRoot = path.join(projectRoot, root);
        if (!(await pathExists(absoluteRoot))) {
            missingRoots.push(root);
        }
    }

    if (missingRoots.length > 0) {
        throw new Error(`Dependency graph root(s) do not exist: ${missingRoots.join(', ')}`);
    }
}

function extractImportSpecifiers(sourceText) {
    const specifiers = [];
    // The dependency graph tracks runtime/module edges. Keep JSDoc type
    // imports out of that graph, otherwise a module API reference in its own
    // type guard becomes a false self-cycle.
    const sourceWithoutBlockComments = sourceText.replace(
        /\/\*[\s\S]*?\*\//gu,
        comment => comment.replace(/[^\r\n]/gu, ' '),
    );
    for (const pattern of IMPORT_PATTERNS) {
        for (const match of sourceWithoutBlockComments.matchAll(pattern)) {
            specifiers.push(match[1]);
        }
    }
    return specifiers;
}

function extractTypeOnlyImportSpecifiers(sourceText) {
    const specifiers = [];
    const sourceWithoutBlockComments = sourceText.replace(
        /\/\*[\s\S]*?\*\//gu,
        comment => comment.replace(/[^\r\n]/gu, ' '),
    );
    const patterns = [
        /\bimport\s+type\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu,
        /\bexport\s+type\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu,
    ];
    for (const pattern of patterns) {
        for (const match of sourceWithoutBlockComments.matchAll(pattern)) {
            specifiers.push(match[1]);
        }
    }
    return specifiers;
}

function extractRuntimeImportSpecifiers(sourceText) {
    const specifiers = [];
    const sourceWithoutBlockComments = sourceText.replace(
        /\/\*[\s\S]*?\*\//gu,
        comment => comment.replace(/[^\r\n]/gu, ' '),
    );
    const patterns = [
        /\bimport\s+(?!type\b)[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu,
        /\bimport\s*['"]([^'"]+)['"]/gu,
        /\bexport\s+(?!type\b)[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    ];
    for (const pattern of patterns) {
        for (const match of sourceWithoutBlockComments.matchAll(pattern)) {
            specifiers.push(match[1]);
        }
    }
    return specifiers;
}

async function resolveWithExtensions(projectRoot, basePath, resolutionCache) {
    const cacheKey = `${projectRoot}\0${basePath}`;
    if (resolutionCache?.has(cacheKey)) {
        return resolutionCache.get(cacheKey);
    }
    const candidates = [
        basePath,
        ...SOURCE_EXTENSIONS.map(extension => `${basePath}${extension}`),
        ...SOURCE_EXTENSIONS.map(extension => path.join(basePath, `index${extension}`)),
    ];

    for (const candidate of candidates) {
        const absoluteCandidate = path.join(projectRoot, candidate);
        if (await pathExists(absoluteCandidate)) {
            const resolved = toPosixPath(candidate);
            resolutionCache?.set(cacheKey, resolved);
            return resolved;
        }
    }

    resolutionCache?.set(cacheKey, null);
    return null;
}

function isWithinRoot(filePath, root) {
    return filePath === root || filePath.startsWith(`${root}/`);
}

function getNuxtSourceRootForFile(sourceFile) {
    if (isWithinRoot(sourceFile, 'landing')) {
        return 'landing';
    }
    if (isWithinRoot(sourceFile, 'app')) {
        return 'app';
    }
    return null;
}

function isInternalLikeSpecifier(specifier) {
    if (EXTERNAL_PACKAGE_SPECIFIERS.has(specifier)) {
        return false;
    }
    return INTERNAL_LIKE_PREFIXES.some(prefix => specifier.startsWith(prefix));
}

const PACKAGE_ALIAS_RULES = [
    {
        exact: '@evb/contracts',
        prefix: '@evb/contracts/',
        exactTarget: 'packages/contracts/index',
        prefixTarget: 'packages/contracts/',
    },
    {
        exact: '@evb/pdf-core',
        prefix: '@evb/pdf-core/',
        exactTarget: 'packages/pdf-core/index',
        prefixTarget: 'packages/pdf-core/',
    },
    {
        prefix: '@evb/electron-worker-bundles/',
        prefixTarget: 'packages/electron-worker-bundles/',
    },
    {
        exact: '@evb/i18n-core',
        prefix: '@evb/i18n-core/',
        exactTarget: 'packages/i18n-core/index',
        prefixTarget: 'packages/i18n-core/',
    },
    {
        exact: '@evb/i18n-app',
        prefix: '@evb/i18n-app/',
        exactTarget: 'packages/i18n-app/index',
        prefixTarget: 'packages/i18n-app/',
    },
    {
        exact: '@evb/releaseSelection',
        prefix: '@evb/releaseSelection/',
        exactTarget: 'packages/release-selection/index',
        prefixTarget: 'packages/release-selection/',
    },
    {
        exact: '@contracts',
        prefix: '@contracts/',
        exactTarget: 'packages/contracts/index',
        prefixTarget: 'packages/contracts/',
    },
    {
        exact: '@pdf-core',
        prefix: '@pdf-core/',
        exactTarget: 'packages/pdf-core/index',
        prefixTarget: 'packages/pdf-core/',
    },
    {
        prefix: '@electron-worker-bundles/',
        prefixTarget: 'packages/electron-worker-bundles/',
    },
    {
        exact: '@i18n-core',
        prefix: '@i18n-core/',
        exactTarget: 'packages/i18n-core/index',
        prefixTarget: 'packages/i18n-core/',
    },
    {
        exact: '@i18n-app',
        prefix: '@i18n-app/',
        exactTarget: 'packages/i18n-app/index',
        prefixTarget: 'packages/i18n-app/',
    },
    {
        exact: '@releaseSelection',
        prefix: '@releaseSelection/',
        exactTarget: 'packages/release-selection/index',
        prefixTarget: 'packages/release-selection/',
    },
    {
        prefix: '@app/',
        prefixTarget: 'app/',
    },
    {
        prefix: '@electron/',
        prefixTarget: 'electron/',
    },
    {
        prefix: '@scripts/',
        prefixTarget: 'scripts/',
    },
    {
        prefix: '@server/',
        prefixTarget: 'server/',
    },
    {
        prefix: '@tests/',
        prefixTarget: 'tests/',
    },
];

const ROOT_SPECIFIER_PREFIXES = [
    'app/',
    'electron/',
    'landing/',
    'scripts/',
    'server/',
    'tests/',
    'packages/contracts/',
    'packages/pdf-core/',
    'packages/electron-worker-bundles/',
    'packages/i18n-core/',
    'packages/i18n-app/',
    'packages/release-selection/',
];

function resolvePackageAliasSpecifier(projectRoot, specifier, resolutionCache) {
    const aliasRule = PACKAGE_ALIAS_RULES.find(rule => (
        specifier === rule.exact
        || (rule.prefix && specifier.startsWith(rule.prefix))
    ));
    if (!aliasRule) {
        return null;
    }

    const candidate = specifier === aliasRule.exact
        ? aliasRule.exactTarget
        : specifier.replace(aliasRule.prefix, aliasRule.prefixTarget);
    return resolveWithExtensions(projectRoot, candidate, resolutionCache);
}

function resolveNuxtAliasSpecifier(projectRoot, sourceFile, specifier, resolutionCache) {
    const sourceRoot = getNuxtSourceRootForFile(sourceFile);
    if (!sourceRoot) {
        return null;
    }

    if (specifier.startsWith('~/')) {
        const target = sourceRoot === 'landing'
            ? `landing/app/${specifier.slice(2)}`
            : `app/${specifier.slice(2)}`;
        return resolveWithExtensions(projectRoot, target, resolutionCache);
    }

    if (specifier.startsWith('~~/')) {
        const target = sourceRoot === 'landing'
            ? `landing/${specifier.slice(3)}`
            : specifier.slice(3);
        return resolveWithExtensions(projectRoot, target, resolutionCache);
    }

    return null;
}

function resolveRelativeSpecifier(projectRoot, sourceFile, specifier, resolutionCache) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        return null;
    }

    const sourceDir = path.dirname(sourceFile);
    const resolved = toPosixPath(path.normalize(path.join(sourceDir, specifier)));
    return resolveWithExtensions(projectRoot, resolved, resolutionCache);
}

function resolveRootSpecifier(projectRoot, specifier, resolutionCache) {
    return ROOT_SPECIFIER_PREFIXES.some(prefix => specifier.startsWith(prefix))
        ? resolveWithExtensions(projectRoot, specifier, resolutionCache)
        : null;
}

async function resolveSpecifier({
    sourceFile,
    specifier,
    projectRoot,
    resolutionCache,
}) {
    const resolvedPackageAlias = await resolvePackageAliasSpecifier(projectRoot, specifier, resolutionCache);
    if (resolvedPackageAlias) {
        return resolvedPackageAlias;
    }

    const resolvedNuxtAlias = await resolveNuxtAliasSpecifier(
        projectRoot,
        sourceFile,
        specifier,
        resolutionCache,
    );
    if (resolvedNuxtAlias) {
        return resolvedNuxtAlias;
    }

    const resolvedRelative = await resolveRelativeSpecifier(
        projectRoot,
        sourceFile,
        specifier,
        resolutionCache,
    );
    if (resolvedRelative) {
        return resolvedRelative;
    }

    return resolveRootSpecifier(projectRoot, specifier, resolutionCache);
}

function collectRootsFromArgv(argv, {projectRoot}) {
    const roots = parseArchitectureRootsArg(argv);
    if (!roots) {
        return parseArchitectureScopeArg(argv) === 'focused'
            ? getFocusedArchitectureRoots({ projectRoot })
            : getAllArchitectureRoots({ projectRoot });
    }

    return roots;
}

function parseOutputArg(argv) {
    const outputArg = argv.find(argument => argument.startsWith('--output='));
    return outputArg ? outputArg.slice('--output='.length) : null;
}

function parseFormatArg(argv) {
    const formatArg = argv.find(argument => argument.startsWith('--format='));
    if (!formatArg) {
        return 'json';
    }

    const format = formatArg.slice('--format='.length).toLowerCase();
    return format === 'md' ? 'md' : 'json';
}

function isInternalPath(filePath, internalRoots) {
    return internalRoots.some(root => filePath === root || filePath.startsWith(`${root}/`));
}

function toMarkdown(graph) {
    const lines = [
        '# Dependency Graph',
        '',
        `- Generated: ${new Date().toISOString()}`,
        `- Nodes: ${graph.nodes.length}`,
        `- Edges: ${graph.edges.length}`,
        `- Cycles: ${graph.cycles.length}`,
        '',
        '## Edges',
    ];

    for (const edge of graph.edges) {
        lines.push(`- \`${edge.source}\` -> \`${edge.target}\` (\`${edge.specifier}\`)`);
    }

    return `${lines.join('\n')}\n`;
}

export function findStronglyConnectedComponents(nodes, edges) {
    const nodeFiles = new Set(nodes.map(node => node.file));
    for (const edge of edges) {
        nodeFiles.add(edge.source);
        nodeFiles.add(edge.target);
    }

    const adjacency = new Map(Array.from(nodeFiles, file => [
        file,
        [],
    ]));
    for (const edge of edges) {
        adjacency.get(edge.source)?.push(edge.target);
    }

    let nextIndex = 0;
    const indexes = new Map();
    const lowlinks = new Map();
    const stack = [];
    const onStack = new Set();
    const components = [];

    function visit(file) {
        indexes.set(file, nextIndex);
        lowlinks.set(file, nextIndex);
        nextIndex += 1;
        stack.push(file);
        onStack.add(file);

        for (const target of adjacency.get(file) ?? []) {
            if (!indexes.has(target)) {
                visit(target);
                lowlinks.set(file, Math.min(lowlinks.get(file), lowlinks.get(target)));
                continue;
            }
            if (onStack.has(target)) {
                lowlinks.set(file, Math.min(lowlinks.get(file), indexes.get(target)));
            }
        }

        if (lowlinks.get(file) !== indexes.get(file)) {
            return;
        }

        const component = [];
        while (stack.length > 0) {
            const member = stack.pop();
            onStack.delete(member);
            component.push(member);
            if (member === file) {
                break;
            }
        }
        components.push(component.sort());
    }

    for (const file of Array.from(nodeFiles).sort()) {
        if (!indexes.has(file)) {
            visit(file);
        }
    }

    const selfLoopFiles = new Set(edges
        .filter(edge => edge.source === edge.target)
        .map(edge => edge.source));

    return components
        .filter(component => component.length > 1 || selfLoopFiles.has(component[0]))
        .sort((a, b) => a[0].localeCompare(b[0]));
}

export async function buildDependencyGraph({
    projectRoot = process.cwd(),
    roots = getAllArchitectureRoots({ projectRoot }),
} = {}) {
    const normalizedRoots = roots.map(root => toPosixPath(path.normalize(root)));
    const internalRoots = getAllArchitectureRoots({ projectRoot });
    await assertRootsExist(projectRoot, normalizedRoots);
    const files = (
        await Promise.all(normalizedRoots.map(root => collectFiles(projectRoot, root)))
    )
        .flat()
        .sort();

    const nodes = [];
    const edges = [];
    const runtimeEdges = [];
    const unresolvedInternalImports = [];
    const resolutionCache = new Map();

    for (const file of files) {
        const absFile = path.join(projectRoot, file);
        const sourceText = await fs.readFile(absFile, 'utf8');
        const imports = extractImportSpecifiers(sourceText);
        const typeOnlyImportSpecifiers = new Set(extractTypeOnlyImportSpecifiers(sourceText));
        const runtimeImportSpecifiers = new Set(extractRuntimeImportSpecifiers(sourceText));
        const resolvedImports = await Promise.all(imports.map(async specifier => {
            const target = await resolveSpecifier({
                sourceFile: file,
                specifier,
                projectRoot,
                resolutionCache,
            });
            return {
                specifier,
                target,
            };
        }));

        const internalImports = resolvedImports.filter(
            entry => entry.target && isInternalPath(entry.target, internalRoots),
        );
        const node = {
            file,
            imports: internalImports,
        };
        Object.defineProperty(node, 'sourceText', {
            enumerable: false,
            value: sourceText,
        });
        nodes.push(node);

        for (const item of resolvedImports) {
            if (item.target) {
                continue;
            }
            if (!isInternalLikeSpecifier(item.specifier)) {
                continue;
            }
            unresolvedInternalImports.push({
                source: file,
                specifier: item.specifier,
            });
        }

        for (const item of internalImports) {
            const edge = {
                source: file,
                target: item.target,
                specifier: item.specifier,
            };
            edges.push(edge);
            if (
                !typeOnlyImportSpecifiers.has(item.specifier)
                || runtimeImportSpecifiers.has(item.specifier)
            ) {
                runtimeEdges.push(edge);
            }
        }
    }

    return {
        nodes,
        edges,
        cycles: findStronglyConnectedComponents(nodes, runtimeEdges).map(files => ({ files })),
        unresolvedInternalImports,
    };
}

async function runCli() {
    const argv = process.argv.slice(2);
    const projectRoot = process.cwd();
    const roots = collectRootsFromArgv(argv, { projectRoot });
    const output = parseOutputArg(argv);
    const format = parseFormatArg(argv);

    const graph = await buildDependencyGraph({
        projectRoot,
        roots,
    });

    const payload = format === 'md'
        ? toMarkdown(graph)
        : `${JSON.stringify(graph, null, 2)}\n`;

    if (output) {
        const outputPath = path.isAbsolute(output)
            ? output
            : path.join(projectRoot, output);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, payload, 'utf8');
    } else {
        process.stdout.write(payload);
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    runCli().catch(error => {
        console.error('[dep-graph] Failed to build dependency graph.');
        console.error(error);
        process.exit(1);
    });
}
