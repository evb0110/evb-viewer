#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildDependencyGraph } from './dep-graph.mjs';

/** @typedef {import('./dep-graph.mjs').IDependencyEdge} IDependencyEdge */
/** @typedef {import('./dep-graph.mjs').IDependencyGraph} IDependencyGraph */
/** @typedef {import('./dep-graph.mjs').IArchitectureViolation} IArchitectureViolation */
/** @typedef {{source: string, target: string, label: string, kind: string, phase: string}} ILateBoundDependencyEdge */
/** @typedef {{file: string}} IAnnotationDependencyNode */
/** @typedef {{nodes: IAnnotationDependencyNode[], directEdges: IDependencyEdge[], lateBoundEdges: IDependencyEdge[]}} IAnnotationDependencyInventory */
/** @typedef {{includeKnownLateBoundEdges?: boolean, includeDirectEdgeViolations?: boolean}} IAnnotationGraphOptions */
/** @typedef {{inventory: IAnnotationDependencyInventory, cycles: string[][], violations: IArchitectureViolation[]}} IAnnotationDependencyCheckResult */

/** @type {string[]} */
export const ANNOTATION_GRAPH_SCAN_ROOTS = [
    'app/modules/pdf-viewer/runtime/annotations',
    'app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession.ts',
    'app/modules/pdf-viewer/annotations',
    'app/modules/pdf-viewer/tools',
    'app/modules/pdf-viewer/runtime/save',
    'app/modules/pdf-viewer/engine/annotations',
];

const ANNOTATION_POLICY_ROOTS = [
    ...ANNOTATION_GRAPH_SCAN_ROOTS,
    'app/modules/workspace-shell',
];

const RUNTIME_ANNOTATION_ROOT = 'app/modules/pdf-viewer/runtime/annotations';
const ANNOTATION_TOOLS_ROOT = 'app/modules/pdf-viewer/tools';
const RUNTIME_SAVE_ROOT = 'app/modules/pdf-viewer/runtime/save';
const PDF_VIEWER_MODULE_ROOT = 'app/modules/pdf-viewer';
const ANNOTATION_SESSION = 'app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession.ts';

/** @type {Set<string>} */
const RUNTIME_TOOLS_ALLOWED_EDGES = new Set();

// The deleted PDF.js editor bridge no longer contributes late-bound edges.
/** @type {ILateBoundDependencyEdge[]} */
export const ANNOTATION_LATE_BOUND_EDGES = [];

/** @param {string} filePath @param {string} root @returns {boolean} */
function matchesRoot(filePath, root) {
    return filePath === root || filePath.startsWith(`${root}/`);
}

/** @param {IDependencyEdge} edge @returns {string} */
function annotationEdgeKey(edge) {
    return `${edge.source} -> ${edge.target}`;
}

/** @param {string} filePath @returns {boolean} */
function isAnnotationPolicyNode(filePath) {
    return filePath === ANNOTATION_SESSION
        || ANNOTATION_POLICY_ROOTS.some(root => matchesRoot(filePath, root));
}

/** @param {string} filePath @returns {boolean} */
function isPdfViewerInternalSource(filePath) {
    return matchesRoot(filePath, PDF_VIEWER_MODULE_ROOT);
}

/** @param {IArchitectureViolation} options @returns {IArchitectureViolation} */
function createViolation({
    rule,
    source,
    target,
    specifier,
    message,
}) {
    return {
        rule,
        source,
        target,
        specifier,
        message,
    };
}

/** @param {ILateBoundDependencyEdge} edge @returns {IDependencyEdge} */
function toLateBoundDependencyEdge(edge) {
    return {
        source: edge.source,
        target: edge.target,
        specifier: edge.label,
        kind: edge.kind,
        phase: edge.phase,
    };
}

