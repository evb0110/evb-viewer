import { readFileSync } from 'fs';
import { join } from 'path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('main shutdown ordering', () => {
    it('requests renderer save flush before closing main operation admission', () => {
        const source = readFileSync(join(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const flushStepIndex = source.indexOf('label: \'renderer-save-flush\'');
        const shutdownStepIndex = source.indexOf('label: \'main-operation-shutdown\'');
        const beginShutdownIndex = source.indexOf(
            'beginMainOperationShutdown(\'Main process is shutting down\')',
            shutdownStepIndex,
        );

        expect(flushStepIndex).toBeGreaterThan(-1);
        expect(shutdownStepIndex).toBeGreaterThan(flushStepIndex);
        expect(beginShutdownIndex).toBeGreaterThan(shutdownStepIndex);
    });

    it('preserves loaded assistant history before closing main operation admission', () => {
        const source = readFileSync(join(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const assistantIndex = source.indexOf('label: \'assistant-history-preservation\'');
        const shutdownStepIndex = source.indexOf('label: \'main-operation-shutdown\'');
        const preserveCallIndex = source.indexOf('preserveAssistantStateForShutdownIfLoaded()', assistantIndex);

        expect(assistantIndex).toBeGreaterThan(-1);
        expect(preserveCallIndex).toBeGreaterThan(assistantIndex);
        expect(shutdownStepIndex).toBeGreaterThan(assistantIndex);
    });

    it('settles cancelled materialization flights before closing read handles or deleting working copies', () => {
        const source = readFileSync(join(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const cancelIndex = source.indexOf('cancelAllMainOperations(\'app shutdown\')');
        const materializationIndex = source.indexOf('label: \'working-copy-materializations\'');
        const settleIndex = source.indexOf(
            'settleAllWorkingCopyMaterializations()',
            materializationIndex,
        );
        const rangeHandleIndex = source.indexOf('label: \'range-read-handles\'');
        const cleanupIndex = source.indexOf('label: \'working-copies\'');

        expect(cancelIndex).toBeGreaterThan(-1);
        expect(materializationIndex).toBeGreaterThan(cancelIndex);
        expect(settleIndex).toBeGreaterThan(materializationIndex);
        expect(rangeHandleIndex).toBeGreaterThan(settleIndex);
        expect(cleanupIndex).toBeGreaterThan(rangeHandleIndex);
    });

    it('runs table-owned disposal before the established cleanup sequence', () => {
        const source = readFileSync(join(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const disposalIndex = source.indexOf('label: \'feature-registration-disposal\'');
        const agentIndex = source.indexOf('label: \'agent-assistant\'');
        const logFlushIndex = source.indexOf('label: \'log-flush\'');

        expect(disposalIndex).toBeGreaterThan(-1);
        expect(agentIndex).toBeGreaterThan(disposalIndex);
        expect(logFlushIndex).toBeGreaterThan(agentIndex);
    });

    it('retries retained document utility cleanup from the production shutdown steps', () => {
        const source = readFileSync(join(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const utilityStepIndex = source.indexOf('label: \'document-save-utilities\'');
        const utilityCallIndex = source.indexOf(
            'shutdownRetainedDocumentSaveUtilityProcesses()',
            utilityStepIndex,
        );

        expect(utilityStepIndex).toBeGreaterThan(-1);
        expect(utilityCallIndex).toBeGreaterThan(utilityStepIndex);
    });

    it('installs fatal process handlers only after shutdown coordination is ready', () => {
        const source = readFileSync(join(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const coordinatorIndex = source.indexOf('shutdownCoordinator = createShutdownCoordinator({');
        const rejectionHandlerIndex = source.indexOf(
            'process.on(\'unhandledRejection\', (reason) => {',
        );
        const exceptionHandlerIndex = source.indexOf('process.on(\'uncaughtException\'');

        expect(coordinatorIndex).toBeGreaterThan(-1);
        expect(rejectionHandlerIndex).toBeGreaterThan(-1);
        expect(exceptionHandlerIndex).toBeGreaterThan(-1);
        expect(rejectionHandlerIndex).toBeGreaterThan(coordinatorIndex);
        expect(exceptionHandlerIndex).toBeGreaterThan(rejectionHandlerIndex);

        const rejectionHandler = source.slice(rejectionHandlerIndex, exceptionHandlerIndex);
        expect(rejectionHandler).toMatch(/decideUnhandledRejection\s*\(\s*reason\s*\)/u);
        expect(rejectionHandler).toMatch(
            /requestFatalShutdown\s*\(\s*['"]Unhandled promise rejection requires fatal shutdown['"]/u,
        );
        expect(rejectionHandler).toMatch(/'MAIN_UNHANDLED_REJECTION'/u);
        const recoveryFactoryIndex = source.indexOf('createUnhandledRejectionRecovery(');
        expect(recoveryFactoryIndex).toBeGreaterThan(-1);
        expect(source.slice(recoveryFactoryIndex, rejectionHandlerIndex)).toMatch(/'MAIN_UNHANDLED_REJECTION_RECOVERY'/u);
        expect(rejectionHandler).toMatch(
            /onError\s*:\s*\(?error\)?\s*=>\s*\{[\s\S]*requestFatalShutdown\s*\(/u,
        );
        expect(rejectionHandler).toMatch(
            /Unhandled rejection subsystem recovery failed[^`]*\$\{decision\.subsystem\}[^`]*\$\{getErrorMessage\(error\)\}/u,
        );
    });
});
