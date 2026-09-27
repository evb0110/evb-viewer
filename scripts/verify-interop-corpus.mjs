#!/usr/bin/env node

import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    readFile,
    stat,
} from 'node:fs/promises';
import {promisify} from 'node:util';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
} from 'node:path';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFString,
    PDFHexString,
} from 'pdf-lib';

const execFileAsync = promisify(execFile);

export const REQUIRED_CANONICAL_KINDS = Object.freeze([
    'highlight',
    'note',
    'shape',
    'stamp',
    'text-box',
]);

export const REQUIRED_CASES = Object.freeze([
    'nativeText',
    'legacyFreeTextPopup',
    'replyChain',
    'unknownVendorKey',
    'missingName',
    'richText',
    'appearance',
    'reviewState',
]);

const MARKUP_SUBTYPES = Object.freeze([
    'Highlight',
    'Underline',
    'Squiggly',
    'StrikeOut',
]);
const SHAPE_SUBTYPES = Object.freeze([
    'Square',
    'Circle',
    'Line',
    'Ink',
    'Polygon',
    'PolyLine',
    'Polyline',
]);

const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
const STOCK_PROVENANCE_KIND = 'stock-pdfjs-save-of-synthetic-input';
const PDF_NAME_KEYS = Object.freeze({
    subtype: PDFName.of('Subtype'),
    rect: PDFName.of('Rect'),
    nm: PDFName.of('NM'),
    popup: PDFName.of('Popup'),
    ap: PDFName.of('AP'),
    irt: PDFName.of('IRT'),
    rt: PDFName.of('RT'),
    state: PDFName.of('State'),
    stateModel: PDFName.of('StateModel'),
    richText: PDFName.of('RC'),
    style: PDFName.of('DS'),
    vendorKey: PDFName.of('EVBVendorKey'),
});

function error(message) {
    return new Error(`Interop corpus validation failed: ${message}`);
}

function asDictionary(value, context) {
    if (value instanceof PDFRef) {
        value = context.lookup(value);
    }
    return value instanceof PDFDict ? value : undefined;
}

function asArray(value, context) {
    if (value instanceof PDFRef) {
        value = context.lookup(value);
    }
    return value instanceof PDFArray ? value : undefined;
}

function asName(value, context) {
    if (value instanceof PDFRef) {
        value = context.lookup(value);
    }
    return value instanceof PDFName ? value.toString().slice(1) : undefined;
}

function asText(value, context) {
    if (value instanceof PDFRef) {
        value = context.lookup(value);
    }
    if (value instanceof PDFString || value instanceof PDFHexString) {
        return value.decodeText();
    }
    return undefined;
}

function hasKey(dictionary, key) {
    return dictionary.get(key) !== undefined;
}

function dictionaryValue(dictionary, key, context) {
    const value = dictionary.get(key);
    return value instanceof PDFRef ? context.lookup(value) : value;
}

function rectSize(dictionary, context) {
    const rect = asArray(dictionaryValue(dictionary, PDF_NAME_KEYS.rect, context), context);
    if (!rect || rect.size() < 4) {
        return undefined;
    }
    const values = [];
    for (let index = 0; index < 4; index += 1) {
        const value = rect.get(index);
        values.push(value?.numberValue ?? Number.NaN);
    }
    return {
        width: Math.abs(values[2] - values[0]),
        height: Math.abs(values[3] - values[1]),
    };
}

function rectValues(dictionary, context) {
    const rect = asArray(dictionaryValue(dictionary, PDF_NAME_KEYS.rect, context), context);
    if (!rect || rect.size() < 4) {
        return null;
    }
    const values = [];
    for (let index = 0; index < 4; index += 1) {
        const value = rect.get(index);
        const number = value?.numberValue;
        if (!Number.isFinite(number)) {
            return null;
        }
        values.push(number);
    }
    return {
        bottom: Math.min(values[1], values[3]),
        left: Math.min(values[0], values[2]),
        right: Math.max(values[0], values[2]),
        top: Math.max(values[1], values[3]),
    };
}

function isBlankAppearance(dictionary, context) {
    const appearance = asDictionary(
        dictionaryValue(dictionary, PDF_NAME_KEYS.ap, context),
        context,
    );
    if (!appearance) {
        return false;
    }
    const normal = dictionaryValue(appearance, PDFName.of('N'), context);
    return normal instanceof PDFRawStream && normal.contents.length === 0;
}

