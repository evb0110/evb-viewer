import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');
const allowlistPath = path.join(projectRoot, 'scripts', 'build-warning-allowlist.json');

function parseWarningBlocks(logText) {
    const lines = logText.split(/\r?\n/u);
    const warnings = [];

    for (let i = 0; i < lines.length; i += 1) {
        if (!/^\s*WARN\b/u.test(lines[i])) {
            continue;
        }

        const blockLines = [];
        const headerTail = lines[i].replace(/^\s*WARN\s*/u, '').trim();
        blockLines.push(headerTail.length > 0 ? `WARN ${headerTail}` : 'WARN');

        let cursor = i + 1;
        while (cursor < lines.length) {
            const next = lines[cursor];
            if (/^\s*WARN\b/u.test(next)) {
                break;
            }
            if (next.trim().length === 0) {
                if (blockLines.length > 1) {
                    break;
                }
                cursor += 1;
                continue;
            }

            blockLines.push(next.trimEnd());
            cursor += 1;
        }

        warnings.push(blockLines.join('\n').trim());
        i = cursor - 1;
    }

    return warnings;
}

function getWarningSignature(block) {
    const lines = block
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    const resolutionWarning = lines.find(line => line.includes('didn\'t resolve at build time'));
    if (resolutionWarning) {
        return resolutionWarning;
    }

    const postcssWarning = lines.find(line => line.includes('[vite:css][postcss] Error:'));
    if (postcssWarning) {
        return postcssWarning;
    }

    return lines[0] ?? block;
}

async function main() {
    const logPathArgument = process.argv[2];
    if (!logPathArgument) {
        console.error('Usage: node scripts/check-build-warnings.mjs <build-log-path>');
        process.exit(1);
    }

    const [allowlistRaw, logRaw] = await Promise.all([
        readFile(allowlistPath, 'utf8'),
        readFile(path.resolve(projectRoot, logPathArgument), 'utf8'),
    ]);

    const allowlistData = JSON.parse(allowlistRaw);
    const allowedWarningPatterns = Array.isArray(allowlistData.allowedWarningPatterns)
        ? allowlistData.allowedWarningPatterns
        : [];
    const allowlistMatchers = allowedWarningPatterns.map(pattern => new RegExp(pattern, 'u'));

    const warningBlocks = parseWarningBlocks(logRaw);
    const warningSignatures = warningBlocks.map(getWarningSignature);
    const unknownWarnings = warningSignatures.filter(signature =>
        !allowlistMatchers.some(matcher => matcher.test(signature)),
    );

    if (unknownWarnings.length > 0) {
        console.error('Build warning check failed. Unknown warnings found:');
        for (const warning of unknownWarnings) {
            console.error(`- ${warning}`);
        }
        process.exit(1);
    }

    if (warningSignatures.length === 0) {
        console.log('Build warning check passed: no warnings found.');
        return;
    }

    console.log(`Build warning check passed: ${warningSignatures.length} known warning(s).`);
}

main().catch((error) => {
    console.error('Failed to check build warnings:', error);
    process.exit(1);
});