/** @param {string[]} cyclePath @returns {string} */
function normalizeCycleKey(cyclePath) {
    const cycle = cyclePath.slice(0, -1);
    const rotations = cycle.map((_, index) => [
        ...cycle.slice(index),
        ...cycle.slice(0, index),
    ].join(' -> '));
    return /** @type {string} */ (rotations.sort()[0]);
}

/** @param {Map<string, string[]>} adjacency @param {string} start @param {string} target @returns {string[] | null} */
function findPath(adjacency, start, target) {
    const stack = [{
        node: start,
        path: [start],
    }];
    const visited = new Set();

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || visited.has(current.node)) {
            continue;
        }
        visited.add(current.node);

        for (const next of adjacency.get(current.node) ?? []) {
            const nextPath = [
                ...current.path,
                next,
            ];
            if (next === target) {
                return nextPath;
            }
            if (!visited.has(next)) {
                stack.push({
                    node: next,
                    path: nextPath,
                });
            }
        }
    }

    return null;
}

/** @param {IDependencyEdge[]} edges @returns {string[][]} */
export function findAnnotationDependencyCyclePaths(edges) {
    const annotationEdges = edges
        .filter(edge => isAnnotationPolicyNode(edge.source) && isAnnotationPolicyNode(edge.target))
        .sort((left, right) => annotationEdgeKey(left).localeCompare(annotationEdgeKey(right)));

    const adjacency = new Map();
    for (const edge of annotationEdges) {
        if (!adjacency.has(edge.source)) {
            adjacency.set(edge.source, []);
        }
        adjacency.get(edge.source).push(edge.target);
    }
    for (const targets of adjacency.values()) {
        targets.sort();
    }

    const cycles = [];
    const seen = new Set();
    for (const edge of annotationEdges) {
        const pathToSource = findPath(adjacency, edge.target, edge.source);
        if (!pathToSource) {
            continue;
        }

        const cyclePath = [
            edge.source,
            ...pathToSource,
        ];
        const key = normalizeCycleKey(cyclePath);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        cycles.push(cyclePath);
    }

    return cycles.sort((left, right) => left.join('\n').localeCompare(right.join('\n')));
}

/** @param {IDependencyEdge} edge @returns {IArchitectureViolation[]} */
export function checkAnnotationDependencyEdge(edge) {
    if (matchesRoot(edge.source, ANNOTATION_TOOLS_ROOT) && matchesRoot(edge.target, RUNTIME_ANNOTATION_ROOT)) {
        return [createViolation({
            rule: 'annotation-tools-to-runtime',
            source: edge.source,
            target: edge.target,
            specifier: edge.specifier,
            message: 'PDF annotation tools must not import runtime annotation composables; share pure helpers through engine/types ports.',
        })];
    }

    if (
        matchesRoot(edge.source, RUNTIME_ANNOTATION_ROOT)
        && matchesRoot(edge.target, ANNOTATION_TOOLS_ROOT)
        && !RUNTIME_TOOLS_ALLOWED_EDGES.has(annotationEdgeKey(edge))
    ) {
        return [createViolation({
            rule: 'annotation-runtime-to-tools',
            source: edge.source,
            target: edge.target,
            specifier: edge.specifier,
            message: 'Runtime annotation composables may only compose tools through the explicit shape-tool boundary.',
        })];
    }

    if (
        matchesRoot(edge.target, RUNTIME_SAVE_ROOT)
        && !isPdfViewerInternalSource(edge.source)
    ) {
        return [createViolation({
            rule: 'annotation-save-public-entrypoint',
            source: edge.source,
            target: edge.target,
            specifier: edge.specifier,
            message: 'Annotation save internals must be consumed through app/modules/pdf-viewer/public.',
        })];
    }

    if (
        matchesRoot(edge.source, RUNTIME_SAVE_ROOT)
        && (
            matchesRoot(edge.target, RUNTIME_ANNOTATION_ROOT)
            || matchesRoot(edge.target, ANNOTATION_TOOLS_ROOT)
        )
    ) {
        return [createViolation({
            rule: 'annotation-save-to-runtime-tools',
            source: edge.source,
            target: edge.target,
            specifier: edge.specifier,
            message: 'Annotation save planners must stay independent from runtime annotation composables and tools.',
        })];
    }

    return [];
}

