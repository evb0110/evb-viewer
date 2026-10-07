import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const BULK_AUDIT_PNPM_VERSION = '11.13.1';
const AUDIT_SEVERITIES = [
    'info',
    'low',
    'moderate',
    'high',
    'critical',
] as const;

type TAuditSeverity = typeof AUDIT_SEVERITIES[number];

interface IAuditSummary {
    counts: Record<TAuditSeverity, number>;
    total: number;
}

interface IAuditAdvisories {
    fixable: string[];
    unpatched: string[];
}

interface IAuditProject {
    cwd: string;
    label: string;
    scope: 'all' | 'prod';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseAuditReport(source: string, label: string) {
    let report: unknown;

    try {
        report = JSON.parse(source) as unknown;
    } catch (error) {
        throw new Error(`${label} pnpm audit did not return valid JSON.`, {cause: error});
    }

    if (!isRecord(report)) {
        throw new Error(`${label} pnpm audit report must be an object.`);
    }

    return report;
}

export function shouldUseBulkAuditFallback(source: unknown) {
    return typeof source === 'string'
        && source.includes('ERR_PNPM_AUDIT_BAD_RESPONSE')
        && source.includes('endpoint is being retired');
}

export function summarizeProductionAuditReport(report: unknown, label = 'project'): IAuditSummary {
    if (!isRecord(report)) {
        throw new Error(`${label} pnpm audit report must be an object.`);
    }

    const metadata = report.metadata;
    if (!isRecord(metadata)) {
        throw new Error(`${label} pnpm audit report is missing metadata.vulnerabilities.`);
    }
    const vulnerabilities = metadata.vulnerabilities;
    if (!isRecord(vulnerabilities)) {
        throw new Error(`${label} pnpm audit report is missing metadata.vulnerabilities.`);
    }

    const muted = report.muted;
    if (Array.isArray(muted) && muted.length > 0) {
        throw new Error(`${label} pnpm audit report contains ${muted.length} muted advisories; checked-in audit policy does not permit hidden production vulnerabilities.`);
    }

    const counts = Object.fromEntries(AUDIT_SEVERITIES.map((severity) => {
        const count = vulnerabilities[severity];
        if (!Number.isSafeInteger(count) || Number(count) < 0) {
            throw new Error(`${label} pnpm audit report has an invalid ${severity} vulnerability count.`);
        }

        return [
            severity,
            Number(count),
        ];
    })) as Record<TAuditSeverity, number>;

    return {
        counts,
        total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    };
}

// pnpm writes this range when an advisory has no patched release.
const NO_PATCHED_RELEASE = '<0.0.0';

function describeAdvisory(advisory: Record<string, unknown>) {
    const id = advisory.github_advisory_id ?? advisory.id;
    const patched = typeof advisory.patched_versions === 'string' ? advisory.patched_versions : 'unknown';
    return `${String(advisory.module_name)} ${String(advisory.severity)} ${String(id)} (patched: ${patched})`;
}

export function partitionAuditAdvisories(report: unknown, label = 'project'): IAuditAdvisories {
    const advisories = isRecord(report) ? report.advisories : undefined;
    if (!isRecord(advisories)) {
        throw new Error(`${label} pnpm audit report is missing advisories.`);
    }

    const partition: IAuditAdvisories = {
        fixable: [],
        unpatched: [],
    };
    for (const advisory of Object.values(advisories)) {
        if (!isRecord(advisory) || typeof advisory.module_name !== 'string') {
            throw new Error(`${label} pnpm audit report has a malformed advisory.`);
        }
        // Only pnpm's explicit no-release range is exempt; an advisory with an
        // unknown patched status fails like a fixable one.
        const target = advisory.patched_versions === NO_PATCHED_RELEASE ? partition.unpatched : partition.fixable;
        target.push(describeAdvisory(advisory));
    }

    return partition;
}

/**
 * Fails on every advisory that a dependency update can fix. An advisory with
 * no patched release leaves no dependency work to do, so it is reported and
 * fails the audit again as soon as a patched release appears.
 */
export function assertProductionAuditIsClean(report: unknown, label = 'project') {
    const summary = summarizeProductionAuditReport(report, label);
    const advisories = partitionAuditAdvisories(report, label);
    const listed = advisories.fixable.length + advisories.unpatched.length;
    if (listed !== summary.total) {
        throw new Error(`${label} pnpm audit counts ${summary.total} vulnerabilities but lists ${listed} advisories.`);
    }
    if (advisories.fixable.length > 0) {
        throw new Error(`${label} dependency audit found ${advisories.fixable.length} advisories with a patched release or an unknown patched status:\n${advisories.fixable.join('\n')}`);
    }

    return {
        ...summary,
        unpatched: advisories.unpatched,
    };
}

function runProjectAudit(project: IAuditProject) {
    const scopeArgs = project.scope === 'prod' ? ['--prod'] : [];
    let result = spawnSync('pnpm', [
        'audit',
        ...scopeArgs,
        '--json',
    ], {
        cwd: project.cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        shell: process.platform === 'win32',
    });

    if (result.error !== undefined) {
        throw new Error(`${project.label} pnpm audit could not start.`, {cause: result.error});
    }

    if (shouldUseBulkAuditFallback(result.stdout)) {
        result = spawnSync('corepack', [
            `pnpm@${BULK_AUDIT_PNPM_VERSION}`,
            '--pm-on-fail=ignore',
            'audit',
            ...scopeArgs,
            '--json',
        ], {
            cwd: project.cwd,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            shell: process.platform === 'win32',
        });

        if (result.error !== undefined) {
            throw new Error(`${project.label} pnpm audit could not start.`, {cause: result.error});
        }
    }

    const report = parseAuditReport(result.stdout, project.label);
    const summary = assertProductionAuditIsClean(report, project.label);

    // pnpm audit exits non-zero whenever it lists an advisory.
    if (result.status !== 0 && summary.total === 0) {
        const detail = result.stderr.trim();
        throw new Error(`${project.label} pnpm audit failed with exit code ${result.status ?? '<unknown>'}${detail === '' ? '' : `: ${detail}`}`);
    }

    for (const advisory of summary.unpatched) {
        console.warn(`${project.label}: no patched release yet for ${advisory}`);
    }
    console.log(`${project.label} dependency audit passed (${summary.unpatched.length} advisories without a patched release).`);
}

export function runProductionDependencyAudits({includeFullGraph = true} = {}) {
    runProjectAudit({
        cwd: PROJECT_ROOT,
        label: 'workspace production',
        scope: 'prod',
    });
    if (!includeFullGraph) {
        return;
    }

    runProjectAudit({
        cwd: PROJECT_ROOT,
        label: 'workspace full graph (Electron runtime and build tooling)',
        scope: 'all',
    });
}

function isDirectExecution() {
    const entryPath = process.argv[1];
    return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isDirectExecution()) {
    runProductionDependencyAudits({includeFullGraph: !process.argv.includes('--production-only')});
}