function isLegacyFreeTextPopup(dictionary, context) {
    if (asName(dictionaryValue(dictionary, PDF_NAME_KEYS.subtype, context), context) !== 'FreeText') {
        return false;
    }
    if (!hasKey(dictionary, PDF_NAME_KEYS.popup)) {
        return false;
    }
    const size = rectSize(dictionary, context);
    return Boolean(
        size
        && size.width <= 2
        && size.height <= 2
        && isBlankAppearance(dictionary, context),
    );
}

export function annotationKind(dictionary, context) {
    const subtype = asName(dictionaryValue(dictionary, PDF_NAME_KEYS.subtype, context), context);
    if (!subtype) {
        return undefined;
    }
    if (subtype === 'FreeText') {
        return isLegacyFreeTextPopup(dictionary, context) ? 'note' : 'text-box';
    }
    if (subtype === 'Text') {
        return 'note';
    }
    if ([
        'Highlight',
        'Underline',
        'Squiggly',
        'StrikeOut',
    ].includes(subtype)) {
        return 'highlight';
    }
    if (subtype === 'Stamp') {
        return 'stamp';
    }
    if ([
        'Square',
        'Circle',
        'Line',
        'Ink',
        'Polygon',
        'PolyLine',
        'Polyline',
    ].includes(subtype)) {
        return 'shape';
    }
    return undefined;
}

function pageAnnotationDictionaries(document) {
    const dictionaries = [];
    for (const page of document.getPages()) {
        const annotations = asArray(
            page.node.get(PDFName.of('Annots')),
            document.context,
        );
        if (!annotations) {
            continue;
        }
        for (const value of annotations.asArray()) {
            const dictionary = asDictionary(value, document.context);
            if (dictionary) {
                dictionaries.push(dictionary);
            }
        }
    }
    return dictionaries;
}

function inspectAnnotation(dictionary, context) {
    const subtype = asName(dictionaryValue(dictionary, PDF_NAME_KEYS.subtype, context), context);
    const kind = annotationKind(dictionary, context);
    const preservedKeys = [];
    for (const [
        key,
        pdfName,
    ] of Object.entries(PDF_NAME_KEYS)) {
        if ([
            'subtype',
            'rect',
            'nm',
        ].includes(key)) {
            continue;
        }
        if (hasKey(dictionary, pdfName)) {
            preservedKeys.push(pdfName.toString().slice(1));
        }
    }
    return {
        kind,
        legacyFreeTextPopup: isLegacyFreeTextPopup(dictionary, context),
        missingName: !hasKey(dictionary, PDF_NAME_KEYS.nm),
        name: asText(dictionaryValue(dictionary, PDF_NAME_KEYS.nm, context), context) ?? null,
        preservedKeys,
        rect: rectValues(dictionary, context),
        replyChain: hasKey(dictionary, PDF_NAME_KEYS.irt)
            || hasKey(dictionary, PDF_NAME_KEYS.rt),
        richText: hasKey(dictionary, PDF_NAME_KEYS.richText)
            || hasKey(dictionary, PDF_NAME_KEYS.style),
        reviewState: hasKey(dictionary, PDF_NAME_KEYS.state)
            || hasKey(dictionary, PDF_NAME_KEYS.stateModel),
        subtype,
        unknownVendorKey: hasKey(dictionary, PDF_NAME_KEYS.vendorKey),
        appearance: hasKey(dictionary, PDF_NAME_KEYS.ap),
        blankAppearance: isBlankAppearance(dictionary, context),
        nativeText: subtype === 'Text' && !isLegacyFreeTextPopup(dictionary, context),
    };
}

export async function inspectPdf(filePath) {
    const bytes = await readFile(filePath);
    const document = await PDFDocument.load(bytes, {
        ignoreEncryption: false,
        updateMetadata: false,
    });
    const annotations = pageAnnotationDictionaries(document).map(dictionary => (
        inspectAnnotation(dictionary, document.context)
    ));
    const kinds = [...new Set(annotations.map(annotation => annotation.kind).filter(Boolean))].sort();
    const subtypes = [...new Set(annotations.map(annotation => annotation.subtype).filter(Boolean))].sort();
    const variantCoverage = {
        markupSubtypes: subtypes.filter(subtype => MARKUP_SUBTYPES.includes(subtype)),
        shapeSubtypes: subtypes.filter(subtype => SHAPE_SUBTYPES.includes(subtype)),
    };
    const preservedKeys = [...new Set(annotations.flatMap(annotation => annotation.preservedKeys))].sort();
    const requiredCases = Object.fromEntries(REQUIRED_CASES.map(name => [
        name,
        annotations.some(annotation => {
            switch (name) {
                case 'nativeText':
                    return annotation.nativeText;
                case 'legacyFreeTextPopup':
                    return annotation.legacyFreeTextPopup;
                case 'replyChain':
                    return annotation.replyChain;
                case 'unknownVendorKey':
                    return annotation.unknownVendorKey;
                case 'missingName':
                    return annotation.missingName;
                case 'richText':
                    return annotation.richText;
                case 'appearance':
                    return annotation.appearance;
                case 'reviewState':
                    return annotation.reviewState;
                default:
                    return false;
            }
        }),
    ]));
    return {
        annotations,
        bytes: bytes.length,
        kinds,
        pages: document.getPageCount(),
        preservedKeys,
        requiredCases,
        subtypes,
        variantCoverage,
    };
}

