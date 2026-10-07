import {
    assertProductionAuditIsClean,
    shouldUseBulkAuditFallback,
    summarizeProductionAuditReport,
} from '@scripts/checkProductionDependencyAudit';
import {
    describe,
    expect,
    it,
} from 'vitest';

function createAdvisory(moduleName: string, severity: string, patchedVersions: string) {
    return {
        github_advisory_id: `GHSA-${moduleName}`,
        module_name: moduleName,
        patched_versions: patchedVersions,
        severity,
    };
}

function createAuditReport(overrides: {
    advisories?: Record<string, unknown>;
    critical?: number;
    high?: number;
    info?: number;
    low?: number;
    moderate?: number;
    muted?: unknown[];
} = {}) {
    return {
        advisories: overrides.advisories ?? {},
        metadata: {vulnerabilities: {
            critical: overrides.critical ?? 0,
            high: overrides.high ?? 0,
            info: overrides.info ?? 0,
            low: overrides.low ?? 0,
            moderate: overrides.moderate ?? 0,
        }},
        muted: overrides.muted ?? [],
    };
}

describe('production dependency audit policy', () => {
    it('uses the bulk-audit client only for the retired pnpm audit endpoint', () => {
        expect(shouldUseBulkAuditFallback('{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE","message":"The audit endpoint is being retired"}}')).toBe(true);
        expect(shouldUseBulkAuditFallback('{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE","message":"registry unavailable"}}')).toBe(false);
    });

    it('accepts a complete zero-vulnerability pnpm report', () => {
        expect(assertProductionAuditIsClean(createAuditReport(), 'root')).toEqual({
            counts: {
                critical: 0,
                high: 0,
                info: 0,
                low: 0,
                moderate: 0,
            },
            total: 0,
            unpatched: [],
        });
    });

    it('rejects every advisory that has a patched release', () => {
        expect(() => assertProductionAuditIsClean(createAuditReport({
            advisories: {
                1: createAdvisory('shell-quote', 'critical', '>=1.11.0'),
                2: createAdvisory('node-forge', 'high', '<0.0.0'),
                3: createAdvisory('source-map-js', 'high', '>=1.2.2'),
            },
            critical: 1,
            high: 2,
        }), 'landing')).toThrow('landing dependency audit found 2 advisories with a patched release:\nshell-quote critical GHSA-shell-quote (patched: >=1.11.0)\nsource-map-js high GHSA-source-map-js (patched: >=1.2.2)');
    });

    it('reports advisories without a patched release instead of failing on them', () => {
        expect(assertProductionAuditIsClean(createAuditReport({
            advisories: {1: createAdvisory('braces', 'high', '<0.0.0')},
            high: 1,
        }), 'root').unpatched).toEqual(['braces high GHSA-braces (patched: <0.0.0)']);
    });

    it('rejects vulnerability counts that list no advisories', () => {
        expect(() => assertProductionAuditIsClean(createAuditReport({high: 2}), 'root')).toThrow('root pnpm audit counts 2 vulnerabilities but lists no advisories.');
    });

    it('rejects muted advisories instead of silently accepting exceptions', () => {
        expect(() => summarizeProductionAuditReport(createAuditReport({muted: [101]}), 'root')).toThrow('root pnpm audit report contains 1 muted advisories');
    });

    it('rejects malformed or incomplete audit output', () => {
        expect(() => summarizeProductionAuditReport({}, 'root')).toThrow('root pnpm audit report is missing metadata.vulnerabilities.');
        expect(() => summarizeProductionAuditReport(createAuditReport({high: -1}), 'root')).toThrow('root pnpm audit report has an invalid high vulnerability count.');
        expect(() => assertProductionAuditIsClean(createAuditReport({advisories: {1: {module_name: 'braces'}}}), 'root')).toThrow('root pnpm audit report has a malformed advisory.');
    });
});
