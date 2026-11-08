import {spawnSync} from 'node:child_process';
import {
    createHash, randomBytes,
} from 'node:crypto';
import {
    existsSync, mkdirSync, readFileSync, renameSync, rmSync,
} from 'node:fs';
import path from 'node:path';

/** @param {string} projectRoot @param {NodeJS.ProcessEnv} env */
export function getCargoRustcLauncher(projectRoot, env) {
    const source = path.join(projectRoot, 'scripts', 'lib', 'cargo-rustc-wrapper.rs');
    const version = spawnSync('rustc', ['-vV'], {
        encoding: 'utf8',
        env,
    });
    if (version.status !== 0) throw new Error(`Cannot identify rustc: ${version.stderr || version.error}`);
    const identity = createHash('sha256').update(readFileSync(source)).update(version.stdout).digest('hex');
    const directory = path.join(projectRoot, '.tmp', 'cargo-rustc-launcher');
    const executable = path.join(directory, `${identity}.exe`);
    if (existsSync(executable)) return executable;
    mkdirSync(directory, {recursive: true});
    const temporary = path.join(directory, `${identity}-${process.pid}-${randomBytes(8).toString('hex')}.exe`);
    try {
        const result = spawnSync('rustc', [
            source,
            '--edition=2021',
            '-o',
            temporary,
        ], {
            env,
            stdio: 'inherit',
        });
        if (result.status !== 0) throw new Error(`Cannot compile Cargo rustc launcher: ${result.error || result.status}`);
        try {
            renameSync(temporary, executable);
        } catch (error) {
            if (!existsSync(executable)) throw error;
        }
    } finally {
        rmSync(temporary, {force: true});
    }
    return executable;
}