export async function checkQpdf(filePath) {
    try {
        const result = await execFileAsync('qpdf', [
            '--check',
            filePath,
        ], {maxBuffer: 1024 * 1024});
        return {
            exitCode: 0,
            warnings: result.stderr.trim() ? result.stderr.trim().split('\n') : [],
            stdout: result.stdout.trim(),
        };
    } catch (caught) {
        const exitCode = Number.isInteger(caught.code) ? caught.code : null;
        if (exitCode !== 3) {
            throw error(`qpdf could not validate ${basename(filePath)}: ${caught.message}`);
        }
        return {
            exitCode,
            warnings: String(caught.stderr ?? '').trim()
                ? String(caught.stderr).trim().split('\n')
                : [],
            stdout: String(caught.stdout ?? '').trim(),
        };
    }
}

export async function validateManifest({
    corpusDirectory,
    manifest,
    runQpdf = true,
}) {
    if (!manifest || !Array.isArray(manifest.entries)) {
        throw error('manifest must contain an entries array');
    }
    if (manifest.schemaVersion !== 1) {
        throw error(`unsupported schemaVersion ${manifest.schemaVersion}`);
    }
    if (!Array.isArray(manifest.requiredKinds)
        || [...manifest.requiredKinds].sort().join('|')
            !== [...REQUIRED_CANONICAL_KINDS].sort().join('|')) {
        throw error('manifest requiredKinds must list the five canonical kinds');
    }
    const root = resolve(corpusDirectory);
    const readyEntries = manifest.entries.filter(entry => entry?.status === 'ready');
    if (manifest.entries.some(entry => entry?.status !== 'ready')) {
        throw error('manifest contains an entry that is not ready; required corpus acquisition cannot be deferred');
    }
    if (readyEntries.length === 0) {
        throw error('manifest has no ready entries');
    }
    const aggregateKinds = new Set();
    const aggregateCases = Object.fromEntries(REQUIRED_CASES.map(name => [
        name,
        false,
    ]));
    let scenarioCount = 0;
    let stockWriterEntries = 0;

    for (const entry of readyEntries) {
        if (!entry.file || typeof entry.file !== 'string' || isAbsolute(entry.file)) {
            throw error('each ready entry needs a relative file path');
        }
        const filePath = resolve(root, entry.file);
        const rel = relative(root, filePath);
        if (rel.startsWith('..') || isAbsolute(rel)) {
            throw error(`ready entry escapes corpus directory: ${entry.file}`);
        }
        let fileStat;
        try {
            fileStat = await stat(filePath);
        } catch {
            throw error(`ready fixture is missing: ${entry.file}`);
        }
        if (!fileStat.isFile()) {
            throw error(`ready fixture is not a file: ${entry.file}`);
        }
        if (fileStat.size > MAX_FIXTURE_BYTES) {
            throw error(`${entry.file} is ${fileStat.size} bytes, over the 2 MiB limit`);
        }
        const bytes = await readFile(filePath);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (entry.bytes !== bytes.length || entry.sha256 !== sha256) {
            throw error(`${entry.file} bytes or sha256 do not match the manifest`);
        }
        const inventory = await inspectPdf(filePath);
        if (entry.pages !== inventory.pages) {
            throw error(`${entry.file} page count does not match the manifest`);
        }
        for (const kind of inventory.kinds) {
            aggregateKinds.add(kind);
        }
        for (const name of REQUIRED_CASES) {
            aggregateCases[name] ||= inventory.requiredCases[name];
        }
        if (!Array.isArray(entry.kinds) || [...entry.kinds].sort().join('|') !== inventory.kinds.join('|')) {
            throw error(`${entry.file} kinds do not match its parsed annotations`);
        }
        if (!Array.isArray(entry.subtypes) || [...entry.subtypes].sort().join('|') !== inventory.subtypes.join('|')) {
            throw error(`${entry.file} subtypes do not match its parsed annotations`);
        }
        if (JSON.stringify(entry.variantCoverage ?? {}) !== JSON.stringify(inventory.variantCoverage)) {
            throw error(`${entry.file} markup/shape variant coverage does not match its parsed annotations`);
        }
        if (!Array.isArray(entry.preservedKeys)
            || [...entry.preservedKeys].sort().join('|') !== inventory.preservedKeys.join('|')) {
            throw error(`${entry.file} preservedKeys do not match its parsed annotations`);
        }
        if (!Number.isInteger(entry.scenarioCount) || entry.scenarioCount <= 0) {
            throw error(`${entry.file} must declare a positive scenarioCount`);
        }
        if (!entry.inventory
            || entry.inventory.annotationCount !== inventory.annotations.length
            || JSON.stringify(entry.inventory.requiredCases ?? {}) !== JSON.stringify(inventory.requiredCases)) {
            throw error(`${entry.file} inventory does not match its parsed annotations`);
        }
        scenarioCount += entry.scenarioCount;
        if (runQpdf) {
            const qpdf = await checkQpdf(filePath);
            if (![
                0,
                3,
            ].includes(qpdf.exitCode)) {
                throw error(`${entry.file} qpdf exit code ${qpdf.exitCode} is not allowed`);
            }
            const baseline = entry.qpdfWarningBaseline;
            if (!baseline || baseline.exitCode !== qpdf.exitCode
                || JSON.stringify(baseline.warnings ?? []) !== JSON.stringify(qpdf.warnings)) {
                throw error(`${entry.file} qpdf result differs from its recorded warning baseline`);
            }
        }
        const provenance = entry.provenance;
        if (!provenance
            || typeof provenance.kind !== 'string'
            || !provenance.method
            || !provenance.license) {
            throw error(`${entry.file} needs explicit provenance and generation method`);
        }
        if (provenance.kind === STOCK_PROVENANCE_KIND) {
            stockWriterEntries += 1;
            if (provenance.packageName !== 'pdfjs-dist-codex-preview'
                || provenance.version !== '5.4.296'
                || !String(provenance.claimLimitations ?? '').includes('not claim that stock pdf.js authored every annotation kind')) {
                throw error(`${entry.file} has an unsupported or overstated stock pdf.js provenance claim`);
            }
        }
    }

    const expectedKinds = [...REQUIRED_CANONICAL_KINDS].sort();
    const actualKinds = [...aggregateKinds].sort();
    if (expectedKinds.join('|') !== actualKinds.join('|')) {
        throw error(`ready entries cover ${actualKinds.join(', ') || 'no canonical kinds'}, expected ${expectedKinds.join(', ')}`);
    }
    const missingRequiredCases = REQUIRED_CASES.filter(name => aggregateCases[name] !== true);
    if (missingRequiredCases.length > 0) {
        throw error(`ready entries are missing required scenario cases: ${missingRequiredCases.join(', ')}`);
    }
    const declaredCases = manifest.requiredCases;
    if (!declaredCases || REQUIRED_CASES.some(name => declaredCases[name] !== aggregateCases[name])) {
        throw error('manifest requiredCases do not match the parsed fixture inventory');
    }
    if (stockWriterEntries === 0) {
        throw error('the ready corpus has no stock unpatched pdf.js writer entry');
    }
    return {
        kinds: expectedKinds,
        readyEntries: readyEntries.length,
        requiredCases: aggregateCases,
        scenarioCount,
        stockWriterEntries,
    };
}

export async function validateCorpus({
    corpusDirectory,
    runQpdf = true,
}) {
    const manifestPath = join(corpusDirectory, 'corpus-manifest.json');
    let manifest;
    try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (caught) {
        throw error(`cannot read ${manifestPath}: ${caught.message}`);
    }
    return validateManifest({
        corpusDirectory,
        manifest,
        runQpdf,
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const corpusDirectory = resolve(
        process.argv[2] ?? join(dirname(import.meta.dirname), 'tests/fixtures/electron/interop'),
    );
    try {
        const result = await validateCorpus({corpusDirectory});
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (caught) {
        process.stderr.write(`${caught.stack ?? caught}\n`);
        process.exitCode = 1;
    }
}
