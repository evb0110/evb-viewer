import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    access,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFStream,
    PDFString,
} from 'pdf-lib';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {TPdfNativeMutationSetNativeToolPayload} from '@contracts/nativePdfMutations';
import {requirePageIndex} from '@contracts/pageNumbers';
import {formatPdfJsAnnotationRef} from '@app/utils/pdfAnnotationRefs';

const execFileAsync = promisify(execFile);
const NATIVE_LIFECYCLE_TIMEOUT_MS = 120_000;
const ONE_PIXEL_JPEG = Buffer.from([
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgG',
    'BgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAAB',
    'AAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAA',
    'AAD/2gAIAQEAAD8AVN//2Q==',
].join(''), 'base64');

function nativeBinaryPath() {
    const configured = process.env.EVB_PDF_PAGE_OPS_PATH?.trim();
    if (configured) {
        return resolve(configured);
    }
    const extension = process.platform === 'win32' ? '.exe' : '';
    return resolve(
        '.tmp',
        'pdf-page-ops',
        `${process.platform}-${process.arch}`,
        'bin',
        `evb-pdf-page-ops${extension}`,
    );
}

function decodePdfText(value: unknown) {
    return value instanceof PDFString || value instanceof PDFHexString
        ? value.decodeText()
        : null;
}

function refTag(ref: PDFRef) {
    return `${ref.objectNumber}R${ref.generationNumber}`;
}

function countPlacedImageGraphObjects(document: PDFDocument, stableKey: string) {
    let forms = 0;
    let images = 0;
    let matchingNames = 0;
    let stamps = 0;
    for (const entry of document.context.enumerateIndirectObjects()) {
        const object = entry[1];
        const dictionary = object instanceof PDFStream
            ? object.dict
            : object instanceof PDFDict ? object : null;
        const subtype = dictionary?.get(PDFName.of('Subtype'))?.toString();
        if (subtype === '/Stamp') {
            stamps += 1;
            if (decodePdfText(dictionary?.get(PDFName.of('NM'))) === stableKey) {
                matchingNames += 1;
            }
        } else if (subtype === '/Form') {
            forms += 1;
        } else if (subtype === '/Image') {
            images += 1;
        }
    }
    return {
        forms,
        images,
        matchingNames,
        stamps,
    };
}

function inspectPlacedImageGraph(document: PDFDocument) {
    const page = document.getPages()[0]!;
    const annots = page.node.Annots();
    const refs = annots instanceof PDFArray
        ? annots.asArray().filter((value): value is PDFRef => value instanceof PDFRef)
        : [];
    expect(refs).toHaveLength(1);
    const stampRef = refs[0]!;
    const stamp = document.context.lookup(stampRef, PDFDict);
    expect(stamp.get(PDFName.of('Subtype'))?.toString()).toBe('/Stamp');
    const appearance = stamp.lookup(PDFName.of('AP'), PDFDict);
    const appearanceRef = appearance.get(PDFName.of('N'));
    expect(appearanceRef).toBeInstanceOf(PDFRef);
    const formRef = appearanceRef as PDFRef;
    const form = document.context.lookup(formRef, PDFStream);
    expect(form.dict.get(PDFName.of('Subtype'))?.toString()).toBe('/Form');
    const resources = form.dict.lookup(PDFName.of('Resources'), PDFDict);
    const xobjects = resources.lookup(PDFName.of('XObject'), PDFDict);
    const imageRefs = xobjects.values()
        .filter((value): value is PDFRef => value instanceof PDFRef);
    expect(imageRefs).toHaveLength(1);
    const imageRef = imageRefs[0]!;
    const image = document.context.lookup(imageRef, PDFStream);
    expect(image.dict.get(PDFName.of('Subtype'))?.toString()).toBe('/Image');
    const rect = stamp.lookup(PDFName.of('Rect'), PDFArray).asArray()
        .map(value => value instanceof PDFNumber ? value.asNumber() : Number.NaN);
    return {
        imageRef,
        name: decodePdfText(stamp.get(PDFName.of('NM'))),
        rect,
        stampRef,
        formRef,
    };
}

