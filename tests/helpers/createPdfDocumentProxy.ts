import type {PDFDocumentProxy} from 'pdfjs-dist';

type TPdfDocumentProxyFixture = Omit<Partial<PDFDocumentProxy>, 'annotationStorage'> & {annotationStorage?: object} & Record<
        string,
        unknown
    >;

export function createPdfDocumentProxy(fixture: TPdfDocumentProxyFixture = {annotationStorage: {}}): PDFDocumentProxy {
    // The consumers covered by this fixture read only annotationStorage. Keep
    // the intentionally small proxy explicit instead of hiding an arbitrary
    // object-to-PDFDocumentProxy conversion behind a generic cast helper.
    return fixture as PDFDocumentProxy;
}