/** @param {IDependencyGraph} graph @returns {IAnnotationDependencyInventory} */
export function buildAnnotationDependencyInventory(graph) {
    const directEdges = graph.edges
        .filter(edge => isAnnotationPolicyNode(edge.source) || isAnnotationPolicyNode(edge.target))
        .sort((left, right) => annotationEdgeKey(left).localeCompare(annotationEdgeKey(right)));
    const lateBoundEdges = ANNOTATION_LATE_BOUND_EDGES
        .map(toLateBoundDependencyEdge)
        .sort((left, right) => annotationEdgeKey(left).localeCompare(annotationEdgeKey(right)));
    const nodeFiles = new Set();

    for (const edge of [
        ...directEdges,
        ...lateBoundEdges,
    ]) {
        nodeFiles.add(edge.source);
        nodeFiles.add(edge.target);
    }

    return {
        nodes: Array.from(nodeFiles).sort().map(file => ({ file })),
        directEdges,
        lateBoundEdges,
    };
}

/** @param {IDependencyGraph} graph @param {IAnnotationGraphOptions} [options] @returns {IAnnotationDependencyCheckResult} */
export function checkAnnotationDependencyGraph(
    graph,
    {
        includeKnownLateBoundEdges = true,
        includeDirectEdgeViolations = false,
    } = {},
) {
    const inventory = buildAnnotationDependencyInventory(graph);
    const checkedEdges = includeKnownLateBoundEdges
        ? [
            ...inventory.directEdges,
            ...inventory.lateBoundEdges,
        ]
        : inventory.directEdges;
    const cyclePaths = findAnnotationDependencyCyclePaths(checkedEdges);
    const cycleViolations = cyclePaths.map(cyclePath => createViolation({
        rule: 'annotation-dependency-cycle',
        source: /** @type {string} */ (cyclePath[0]),
        target: /** @type {string} */ (cyclePath[1] ?? cyclePath[0]),
        specifier: 'direct import / late-bound annotation dependency graph',
        message: `Disallowed annotation dependency cycle: ${cyclePath.join(' -> ')}`,
    }));
    const directEdgeViolations = includeDirectEdgeViolations
        ? inventory.directEdges.flatMap(checkAnnotationDependencyEdge)
        : [];

    return {
        inventory,
        cycles: cyclePaths,
        violations: [
            ...directEdgeViolations,
            ...cycleViolations,
        ],
    };
}

/** @param {string[]} argv @returns {string | null} */
function parseOutputArg(argv) {
    const outputArg = argv.find(argument => argument.startsWith('--output='));
    return outputArg ? outputArg.slice('--output='.length) : null;
}

async function runCli() {
    const output = parseOutputArg(process.argv.slice(2));
    const graph = await buildDependencyGraph({
        projectRoot: process.cwd(),
        roots: ANNOTATION_GRAPH_SCAN_ROOTS,
    });
    const result = checkAnnotationDependencyGraph(graph, { includeDirectEdgeViolations: true });
    const payload = `${JSON.stringify(result, null, 2)}\n`;

    if (output) {
        const outputPath = path.isAbsolute(output)
            ? output
            : path.join(process.cwd(), output);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, payload, 'utf8');
    } else {
        process.stdout.write(payload);
    }

    if (result.violations.length > 0) {
        console.error('Annotation dependency graph check failed.');
        for (const violation of result.violations) {
            console.error(`[${violation.rule}] ${violation.message}`);
        }
        process.exit(1);
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    runCli().catch(error => {
        console.error('[annotation-dependency-graph] Unexpected failure.');
        console.error(error);
        process.exit(1);
    });
}
