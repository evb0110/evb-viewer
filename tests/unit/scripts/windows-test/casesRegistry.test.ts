import {
    readFile,
    mkdtemp,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import { isWindowsTestCaseResult } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    guestLayoutForRoot,
    guestRunPaths,
} from '@scripts/windows-test/guest/guestPaths';
import { createNodeGuestFileSystem } from '@scripts/windows-test/guest/guestRuntime';
import { loadSelectorRecords } from '@scripts/windows-test/guest/native-ui/selectorRecords';
import {
    CaseCanceledError,
    NotYetImplementedStep,
    runRegisteredCase,
    type ICaseDefinition,
    type ICaseEnvironment,
} from '@scripts/windows-test/guest/cases/caseContext';
import {
    findCaseDefinition,
    registeredCaseIds,
    requireCaseDefinition,
    windowsTestCaseDefinitions,
} from '@scripts/windows-test/guest/cases/caseRegistry';

const runId = '20260904T120000Z-0123456789ab';
const fs = createNodeGuestFileSystem();

interface ICapabilityCase {
    id: string;
    driver: string;
    status: string;
    obligation: string;
}

function unusable(name: string) {
    return new Proxy({}, { get: () => () => {
        throw new Error(`${name} must not be used by this case`);
    } });
}

function stubEnvironment(root: string): ICaseEnvironment {
    const layout = guestLayoutForRoot(root, '/');
    let currentTime = 1_700_000_000_000;
    const canceled = false;
    const remaining = 60_000;
    return {
        clock: {
            now: () => currentTime,
            nowIso: () => new Date(currentTime).toISOString(),
            sleep: (milliseconds) => {
                currentTime += milliseconds;
                return Promise.resolve();
            },
        },
        fs,
        exec: { run: () => Promise.reject(new Error('exec must not be used by this case')) },
        powerShell: unusable('powerShell') as ICaseEnvironment['powerShell'],
        nativeUi: unusable('nativeUi') as ICaseEnvironment['nativeUi'],
        viewer: unusable('viewer') as ICaseEnvironment['viewer'],
        selectors: loadSelectorRecords(),
        paths: guestRunPaths(layout, runId),
        separator: '/',
        installDirectory: `${root}/app`,
        fixturePath: fixtureId => `${root}/staging/${fixtureId}.pdf`,
        log: () => undefined,
        throwIfCanceled: () => (canceled ? Promise.reject(new CaseCanceledError()) : Promise.resolve()),
        remainingMs: () => remaining,
    };
}

function definition(overrides: Partial<ICaseDefinition>): ICaseDefinition {
    return {
        id: 'WIN-SAVE-01',
        family: 'save',
        driver: 'APP',
        ledgerDrivers: 'APP',
        actionKind: 'app',
        status: 'implemented',
        run: () => Promise.resolve(),
        ...overrides,
    };
}

let root = '';

