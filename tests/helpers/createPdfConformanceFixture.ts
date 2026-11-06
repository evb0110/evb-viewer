import {
    PDFDocument,
    PDFHexString,
    PDFName,
} from 'pdf-lib';

export type TPdfConformanceFixtureKind =
    | 'plain'
    | 'tagged'
    | 'acroform'
    | 'xfa'
    | 'signed'
    | 'signed-object-stream'
    | 'unsigned-signature-field';

/**
 * One-page PDFs with the catalog structure each conformance fact reads. The
 * signature is structural only: a populated /V signature dictionary, as
 * pdf-page-ops recognizes it, without a cryptographic signature. The
 * object-stream variant compresses that dictionary, so no byte marker shows it.
 */
export async function createPdfConformanceFixture(kind: TPdfConformanceFixtureKind, {padding}: {padding?: Uint8Array} = {}) {
    const pdf = await PDFDocument.create();
    // An unfiltered stream object written before the catalog structure makes
    // a large, valid fixture, its structure away from the file's first bytes.
    if (padding) pdf.context.register(pdf.context.stream(padding));
    const page = pdf.addPage([
        612,
        792,
    ]);
    page.drawText(`Conformance fixture ${kind}`, {
        x: 40,
        y: 740,
    });
    const {
        catalog,
        context,
    } = pdf;
    if (kind === 'tagged') {
        catalog.set(PDFName.of('MarkInfo'), context.obj({Marked: true}));
        catalog.set(PDFName.of('StructTreeRoot'), context.register(context.obj({Type: 'StructTreeRoot'})));
    }
    if (kind === 'acroform' || kind === 'xfa') {
        pdf.getForm().createTextField('applicant.name').addToPage(page, {
            x: 40,
            y: 600,
        });
        if (kind === 'xfa') {
            pdf.getForm().acroForm.dict.set(PDFName.of('XFA'), context.obj([]));
        }
    }
    if (kind === 'signed' || kind === 'signed-object-stream' || kind === 'unsigned-signature-field') {
        const field = context.obj({
            FT: 'Sig',
            T: PDFHexString.fromText('Signature1'),
            Type: 'Annot',
            Subtype: 'Widget',
            Rect: [
                40,
                500,
                240,
                540,
            ],
            F: 4,
            P: page.ref,
        });
        if (kind !== 'unsigned-signature-field') {
            field.set(PDFName.of('V'), context.register(context.obj({
                Type: 'Sig',
                Filter: 'Adobe.PPKLite',
                SubFilter: 'adbe.pkcs7.detached',
                ByteRange: [
                    0,
                    0,
                    0,
                    0,
                ],
                Contents: PDFHexString.of('00'.repeat(64)),
            })));
        }
        const fieldRef = context.register(field);
        page.node.set(PDFName.of('Annots'), context.obj([fieldRef]));
        catalog.set(PDFName.of('AcroForm'), context.obj({
            Fields: [fieldRef],
            SigFlags: 3,
        }));
    }
    return pdf.save({
        useObjectStreams: kind === 'signed-object-stream',
        // pdf-lib drops /XFA whenever it refreshes form appearances.
        updateFieldAppearances: kind !== 'xfa',
    });
}
