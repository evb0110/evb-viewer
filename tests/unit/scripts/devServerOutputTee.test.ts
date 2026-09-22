import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEV_OUTPUT_TEE_DISABLED_ENV,
    DEV_OUTPUT_TEE_TRUNCATION_MARKER,
    createDevServerOutputTee,
    formatDevServerOutputTeeTimestamp,
    sanitizeDevServerOutputFileStem,
} from '@scripts/electron-run/devServerOutputTee';
import {
    DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY,
    pruneDevServerOutputRuns,
} from '@scripts/electron-run/devServerOutputRetention';

const tempRoots: string[] = [];

function createTempBaseDir() {
    const dir = mkdtempSync(join(tmpdir(), 'evb-dev-server-output-tee-'));
    tempRoots.push(dir);
    return dir;
}

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function createCompletedRun(
    baseDir: string,
    runName: string,
    createdAt: Date,
    byteLength = 1,
) {
    const runDir = join(baseDir, 'retention-session', runName);
    mkdirSync(runDir, {recursive: true});
    writeFileSync(join(runDir, 'output.log'), Buffer.alloc(byteLength, runName.charCodeAt(0)));
    writeFileSync(join(runDir, 'electron-run-tee.json'), JSON.stringify({
        schemaVersion: 1,
        createdAt: createdAt.toISOString(),
        closedAt: createdAt.toISOString(),
        pid: process.pid,
        runDir,
    }));
    return runDir;
}

function createBareRun(
    baseDir: string,
    runName: string,
    createdAt: Date,
    byteLength: number,
) {
    const runDir = join(baseDir, 'retention-session', runName);
    mkdirSync(runDir, {recursive: true});
    writeFileSync(join(runDir, 'output.log'), Buffer.alloc(byteLength, runName.charCodeAt(0)));
    utimesSync(runDir, createdAt, createdAt);
    return runDir;
}

