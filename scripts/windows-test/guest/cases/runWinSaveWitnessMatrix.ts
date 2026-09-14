import {
    createResearchSaveWitnessMatrixAdapter,
    identifySaveWitnessPdf,
    runSaveWitnessMatrix,
    type ISaveWitnessMatrixFixture,
} from '@scripts/save-witness/saveWitnessMatrix';
import type {ICaseContext} from '@scripts/windows-test/guest/cases/caseContext';

const fixtures = [
    [
        'existing-small',
        'F10-save-witness-small',
    ],
    [
        'exact-65-mib',
        'F10-save-witness-65mib',
    ],
    [
        'exact-513-mib',
        'F10-save-witness-513mib',
    ],
] as const;

export async function runWinSaveWitnessMatrix(context: ICaseContext) {
    const identified: ISaveWitnessMatrixFixture[] = [];
    let fixtureSizesPassed = true;
    for (const [
        id,
        stagedId,
    ] of fixtures) {
        const path = context.fixturePath(stagedId);
        const identity = await identifySaveWitnessPdf(path);
        if (!identity.validPdf) throw new Error(`Invalid matrix PDF: ${id}`);
        const expectedBytes = id === 'exact-65-mib' ? 65 * 1024 * 1024
            : id === 'exact-513-mib' ? 513 * 1024 * 1024 : identity.bytes;
        fixtureSizesPassed &&= identity.bytes === expectedBytes;
        context.assert(`save-witness-${id}-fixture-size`, identity.bytes === expectedBytes,
            `expected=${expectedBytes} actual=${identity.bytes}`);
        identified.push({
            id,
            path,
            ...identity,
        });
    }
    const report = await runSaveWitnessMatrix(identified, createResearchSaveWitnessMatrixAdapter(context.paths.outputsDir, (from, to) => context.fs.rename(from, to)));
    for (const cell of report.cells) {
        context.assert(`save-witness-${cell.fixtureId}-${cell.cycle}`, cell.passed,
            cell.failure ?? `baseline=${String(cell.baselineCaptureMs)}ms total=${String(cell.totalSaveLatencyMs)}ms`);
    }
    for (const cell of report.adversarial) {
        context.assert(`save-witness-${cell.fixtureId}-held-save`, cell.passed,
            cell.failure ?? `replacement=${cell.replacementOutcome}; publicationApproved=${String(cell.publicationApproved)}`);
    }
    await context.fs.writeText(context.attachEvidence('save-witness-matrix.json'), JSON.stringify({
        ...report,
        fixtures: report.fixtures.map(({
            path: _path, ...fixture
        }) => fixture),
        decision: fixtureSizesPassed && report.cells.every(cell => cell.passed) && report.adversarial.every(cell => cell.passed) ? 'affirmative' : 'negative',
    }, null, 2));
}
