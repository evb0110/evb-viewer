import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseForESLint} from 'yaml-eslint-parser';

const GITHUB_CONFIGURATION_ROOTS = ['.github/actions', '.github/workflows'];

async function collectYamlFiles(directoryPath: string): Promise<string[]> {
    const entries = await readdir(directoryPath, {withFileTypes: true});
    const files = await Promise.all(
        entries.map(async (entry) => {
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                return collectYamlFiles(entryPath);
            }
            return /\.ya?ml$/iu.test(entry.name) ? [entryPath] : [];
        }),
    );
    return files.flat();
}

export function assertGithubActionsYamlSyntax(source: string, filePath: string) {
    try {
        parseForESLint(source, {filePath});
    } catch (error) {
        const parserError = error as Error & {
            column?: number;
            lineNumber?: number;
        };
        const location = parserError.lineNumber ? `:${parserError.lineNumber}:${parserError.column ?? 1}` : '';
        throw new Error(`${filePath}${location}: ${parserError.message}`, {cause: error});
    }
}

export async function checkGithubActionsSyntax(roots = GITHUB_CONFIGURATION_ROOTS) {
    const files = (await Promise.all(roots.map(collectYamlFiles))).flat().sort();
    for (const filePath of files) {
        assertGithubActionsYamlSyntax(await readFile(filePath, 'utf8'), filePath);
    }
    return files;
}

async function main() {
    const files = await checkGithubActionsSyntax();
    console.log(`GitHub Actions YAML syntax passed for ${files.length} file(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
