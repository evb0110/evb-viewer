import { readdirSync } from 'node:fs';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';

// Electron E2E lanes are directories. Every directory of tests/e2e/electron
// except helpers and nightly is one job of the required CI verdict
// (.github/workflows/ci.yml reads this list), so a test file joins a lane by
// where it is saved, and lanes are balanced by moving files between them.
// Each directory under nightly is a lane outside that verdict: ci-nightly.yml
// runs search, large-pdf and visible-window by name, and a person runs
// discovery against a private document corpus.
const E2E_ROOT = 'tests/e2e/electron';
const NOT_LANES = new Set([
    'helpers',
    'nightly',
]);

/** @param {string} directory */
function listLaneDirectories(directory) {
    const entries = readdirSync(fileURLToPath(new URL(`../${directory}/`, import.meta.url)), {withFileTypes: true});
    const strayTest = entries.find(entry => entry.isFile() && entry.name.endsWith('.e2e.test.ts'));
    if (strayTest) {
        throw new Error(`${directory}/${strayTest.name} is in no lane; move it into a lane directory`);
    }
    return entries
        .filter(entry => entry.isDirectory() && !NOT_LANES.has(entry.name))
        .map(entry => ({
            name: `e2e-${entry.name}`,
            directory: `${directory}/${entry.name}`,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

export function listRequiredElectronE2ELanes() {
    return listLaneDirectories(E2E_ROOT);
}

export function listNightlyElectronE2ELanes() {
    return listLaneDirectories(`${E2E_ROOT}/nightly`);
}

// `node scripts/electron-e2e-lanes.mjs >> "$GITHUB_OUTPUT"` sets the CI matrix.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(`lanes=${JSON.stringify(listRequiredElectronE2ELanes().map(lane => lane.name))}`);
}
