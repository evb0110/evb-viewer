import type { ICaseDefinition } from '@scripts/windows-test/guest/cases/caseContext';
import {
    runWinSave01,
    runWinSave02,
    runWinSave04,
    runWinSave08,
} from '@scripts/windows-test/guest/cases/saveCases';
import {
    runWinPrint01,
    runWinPrint02,
    runWinPrint07,
} from '@scripts/windows-test/guest/cases/printCases';
import {
    runWinTools01,
    runWinUi02,
} from '@scripts/windows-test/guest/cases/uiToolsCases';
import { runWinSaveWitnessMatrix } from '@scripts/windows-test/guest/cases/runWinSaveWitnessMatrix';

export const windowsTestCaseDefinitions: readonly ICaseDefinition[] = [
    {
        id: 'WIN-SAVE-10',
        family: 'save',
        driver: 'APP',
        ledgerDrivers: 'APP + NATIVE',
        actionKind: 'process',
        status: 'implemented',
        run: runWinSaveWitnessMatrix,
    },
    {
        id: 'WIN-SAVE-01',
        family: 'save',
        driver: 'APP',
        ledgerDrivers: 'APP + NATIVE',
        actionKind: 'app',
        status: 'implemented',
        run: runWinSave01,
    },
    {
        id: 'WIN-PRINT-01',
        family: 'print',
        driver: 'WIN',
        ledgerDrivers: 'WIN',
        actionKind: 'pattern',
        status: 'implemented',
        run: runWinPrint01,
    },
    {
        id: 'WIN-PRINT-02',
        family: 'print',
        driver: 'WIN',
        ledgerDrivers: 'APP + WIN',
        actionKind: 'pattern',
        status: 'implemented',
        run: runWinPrint02,
    },
    {
        id: 'WIN-PRINT-07',
        family: 'print',
        driver: 'WIN',
        ledgerDrivers: 'WIN',
        actionKind: 'pattern',
        status: 'implemented',
        run: runWinPrint07,
    },
    {
        id: 'WIN-SAVE-02',
        family: 'save',
        driver: 'WIN',
        ledgerDrivers: 'APP + WIN',
        actionKind: 'pattern',
        status: 'implemented',
        run: runWinSave02,
    },
    {
        id: 'WIN-SAVE-04',
        family: 'save',
        driver: 'NATIVE',
        ledgerDrivers: 'NATIVE + APP',
        actionKind: 'process',
        status: 'implemented',
        run: runWinSave04,
    },
    {
        id: 'WIN-SAVE-08',
        family: 'save',
        driver: 'NATIVE',
        ledgerDrivers: 'NATIVE + APP',
        actionKind: 'process',
        status: 'implemented',
        run: runWinSave08,
    },
    {
        id: 'WIN-UI-02',
        family: 'ui',
        driver: 'WIN',
        ledgerDrivers: 'WIN',
        actionKind: 'input',
        status: 'implemented',
        run: runWinUi02,
    },
    {
        id: 'WIN-TOOLS-01',
        family: 'tools',
        driver: 'NATIVE',
        ledgerDrivers: 'NATIVE',
        actionKind: 'process',
        status: 'implemented',
        run: runWinTools01,
    },
];

export function registeredCaseIds() {
    return windowsTestCaseDefinitions.map(definition => definition.id);
}

export function findCaseDefinition(testId: string) {
    return windowsTestCaseDefinitions.find(definition => definition.id === testId) ?? null;
}

export function requireCaseDefinition(testId: string) {
    const definition = findCaseDefinition(testId);
    if (definition === null) {
        throw new Error(`Unknown Windows test id: ${testId}`);
    }
    return definition;
}
