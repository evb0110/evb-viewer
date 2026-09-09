import {execFileSync} from 'node:child_process';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildProject6ConsolidationReport,
    classifyPath,
    parseNulDelimitedRecords,
    parseNumstatRecords,
    parseTreeEntries,
    renderMarkdown,
} from '@scripts/project6ConsolidationReport.mjs';

function git(root: string, ...args: string[]) {
    return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
    }).trim();
}

interface IReportAfter { files: number }

interface IReportFile {
    bytes: number;
    gitBlobOid: string;
    path: string;
}

interface IReportDomain { after: IReportAfter }

interface IReportMatch {
    count: number;
    ownedCount: number;
}

interface IReportOwnership { headPrefixMatches: IReportMatch[] }

interface IChangedFile { newPath: string }

interface IConsolidationReport {
    base: string;
    head: string;
    domains: Record<string, IReportDomain>;
    binaryFiles: {addedOrChanged: IReportFile[]};
    nonCodeFiles: {addedOrChanged: IReportFile[]};
    ownership: IReportOwnership;
    changedFiles: IChangedFile[];
}

function isConsolidationReport(value: unknown): value is IConsolidationReport {
    return typeof value === 'object'
        && value !== null
        && 'base' in value
        && 'head' in value
        && 'domains' in value
        && 'binaryFiles' in value
        && 'nonCodeFiles' in value
        && 'ownership' in value
        && 'changedFiles' in value;
}

describe('Project 6 consolidation report', () => {
    it('rejects truncated or malformed Git records', () => {
        expect(() => parseNulDelimitedRecords(Buffer.from('unterminated'))).toThrow(/NUL record terminator/u);
        expect(() => parseTreeEntries(Buffer.from('100644 blob not-an-oid 2\tapp/a.ts\0'))).toThrow(/tree metadata/u);
        expect(() => parseTreeEntries(Buffer.from('100644 blob 0123456789012345678901234567890123456789 nope\tapp/a.ts\0'))).toThrow(/tree metadata/u);
        expect(() => parseNumstatRecords(Buffer.from('2\t1\t\0old.ts\0'))).toThrow(/rename record/u);
        expect(() => parseNumstatRecords(Buffer.from('oops\t1\tapp/a.ts\0'))).toThrow(/numstat count/u);
    });

    it('parses ordinary and rename-aware NUL numstat records', () => {
        expect(parseNumstatRecords(Buffer.from('4\t2\tapp/a.ts\0-\t-\tresources/a.bin\0'))).toEqual([
            {
                additions: 4,
                deletions: 2,
                newPath: 'app/a.ts',
                oldPath: 'app/a.ts',
            },
            {
                additions: null,
                deletions: null,
                newPath: 'resources/a.bin',
                oldPath: 'resources/a.bin',
            },
        ]);
        expect(parseNumstatRecords(Buffer.from('2\t1\t\0old.ts\0new.ts\0'))).toEqual([{
            additions: 2,
            deletions: 1,
            newPath: 'new.ts',
            oldPath: 'old.ts',
        }]);
    });

    it('uses the explicit domain manifest and reports unknown paths as unassigned', () => {
        expect(classifyPath('electron/features/scan-cleanup/worker/main.ts').id).toBe('scan-cleanup');
        expect(classifyPath('.github/workflows/ci.yml').reservation).toBe('shared-owner');
        expect(classifyPath('scripts/runRuntimeBinaryArchiveCli.ts').id).toBe('runtime-binaries');
        expect(classifyPath('scripts/runtimeBinaryManifest.ts').ownerTickets).toContain('#325');
        expect(classifyPath('scripts/validateRuntimeBinaryArchiveMembers.ts').id).toBe('runtime-binaries');
        expect(classifyPath('vendor/unknown.bin').id).toBe('unassigned');
        expect(classifyPath('packages/contracts/scan-cleanup/schema.ts').id).toBe('scan-cleanup');
    });

    it('reads exact repository trees and reports code and ownership metadata', () => {
        const root = process.cwd();
        const head = git(root, 'log', '-1', '--format=%H', '--', 'scripts/project6ConsolidationReport.mjs');
        const base = git(root, 'rev-parse', `${head}^`);
        const candidate = buildProject6ConsolidationReport({
            root,
            base,
            head,
        });
        if (!isConsolidationReport(candidate)) {
            throw new Error('Consolidation report did not return the expected shape.');
        }
        const report = candidate;

        expect(report.base).toBe(base);
        expect(report.head).toBe(head);
        expect(report.domains.tooling?.after.files).toBeGreaterThan(0);
        expect(report.binaryFiles.addedOrChanged.every(file => (
            typeof file.bytes === 'number'
            && typeof file.gitBlobOid === 'string'
            && /^[0-9a-f]{40}$/u.test(file.gitBlobOid)
            && typeof file.path === 'string'
        ))).toBe(true);
        expect(report.nonCodeFiles.addedOrChanged.every(file => (
            typeof file.bytes === 'number'
            && typeof file.gitBlobOid === 'string'
            && /^[0-9a-f]{40}$/u.test(file.gitBlobOid)
            && typeof file.path === 'string'
        ))).toBe(true);
        expect(report.ownership.headPrefixMatches.every(match => (
            Number.isInteger(match.count) && Number.isInteger(match.ownedCount)
        ))).toBe(true);
        expect(report.changedFiles).toEqual(expect.arrayContaining([expect.objectContaining({newPath: 'scripts/project6ConsolidationReport.mjs'})]));
        expect(renderMarkdown(report)).toContain(`Base: \`${base}\``);
        expect(renderMarkdown(report)).toContain('Head prefix match counts:');
    });
});
