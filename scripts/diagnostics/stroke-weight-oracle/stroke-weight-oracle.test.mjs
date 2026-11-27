import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const calibrationPath = resolve(scriptDirectory, 'calibration.json');
const pythonPath = resolve(scriptDirectory, 'stroke_weight_oracle.py');
const rustPath = resolve(repositoryRoot, 'native/scan-cleanup/src/bw.rs');

const calibration = JSON.parse(await readFile(calibrationPath, 'utf8'));

test('Rust stroke-budget constants match the tracked oracle calibration', async () => {
    const rust = await readFile(rustPath, 'utf8');
    const mappings = new Map([
        ['calibrationDpi', 'STROKE_BUDGET_CALIBRATION_DPI'],
        ['componentAreaMinPx', 'STROKE_BUDGET_COMPONENT_AREA_MIN_PX'],
        ['componentHeightMinPxAt300Dpi', 'STROKE_BUDGET_COMPONENT_HEIGHT_MIN_PX_AT_300_DPI'],
        ['componentHeightMaxPxAt300Dpi', 'STROKE_BUDGET_COMPONENT_HEIGHT_MAX_PX_AT_300_DPI'],
        ['componentWidthMinPxAt300Dpi', 'STROKE_BUDGET_COMPONENT_WIDTH_MIN_PX_AT_300_DPI'],
        ['componentWidthMaxPxAt300Dpi', 'STROKE_BUDGET_COMPONENT_WIDTH_MAX_PX_AT_300_DPI'],
        ['lineClusterGapHeightFraction', 'STROKE_BUDGET_LINE_CLUSTER_GAP_HEIGHT_FRACTION'],
        ['minimumLineComponents', 'STROKE_BUDGET_MINIMUM_LINE_COMPONENTS'],
        ['localWindowMm', 'STROKE_BUDGET_LOCAL_WINDOW_MM'],
        ['localWindowMinComponents', 'STROKE_BUDGET_MINIMUM_LOCAL_COMPONENTS'],
        ['offenderRatio', 'STROKE_BUDGET_TOLERANCE_RATIO'],
    ]);
    for (const [jsonName, rustName] of mappings) {
        const match = rust.match(new RegExp(`const ${rustName}: [^=]+ = ([0-9.]+);`));
        assert.ok(match, `missing Rust constant ${rustName}`);
        assert.equal(Number(match[1]), calibration[jsonName], `${rustName} drifted`);
    }
    assert.equal(calibration.connectivity, 8);
    assert.equal(calibration.roundingRule, 'half-away-from-zero');
    assert.deepEqual(
        Object.keys(calibration).sort(),
        [...mappings.keys(), 'connectivity', 'roundingRule'].sort(),
        'every calibration key must be pinned against Rust or asserted explicitly',
    );
});

test('Python and Rust use the same half-away rounding at 312.5 DPI', async () => {
    const python = process.env.EVB_PYTHON ?? 'python3';
    const {stdout} = await execFileAsync(python, [pythonPath, '--calibration', calibrationPath, '--print-eligibility', '--dpi', '312.5']);
    assert.deepEqual(JSON.parse(stdout), {
        minimumArea: 9,
        minimumHeight: 13,
        maximumHeight: 73,
        minimumWidth: 2,
        maximumWidth: 208,
    });
});