describe('dev server output tee', () => {
    afterEach(() => {
        for (const dir of tempRoots.splice(0)) {
            rmSync(dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('uses stable timestamp and file-stem names', () => {
        expect(formatDevServerOutputTeeTimestamp(new Date('2026-07-06T10:11:12.345Z')))
            .toBe('2026-07-06T10-11-12-345Z');
        expect(sanitizeDevServerOutputFileStem('Nuxt Dev Server'))
            .toBe('nuxt-dev-server');
        expect(() => sanitizeDevServerOutputFileStem('***')).toThrow(/Invalid dev output tee file stem/u);
    });

    it('writes a self-describing scratch run with stream files and latest pointers', () => {
        const baseDir = createTempBaseDir();
        const tee = createDevServerOutputTee({
            sessionName: 'unit-session',
            baseDir,
            now: new Date('2026-07-06T10:11:12.345Z'),
            pid: 12345,
            metadataFileName: 'unit-run.json',
            owner: 'unit test',
        });

        expect(tee.runDir).toBe(join(baseDir, 'unit-session', '2026-07-06T10-11-12-345Z-pid-12345'));

        tee.write('Nuxt Dev Server', 'stdout', 'ready\n');
        tee.write('Electron Main Process', 'stderr', Buffer.from('boom\n'));
        tee.close();

        expect(readFileSync(join(tee.runDir, 'nuxt-dev-server.stdout.log'), 'utf8')).toBe('ready\n');
        expect(readFileSync(join(tee.runDir, 'electron-main-process.stderr.log'), 'utf8')).toBe('boom\n');
        expect(readFileSync(join(tee.runDir, 'nuxt-dev-server.combined.log'), 'utf8')).toContain('stdout] ready');
        expect(readFileSync(tee.runCombinedLogFile, 'utf8')).toContain('nuxt-dev-server stdout] ready');
        expect(readFileSync(tee.sessionLogFile, 'utf8')).toContain('electron-main-process stderr] boom');

        expect(readJsonFile<{
            owner: string;
            sessionName: string;
        }>(join(tee.runDir, 'unit-run.json'))).toMatchObject({
            owner: 'unit test',
            sessionName: 'unit-session',
        });
        expect(readJsonFile<{runDir: string}>(join(baseDir, 'latest-run.json')).runDir).toBe(tee.runDir);
        expect(readJsonFile<{runDir: string}>(join(baseDir, 'unit-session', 'latest-run.json')).runDir).toBe(tee.runDir);
        expect(readJsonFile<{
            runDir: string;
            sessionLogFile: string;
            sourceStems: string[];
        }>(tee.logManifestFile)).toMatchObject({
            runDir: tee.runDir,
            sessionLogFile: tee.sessionLogFile,
            sourceStems: [
                'electron-main-process',
                'nuxt-dev-server',
            ],
        });
    });

    it('prefixes whole lines when chunks split mid-line and keeps raw-only sources out of the session log', () => {
        const baseDir = createTempBaseDir();
        const tee = createDevServerOutputTee({
            sessionName: 'line-session',
            baseDir,
            now: new Date('2026-07-06T10:11:12.345Z'),
            pid: 12346,
        });

        tee.write('launcher', 'stdout', 'first half ');
        tee.write('electron-main-process', 'stderr', 'raw chromium line\n', {aggregate: false});
        tee.write('launcher', 'stdout', '\u001B[33msecond\u001B[0m half\nnext');
        tee.close();

        const sessionLines = readFileSync(tee.sessionLogFile, 'utf8').trimEnd().split('\n');
        expect(sessionLines).toHaveLength(2);
        expect(sessionLines[0]).toMatch(/^\[[^\]]+ launcher stdout\] first half second half$/u);
        expect(sessionLines[1]).toMatch(/^\[[^\]]+ launcher stdout\] next$/u);
        expect(readFileSync(tee.sessionLogFile, 'utf8')).not.toContain('raw chromium line');
        expect(readFileSync(join(tee.runDir, 'electron-main-process.stderr.log'), 'utf8')).toBe('raw chromium line\n');
    });

    it('can be explicitly disabled for callers that allow it', () => {
        expect(createDevServerOutputTee({
            env: {[DEV_OUTPUT_TEE_DISABLED_ENV]: '1'},
            allowDisabled: true,
        })).toBeNull();
        expect(() => createDevServerOutputTee({ env: { [DEV_OUTPUT_TEE_DISABLED_ENV]: '1' } })).toThrow(/disabled/u);
    });

    it('prunes completed runs by age on startup and close', () => {
        const baseDir = createTempBaseDir();
        const now = new Date('2026-07-20T12:00:00.000Z');
        const startupOldRun = createCompletedRun(
            baseDir,
            'startup-old',
            new Date('2026-07-01T12:00:00.000Z'),
        );
        const tee = createDevServerOutputTee({
            sessionName: 'unit-session',
            baseDir,
            now,
            pid: process.pid,
            retentionPolicy: {
                maxAgeMs: 7 * 24 * 60 * 60 * 1000,
                maxRuns: 100,
                maxTotalBytes: 1024 * 1024,
            },
        });

        expect(existsSync(startupOldRun)).toBe(false);

        const closeOldRun = createCompletedRun(
            baseDir,
            'close-old',
            new Date('2026-07-02T12:00:00.000Z'),
        );
        tee.close();

        expect(existsSync(closeOldRun)).toBe(false);
        expect(existsSync(tee.runDir)).toBe(true);
    });

    it('prunes the oldest completed runs to the configured run count', () => {
        const baseDir = createTempBaseDir();
        const oldestRun = createBareRun(baseDir, 'count-oldest', new Date('2026-07-01T00:00:00.000Z'), 10);
        const middleRun = createBareRun(baseDir, 'count-middle', new Date('2026-07-02T00:00:00.000Z'), 10);
        const newestRun = createBareRun(baseDir, 'count-newest', new Date('2026-07-03T00:00:00.000Z'), 10);

        pruneDevServerOutputRuns({
            baseDir,
            now: new Date('2026-07-04T00:00:00.000Z'),
            policy: {
                maxAgeMs: DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxAgeMs,
                maxRuns: 2,
                maxTotalBytes: 1024,
            },
        });

        expect(existsSync(oldestRun)).toBe(false);
        expect(existsSync(middleRun)).toBe(true);
        expect(existsSync(newestRun)).toBe(true);
    });

    it('prunes the oldest completed runs to the configured total byte budget', () => {
        const baseDir = createTempBaseDir();
        const oldestRun = createBareRun(baseDir, 'bytes-oldest', new Date('2026-07-01T00:00:00.000Z'), 80);
        const newestRun = createBareRun(baseDir, 'bytes-newest', new Date('2026-07-02T00:00:00.000Z'), 80);

        pruneDevServerOutputRuns({
            baseDir,
            now: new Date('2026-07-03T00:00:00.000Z'),
            policy: {
                maxAgeMs: DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxAgeMs,
                maxRuns: 10,
                maxTotalBytes: 100,
            },
        });

        expect(existsSync(oldestRun)).toBe(false);
        expect(existsSync(newestRun)).toBe(true);
        expect(statSync(join(newestRun, 'output.log')).size).toBe(80);
    });

    it('preserves latest-pointer targets and runs referenced by active descriptors', () => {
        const baseDir = createTempBaseDir();
        const activeRun = createBareRun(baseDir, 'active-target', new Date('2026-07-01T00:00:00.000Z'), 10);
        const descriptorRun = createBareRun(baseDir, 'active-descriptor', new Date('2026-07-02T00:00:00.000Z'), 10);
        const latestRun = createBareRun(baseDir, 'latest-target', new Date('2026-07-03T00:00:00.000Z'), 10);
        const removableRun = createBareRun(baseDir, 'removable', new Date('2026-07-04T00:00:00.000Z'), 10);
        writeFileSync(join(descriptorRun, 'active.json'), JSON.stringify({
            pid: process.pid,
            runDir: activeRun,
        }));
        writeFileSync(join(baseDir, 'latest-run.json'), JSON.stringify({runDir: latestRun}));

        pruneDevServerOutputRuns({
            baseDir,
            now: new Date('2026-07-20T00:00:00.000Z'),
            policy: {
                maxAgeMs: 0,
                maxRuns: 0,
                maxTotalBytes: 0,
            },
        });

        expect(existsSync(activeRun)).toBe(true);
        expect(existsSync(latestRun)).toBe(true);
        expect(existsSync(removableRun)).toBe(false);
    });

    it('ignores malformed, stale, and out-of-tree latest pointers safely', () => {
        const baseDir = createTempBaseDir();
        const removableRun = createBareRun(baseDir, 'stale-pointer-removable', new Date('2026-07-01T00:00:00.000Z'), 10);
        const sessionDir = join(baseDir, 'retention-session');
        const outsidePointerSessionDir = join(baseDir, 'outside-pointer-session');
        const outsideDir = createTempBaseDir();
        const outsideFile = join(outsideDir, 'must-survive.log');
        mkdirSync(outsidePointerSessionDir, {recursive: true});
        writeFileSync(outsideFile, 'keep');
        writeFileSync(join(baseDir, 'latest-run.json'), '{ malformed');
        writeFileSync(join(sessionDir, 'latest-run.json'), JSON.stringify({runDir: join(baseDir, 'missing-run')}));
        writeFileSync(join(outsidePointerSessionDir, 'latest-run.json'), JSON.stringify({runDir: outsideDir}));

        expect(() => pruneDevServerOutputRuns({
            baseDir,
            now: new Date('2026-07-20T00:00:00.000Z'),
            policy: {
                maxAgeMs: 0,
                maxRuns: 0,
                maxTotalBytes: 0,
            },
        })).not.toThrow();

        expect(existsSync(removableRun)).toBe(false);
        expect(readFileSync(outsideFile, 'utf8')).toBe('keep');
    });

    it('caps individual logs and appends an explicit truncation marker', () => {
        const baseDir = createTempBaseDir();
        const tee = createDevServerOutputTee({
            sessionName: 'unit-session',
            baseDir,
            now: new Date('2026-07-20T12:00:00.000Z'),
            pid: process.pid,
            retentionPolicy: {maxFileBytes: 96},
        });

        tee.write('oversized source', 'stdout', 'x'.repeat(512));
        tee.write('oversized source', 'stdout', 'ignored after truncation');
        tee.close();

        for (const fileName of [
            'oversized-source.stdout.log',
            'oversized-source.combined.log',
        ]) {
            const output = readFileSync(join(tee.runDir, fileName));
            expect(output.byteLength).toBeLessThanOrEqual(96);
            expect(output.toString('utf8')).toContain(DEV_OUTPUT_TEE_TRUNCATION_MARKER.trim());
        }
    });
});