describe('windows guest case registry', () => {
    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-guest-cases-'));
    });

    it('registers exactly the cases the ledger marks implemented', async () => {
        const registry: unknown = JSON.parse(await readFile(
            path.join(process.cwd(), 'tests', 'windows', 'capabilities.json'),
            'utf8',
        ));
        const cases = (registry as { cases: ICapabilityCase[] }).cases;
        const implemented = cases
            .filter(entry => entry.status === 'implemented')
            .map(entry => entry.id)
            .sort((left, right) => left.localeCompare(right));
        expect([...registeredCaseIds()].sort((left, right) => left.localeCompare(right))).toEqual(implemented);

        for (const caseDefinition of windowsTestCaseDefinitions) {
            const ledgerCase = cases.find(entry => entry.id === caseDefinition.id);
            expect(ledgerCase, caseDefinition.id).toBeDefined();
            expect(caseDefinition.ledgerDrivers, caseDefinition.id).toContain(ledgerCase?.driver ?? '');
            expect(caseDefinition.status, caseDefinition.id).toBe('implemented');
        }
    });

    it('exposes a lookup that fails loudly on an unknown id', () => {
        expect(findCaseDefinition('WIN-SAVE-01')?.family).toBe('save');
        expect(findCaseDefinition('WIN-NOPE-99')).toBeNull();
        expect(() => requireCaseDefinition('WIN-NOPE-99')).toThrow('Unknown Windows test id');
    });

    it('gives every definition a real step function and a driver the contract knows', () => {
        for (const caseDefinition of windowsTestCaseDefinitions) {
            expect(typeof caseDefinition.run, caseDefinition.id).toBe('function');
            expect([
                'APP',
                'WIN',
                'NATIVE',
            ], caseDefinition.id).toContain(caseDefinition.driver);
            expect([
                'pattern',
                'input',
                'process',
                'app',
            ], caseDefinition.id).toContain(caseDefinition.actionKind);
        }
    });

    it('reports unsupported for a case that is not implemented yet', async () => {
        const result = await runRegisteredCase(definition({ status: 'planned' }), stubEnvironment(root));
        expect(isWindowsTestCaseResult(result)).toBe(true);
        expect(result.outcome).toBe('unsupported');
        expect(result.failureReason).toContain('registered as planned');
    });

    it('never reports passed when the case recorded no assertion', async () => {
        const result = await runRegisteredCase(definition({ run: () => Promise.resolve() }), stubEnvironment(root));
        expect(result.outcome).toBe('unsupported');
        expect(result.failureReason).toContain('without recording a single assertion');
    });

    it('reports passed only when every recorded assertion passed', async () => {
        const result = await runRegisteredCase(definition({ run: (context) => {
            context.assert('a', true, 'first');
            context.requireAssertion('b', true, 'second');
            return Promise.resolve();
        } }), stubEnvironment(root));
        expect(result.outcome).toBe('passed');
        expect(result.assertions).toHaveLength(2);
        expect(result.failureReason).toBeNull();
    });

    it('reports product-failed when an assertion fails, even if the case keeps going', async () => {
        const result = await runRegisteredCase(definition({ run: (context) => {
            context.assert('a', false, 'the saved file lost a page');
            context.assert('b', true, 'still fine');
            return Promise.resolve();
        } }), stubEnvironment(root));
        expect(result.outcome).toBe('product-failed');
        expect(result.assertions.filter(assertion => !assertion.passed)).toHaveLength(1);
    });

    it('stops the case at the first required assertion that fails', async () => {
        let reachedSecondStep = false;
        const result = await runRegisteredCase(definition({ run: (context) => {
            context.requireAssertion('a', false, 'the delete was rejected');
            reachedSecondStep = true;
            return Promise.resolve();
        } }), stubEnvironment(root));
        expect(reachedSecondStep).toBe(false);
        expect(result.outcome).toBe('product-failed');
        expect(result.failureReason).toContain('Assertion a failed');
    });

    it('maps a not-yet-implemented step to unsupported rather than a pass', async () => {
        const result = await runRegisteredCase(definition({ run: (context) => {
            context.assert('a', true, 'the part that works');
            throw new NotYetImplementedStep('verify the printer queue', 'needs a real spooler');
        } }), stubEnvironment(root));
        expect(result.outcome).toBe('unsupported');
        expect(result.failureReason).toContain('has no implementation yet');
    });

    it('maps a cancel to canceled and an unexpected failure to infrastructure-failed', async () => {
        const canceled = await runRegisteredCase(definition({ run: () => {
            throw new CaseCanceledError();
        } }), stubEnvironment(root));
        expect(canceled.outcome).toBe('canceled');

        const broken = await runRegisteredCase(definition({ run: () => {
            throw new Error('the CDP connection dropped');
        } }), stubEnvironment(root));
        expect(broken.outcome).toBe('infrastructure-failed');
        expect(broken.failureReason).toContain('CDP connection dropped');
    });

    it('lists the evidence a case attached', async () => {
        const result = await runRegisteredCase(definition({ run: (context) => {
            context.attachEvidence('win-save-01/summary.json');
            context.attachEvidence('win-save-01/summary.json');
            context.assert('a', true, 'ok');
            return Promise.resolve();
        } }), stubEnvironment(root));
        expect(result.evidenceFiles).toEqual(['win-save-01/summary.json']);
    });

    it('captures binary artifacts into the manifest-covered evidence tree even when the case fails later', async () => {
        const source = `${root}/source.pdf`;
        const bytes = new Uint8Array([
            0,
            1,
            2,
            255,
        ]);
        await fs.writeBytes(source, bytes);
        const result = await runRegisteredCase(definition({ run: async (context) => {
            await context.captureArtifact(source, 'artifacts\\WIN-SAVE-01\\source.pdf');
            context.assert('captured', true, 'the source artifact was copied');
            throw new Error('the later case step failed');
        } }), stubEnvironment(root));

        expect(result.outcome).toBe('infrastructure-failed');
        expect(result.evidenceFiles).toEqual(['artifacts/WIN-SAVE-01/source.pdf']);
        expect(await fs.readBytes(`${root}/work/${runId}/evidence/artifacts/WIN-SAVE-01/source.pdf`))
            .toEqual(bytes);
    });

    it('records every failed save-witness replacement and still attaches the matrix report', async () => {
        const fixturePath = `${root}/fixtures/shared-small.pdf`;
        await fs.copyFile(
            path.join(process.cwd(), 'tests', 'fixtures', 'electron', 'interop', 'stock-pdfjs-save-of-synthetic.pdf'),
            fixturePath,
        );
        let renameAttempts = 0;
        const failingFs: ICaseEnvironment['fs'] = {
            ...fs,
            rename: async () => {
                renameAttempts += 1;
                throw new Error('EPERM: rename denied by the test harness');
            },
        };
        const environment = {
            ...stubEnvironment(root),
            fs: failingFs,
            fixturePath: () => fixturePath,
        };

        const result = await runRegisteredCase(
            requireCaseDefinition('WIN-SAVE-10'),
            environment,
        );

        expect(result.outcome).toBe('product-failed');
        expect(renameAttempts).toBe(12);
        expect(result.assertions).toHaveLength(18);
        expect(result.assertions.filter(assertion => !assertion.passed)).toHaveLength(11);
        expect(result.assertions.filter(assertion => assertion.id.endsWith('-0'))).toHaveLength(3);
        expect(result.assertions.filter(assertion => assertion.id.endsWith('-0')).every(assertion => assertion.passed)).toBe(true);
        expect(result.evidenceFiles).toEqual(['save-witness-matrix.json']);

        const report = JSON.parse(await fs.readText(`${root}/work/${runId}/evidence/save-witness-matrix.json`)) as {cells: Array<{
            cycle: number;
            passed: boolean;
            failure: string | null;
            baselineCaptureMs: number | null;
            readVolumeBytes: number | null;
            cancellation: {
                readsAfterCancellation: number;
                durationMs: number;
                readSettledBeforeRejection: boolean;
                singleReadIsWholeFile: boolean
            } | null;
        }>;};
        expect(report.cells).toHaveLength(12);
        expect(report.cells.filter(cell => cell.cycle > 0)).toHaveLength(9);
        expect(report.cells.filter(cell => cell.cycle > 0).every(cell => !cell.passed && cell.failure?.includes('EPERM'))).toBe(true);
        expect(report.cells.filter(cell => cell.cycle > 0).every(cell => cell.baselineCaptureMs !== null
            && cell.readVolumeBytes === 9214)).toBe(true);
        expect(report.cells.filter(cell => cell.cycle === 0).every(cell => cell.passed
            && cell.cancellation?.readsAfterCancellation === 0
            && cell.cancellation.durationMs >= 0
            && cell.cancellation.readSettledBeforeRejection
            && cell.cancellation.singleReadIsWholeFile)).toBe(true);

        const successful = await runRegisteredCase(requireCaseDefinition('WIN-SAVE-10'), {
            ...environment,
            fs,
        });
        expect(successful.outcome).toBe('product-failed');
        expect(successful.assertions).toHaveLength(18);
        expect(successful.assertions.filter(assertion => !assertion.passed).map(assertion => assertion.id)).toEqual([
            'save-witness-exact-65-mib-fixture-size',
            'save-witness-exact-513-mib-fixture-size',
        ]);
    });
});
