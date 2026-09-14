import {
    join, resolve,
} from 'node:path';
import {
    createResearchSaveWitnessMatrixAdapter,
    ensureSaveWitnessMatrixFixtures,
    runSaveWitnessMatrix,
    writeSaveWitnessMatrixReport,
} from '@scripts/save-witness/saveWitnessMatrix';

const root = resolve(process.cwd(), '.devkit', 'save-witness-matrix');
const fixtures = await ensureSaveWitnessMatrixFixtures();
const runId = new Date().toISOString().replaceAll(':', '-');
const report = await runSaveWitnessMatrix(fixtures, createResearchSaveWitnessMatrixAdapter(join(root, 'work', runId)));
const outputPath = join(root, 'runs', `${runId}.json`);
await writeSaveWitnessMatrixReport(report, outputPath);
process.stdout.write(JSON.stringify({
    outputPath,
    cells: report.cells,
    adversarial: report.adversarial,
}, null, 2) + '\n');
process.exitCode = report.cells.every(cell => cell.passed) && report.adversarial.every(cell => cell.passed) ? 0 : 2;
