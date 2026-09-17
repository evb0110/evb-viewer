#!/usr/bin/env node

import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

function parseArgs(argv) {
    const options = {
        report: null,
        reference: null,
    };
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (
            !value ||
            ![
                '--report',
                '--reference',
            ].includes(flag)
        ) {
            throw new Error('usage: assert-calibration.mjs --report <current.json> --reference <green.json>');
        }
        options[flag.slice(2)] = resolve(value);
    }
    if (!options.report || !options.reference) {
        throw new Error('both --report and --reference are required');
    }
    return options;
}

const options = parseArgs(process.argv.slice(2));
const [
    report,
    reference,
] = await Promise.all(
    [
        readFile(options.report, 'utf8').then(JSON.parse),
        readFile(options.reference, 'utf8').then(JSON.parse),
    ],
);
if (report.schemaVersion !== 3 || reference.schemaVersion !== 3) {
    throw new Error('stroke-weight calibration pin requires schemaVersion 3');
}
if (report.oracle !== reference.oracle) {
    throw new Error(`stroke-weight oracle changed: ${reference.oracle} -> ${report.oracle}`);
}
if (!isDeepStrictEqual(report.calibration, reference.calibration)) {
    throw new Error(
        `stroke-weight measurement identity changed: ${JSON.stringify(report.calibration)}`,
    );
}
if (!report.summary.gatePass || report.summary.offenderCount !== 0) {
    throw new Error(`stroke-weight calibration is red: ${JSON.stringify(report.summary)}`);
}
if (report.summary.subFloorComponentCount > reference.summary.subFloorComponentCount) {
    throw new Error(
        `sub-floor fragments increased: ${reference.summary.subFloorComponentCount} -> ${report.summary.subFloorComponentCount}`,
    );
}
const referencePages = new Map(
    reference.pages.map(page => [
        page.imageName,
        page,
    ]),
);
for (const page of report.pages) {
    const expected = referencePages.get(page.imageName);
    if (!expected) throw new Error(`unexpected calibration page ${page.imageName}`);
    if (page.offenderCount !== 0) throw new Error(`${page.imageName} has ${page.offenderCount} offenders`);
    if (page.maxLineP95P50Ratio > expected.maxLineP95P50Ratio + 1e-6) {
        throw new Error(
            `${page.imageName} p95/p50 regressed: ${expected.maxLineP95P50Ratio} -> ${page.maxLineP95P50Ratio}`,
        );
    }
    if (page.subFloorComponentCount > expected.subFloorComponentCount) {
        throw new Error(
            `${page.imageName} sub-floor fragments increased: ${expected.subFloorComponentCount} -> ${page.subFloorComponentCount}`,
        );
    }
    referencePages.delete(page.imageName);
}
if (referencePages.size > 0) {
    throw new Error(`missing calibration pages: ${[...referencePages.keys()].join(', ')}`);
}
process.stdout.write(
    `Stroke-weight calibration pinned: 0 offenders, ${report.summary.subFloorComponentCount} sub-floor components.\n`,
);
