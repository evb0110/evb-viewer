import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');

const sourceCssPath = path.join(
    projectRoot,
    'node_modules',
    'pdfjs-dist',
    'web',
    'pdf_viewer.css',
);
const sourceImagesDir = path.join(
    projectRoot,
    'node_modules',
    'pdfjs-dist',
    'web',
    'images',
);
const targetCssPath = path.join(
    projectRoot,
    'app',
    'assets',
    'css',
    'vendor',
    'pdfjs-viewer-sanitized.css',
);
const targetImagesDir = path.join(projectRoot, 'public', 'pdfjs', 'images');

const removableRulePatterns = [
    '.dialog.newAltText',
    '#viewsManager',
    '#outerContainer.viewsManager',
];

function collectBlockRanges(cssText, shouldRemoveBlock) {
    const ranges = [];
    const stack = [{ segmentStart: 0 }];

    let inComment = false;
    let inString = false;
    let stringChar = '';

    for (let index = 0; index < cssText.length; index += 1) {
        const current = cssText[index];
        const next = cssText[index + 1];

        if (inComment) {
            if (current === '*' && next === '/') {
                inComment = false;
                index += 1;
            }
            continue;
        }

        if (inString) {
            if (current === '\\') {
                index += 1;
                continue;
            }
            if (current === stringChar) {
                inString = false;
                stringChar = '';
            }
            continue;
        }

        if (current === '/' && next === '*') {
            inComment = true;
            index += 1;
            continue;
        }

        if (current === '"' || current === '\'') {
            inString = true;
            stringChar = current;
            continue;
        }

        if (current === '{') {
            const parent = stack[stack.length - 1];
            const preludeStart = parent.segmentStart;
            stack.push({
                segmentStart: index + 1,
                preludeStart,
                braceStart: index,
                prelude: cssText.slice(preludeStart, index),
            });
            continue;
        }

        if (current !== '}' || stack.length === 1) {
            continue;
        }

        const block = stack.pop();
        const blockEnd = index + 1;
        const body = cssText.slice(block.braceStart + 1, index);
        const prelude = block.prelude.trim();
        if (shouldRemoveBlock(prelude, body)) {
            ranges.push({
                start: block.preludeStart,
                end: blockEnd,
            });
        }

        const parent = stack[stack.length - 1];
        parent.segmentStart = blockEnd;
    }

    return ranges;
}

function applyRanges(cssText, ranges) {
    if (ranges.length === 0) {
        return cssText;
    }

    const sorted = ranges.sort((a, b) => b.start - a.start);
    let output = cssText;
    for (const range of sorted) {
        output = `${output.slice(0, range.start)}\n${output.slice(range.end)}`;
    }
    return output;
}

function removeUnusedUiBlocks(cssText) {
    const removableRules = collectBlockRanges(
        cssText,
        (prelude) => removableRulePatterns.some(pattern => prelude.includes(pattern)),
    );
    let sanitized = applyRanges(cssText, removableRules);

    while (true) {
        const emptyAtRules = collectBlockRanges(sanitized, (prelude, body) => {
            if (!prelude.startsWith('@')) {
                return false;
            }

            const compactBody = body
                .replace(/\/\*[\s\S]*?\*\//gu, '')
                .trim();
            return compactBody.length === 0;
        });

        if (emptyAtRules.length === 0) {
            break;
        }

        sanitized = applyRanges(sanitized, emptyAtRules);
    }

    return sanitized;
}

function rewriteImageUrls(cssText, sourceImageNames) {
    const availableImageNames = new Set(sourceImageNames);

    let sanitized = cssText.replace(
        /url\((['"]?)images\/([^)"']+)\1\)/gu,
        (fullMatch, _quote, rawName) => {
            const imageName = String(rawName).trim();
            if (!availableImageNames.has(imageName)) {
                return '__PDFJS_MISSING_ASSET__';
            }

            return `url('/pdfjs/images/${imageName}')`;
        },
    );

    sanitized = sanitized.replace(
        /^[ \t]*[^{}\n]+:\s*__PDFJS_MISSING_ASSET__[^;]*;\s*$/gmu,
        '',
    );

    return sanitized;
}

function collectReferencedImages(cssText) {
    const images = new Set();
    for (const match of cssText.matchAll(/\/pdfjs\/images\/([^)'"?\s]+)/gu)) {
        images.add(match[1]);
    }
    return Array.from(images).sort((a, b) => a.localeCompare(b));
}

function normalizeWhitespace(cssText) {
    return cssText
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .concat('\n');
}

async function syncImages(imageNames) {
    await rm(targetImagesDir, {
        recursive: true,
        force: true,
    });
    await mkdir(targetImagesDir, { recursive: true });

    await Promise.all(imageNames.map(async (imageName) => {
        const sourcePath = path.join(sourceImagesDir, imageName);
        const targetPath = path.join(targetImagesDir, imageName);
        await copyFile(sourcePath, targetPath);
    }));
}

async function main() {
    const [sourceCss, sourceImages] = await Promise.all([
        readFile(sourceCssPath, 'utf8'),
        readdir(sourceImagesDir),
    ]);

    const withoutUnusedUi = removeUnusedUiBlocks(sourceCss);
    const rewrittenUrls = rewriteImageUrls(withoutUnusedUi, sourceImages);
    const withoutEmptyRules = applyRanges(
        rewrittenUrls,
        collectBlockRanges(rewrittenUrls, (prelude, body) => (
            !prelude.startsWith('@')
            && body.replace(/\/\*[\s\S]*?\*\//gu, '').trim().length === 0
        )),
    );
    const normalizedCss = normalizeWhitespace(
        `/* Auto-generated by scripts/sync-pdfjs-viewer-css.mjs. */\n\n${withoutEmptyRules}`,
    );
    const referencedImages = collectReferencedImages(normalizedCss);

    await mkdir(path.dirname(targetCssPath), { recursive: true });
    await writeFile(targetCssPath, normalizedCss, 'utf8');
    await syncImages(referencedImages);

    console.log(
        `Synced PDF.js viewer CSS (${referencedImages.length} image assets): ${path.relative(projectRoot, targetCssPath)}`,
    );
}

main().catch((error) => {
    console.error('Failed to sync PDF.js viewer CSS:', error);
    process.exit(1);
});