describe('native placed-image lifecycle integration', () => {
    let tempRoot = '';

    afterEach(async () => {
        if (tempRoot) {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
            tempRoot = '';
        }
    });

    it('places, reopens, updates, reopens, deletes, and reopens one stable live image graph', async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-native-image-lifecycle-'));
        const binaryPath = nativeBinaryPath();
        const qpdfPath = process.env.EVB_QPDF_PATH?.trim() || 'qpdf';
        await access(binaryPath);
        const pdfPath = join(tempRoot, 'lifecycle.pdf');
        const imagePath = join(tempRoot, 'pixel.jpg');
        const source = await PDFDocument.create();
        source.addPage([
            600,
            800,
        ]);
        await writeFile(pdfPath, await source.save());
        await writeFile(imagePath, ONE_PIXEL_JPEG);
        const stableKey = 'placed-image-integration-1';
        const pageIndex = requirePageIndex(0, 1);
        const imageSource = {
            byteLength: ONE_PIXEL_JPEG.byteLength,
            bytesPath: imagePath,
            sha256: createHash('sha256').update(ONE_PIXEL_JPEG).digest('hex'),
        };

        const runMutation = async (
            mutation: TPdfNativeMutationSetNativeToolPayload,
            sequence: number,
        ) => {
            const mutationPath = join(tempRoot, `mutation-${sequence}.json`);
            await writeFile(mutationPath, `${JSON.stringify(mutation)}\n`, 'utf8');
            await execFileAsync(binaryPath, [
                'save-mutations',
                '--input',
                pdfPath,
                '--output',
                pdfPath,
                '--mutations-file',
                mutationPath,
                '--modified-at',
                `D:20260829120${sequence}00+04'00'`,
                '--qpdf',
                qpdfPath,
                '--append',
            ], {
                encoding: 'utf8',
                maxBuffer: 512 * 1024,
                timeout: NATIVE_LIFECYCLE_TIMEOUT_MS,
            });
            await execFileAsync(qpdfPath, [
                '--check',
                pdfPath,
            ], {
                encoding: 'utf8',
                timeout: NATIVE_LIFECYCLE_TIMEOUT_MS,
            });
        };

        await runMutation({placedImages: [{
            ...imageSource,
            height: 0.2,
            mimeType: 'image/jpeg',
            pageIndex,
            rotationDegrees: 0,
            stableKey,
            width: 0.3,
            x: 0.1,
            y: 0.25,
        }]}, 1);
        const placedDocument = await PDFDocument.load(await readFile(pdfPath), {updateMetadata: false});
        const placed = inspectPlacedImageGraph(placedDocument);
        expect(placed.name).toBe(stableKey);
        expect(countPlacedImageGraphObjects(placedDocument, stableKey)).toEqual({
            forms: 1,
            images: 1,
            matchingNames: 1,
            stamps: 1,
        });

        await runMutation({placedImages: [{
            ...imageSource,
            annotationId: formatPdfJsAnnotationRef({
                generationNumber: placed.stampRef.generationNumber,
                objectNumber: placed.stampRef.objectNumber,
            }),
            height: 0.3,
            mimeType: 'image/jpeg',
            pageIndex,
            rotationDegrees: 0,
            stableKey,
            width: 0.2,
            x: 0.55,
            y: 0.4,
        }]}, 2);
        const updatedDocument = await PDFDocument.load(await readFile(pdfPath), {updateMetadata: false});
        const updated = inspectPlacedImageGraph(updatedDocument);
        expect({
            formRef: refTag(updated.formRef),
            imageRef: refTag(updated.imageRef),
            name: updated.name,
            stampRef: refTag(updated.stampRef),
        }).toEqual({
            formRef: refTag(placed.formRef),
            imageRef: refTag(placed.imageRef),
            name: stableKey,
            stampRef: refTag(placed.stampRef),
        });
        expect(updated.rect).not.toEqual(placed.rect);
        expect(countPlacedImageGraphObjects(updatedDocument, stableKey)).toEqual({
            forms: 1,
            images: 1,
            matchingNames: 1,
            stamps: 1,
        });

        await runMutation({deletes: [{
            generationNumber: updated.stampRef.generationNumber,
            objectNumber: updated.stampRef.objectNumber,
            pageIndex,
            stableKey,
        }]}, 3);
        const deletedDocument = await PDFDocument.load(await readFile(pdfPath), {updateMetadata: false});
        expect(deletedDocument.getPages()[0]!.node.Annots()?.asArray() ?? []).toEqual([]);
        expect(deletedDocument.context.lookupMaybe(updated.stampRef, PDFDict)).toBeUndefined();
        // Appearance resources may be shared and must survive saved-deletion undo.
        // The removed stamp is no longer reachable from the page's annotation list.
        expect(deletedDocument.context.lookupMaybe(updated.formRef, PDFStream)).toBeInstanceOf(PDFStream);
        expect(deletedDocument.context.lookupMaybe(updated.imageRef, PDFStream)).toBeInstanceOf(PDFStream);
        expect(countPlacedImageGraphObjects(deletedDocument, stableKey)).toEqual({
            forms: 1,
            images: 1,
            matchingNames: 0,
            stamps: 0,
        });
    });
});
