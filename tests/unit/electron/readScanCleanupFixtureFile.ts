import {readFile} from 'node:fs/promises';

function readFixtureFile(path: string): Promise<Uint8Array>;
function readFixtureFile(path: string, encoding: 'utf8'): Promise<string>;
function readFixtureFile(path: string, encoding?: 'utf8'): Promise<Uint8Array> | Promise<string> {
    calls.push([
        path,
        encoding,
    ]);
    return encoding === 'utf8' ? readFile(path, 'utf8') : readFile(path);
}

const calls: unknown[][] = [];
export const readScanCleanupFixtureFile = Object.assign(
    readFixtureFile,
    {
        mock: {calls},
        mockClear: () => {calls.length = 0;},
    },
);
