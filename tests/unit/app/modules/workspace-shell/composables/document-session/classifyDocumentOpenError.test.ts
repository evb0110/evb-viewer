import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TTranslateFn} from '@i18n-app';
import {BrowserQpdfEngineUnavailableError} from '@app/platform/browser-api/browserQpdfEngineClient';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {
    classifyDocumentOpenError,
    describeRefusedDocumentOpen,
} from '@app/modules/workspace-shell/composables/document-session/classifyDocumentOpenError';

describe('classifyDocumentOpenError', () => {
    it.each([
        [
            'NotAllowedError',
            'errors.browser.filePermissionDenied',
        ],
        [
            'NotReadableError',
            'errors.browser.filePermissionDenied',
        ],
        [
            'QuotaExceededError',
            'errors.browser.storageFull',
        ],
        [
            'InvalidPDFException',
            'errors.file.invalid',
        ],
        [
            'BrowserPageOpsWorkerUnavailableError',
            'errors.browser.documentToolsUnavailable',
        ],
    ])('explains a %s browser refusal on screen', (name, key) => {
        const error = Object.assign(new Error('technical detail'), {name});
        const t = ((translationKey: string) => translationKey) as TTranslateFn;
        expect(classifyDocumentOpenError(error, null, t)).toBe(key);
    });

    it('explains unavailable qpdf document tools without calling the file invalid', () => {
        const t: TTranslateFn = (key, ..._args) => String(key);
        expect(classifyDocumentOpenError(new BrowserQpdfEngineUnavailableError('Worker unavailable'), null, t))
            .toBe('errors.browser.documentToolsUnavailable');
    });

    it.each([
        [
            'html',
            'errors.file.notDjvuHtml',
        ],
        [
            'pdf',
            'errors.file.notDjvuPdf',
        ],
        [
            'zip',
            'errors.file.notDjvuZip',
        ],
        [
            'empty',
            'errors.file.notDjvuEmpty',
        ],
        [
            'unknown',
            'errors.file.notDjvu',
        ],
    ])('explains %s content in a file named .djvu through the serialized open envelope', (detectedFormat, key) => {
        const envelope = {
            code: 'not-djvu',
            detectedFormat,
            message: 'Content does not match the extension',
        };
        const error = new Error(encodeSerializableErrorEnvelope(envelope));
        const t: TTranslateFn = (translationKey, ..._args) => String(translationKey);
        expect(classifyDocumentOpenError(error, null, t)).toBe(key);
    });

    it('names the actual browser operation limit instead of the desktop encrypted-file limit', () => {
        const envelope = {
            code: 'browser-byte-limit',
            message: 'Browser operation refused',
            maxBytes: 16 * 1024 * 1024,
        };
        const error = new Error(encodeSerializableErrorEnvelope(envelope));
        const t = ((key: string, parameters?: {limitMiB?: number}) => `${key}:${parameters?.limitMiB}`) as TTranslateFn;
        expect(classifyDocumentOpenError(error, null, t)).toBe('errors.browser.documentTooLarge:16');
    });

    it.each([
        [
            'source-changed',
            'errors.file.changedWhileOpening',
        ],
        [
            'invalid-pdf',
            'errors.file.invalid',
        ],
        [
            'empty-pdf',
            'errors.file.emptyPdf',
        ],
        [
            'invalid-djvu',
            'errors.file.invalidDjvu',
        ],
        [
            'djvu-components-required',
            'errors.file.djvuComponentsRequired',
        ],
        [
            'djvu-raster-limit',
            'errors.file.djvuRasterLimit',
        ],
    ])('localizes a %s open refusal through the IPC wrapping it arrives in', (code, key) => {
        const envelope = encodeSerializableErrorEnvelope({
            code,
            message: 'The original document changed while it was being opened',
        });
        const error = new Error(
            `Error invoking remote method 'dialog:openPdfDirect': Error: Failed to open file: ${envelope}`,
        );
        const t = ((translationKey: string) => translationKey) as TTranslateFn;

        expect(classifyDocumentOpenError(error, null, t)).toBe(key);
    });
});

describe('classifyDocumentOpenError for a failure nobody explained', () => {
    it('says the file could not be opened instead of showing the native tool output', () => {
        const error = new Error(
            'djvused failed with exit code 1. *** (DjVuDocEditor.cpp:178) void DJVU::DjVuDocEditor::init(const GURL &) file://localhost/a.djvu',
        );
        const t = ((key: string) => key) as TTranslateFn;

        expect(classifyDocumentOpenError(error, null, t)).toBe('errors.file.openDescription');
    });
});

describe('classifyDocumentOpenError for a file that is gone', () => {
    it('names the file main refused to open because it is not there, never the IPC text', () => {
        const refusal = {
            code: 'not-found',
            message: 'not-found',
            fileName: 'gone.pdf',
        };
        const error = new Error(`Error invoking remote method 'dialog:openPdfDirect': Error: ${encodeSerializableErrorEnvelope(refusal)}`);
        const t = ((key: string, parameters?: {name?: string}) => `${key}:${parameters?.name ?? ''}`) as TTranslateFn;

        expect(classifyDocumentOpenError(error, null, t)).toBe('errors.file.openNotFound:gone.pdf');
    });
});

describe('describeRefusedDocumentOpen', () => {
    const t = ((key: string) => key) as TTranslateFn;

    it('names the chosen file a picker open was refused for and localizes why', () => {
        const refusal = {
            code: 'invalid-pdf',
            message: 'invalid-pdf',
            fileName: 'damaged.pdf',
        };
        const error = new Error(
            `Error invoking remote method 'dialog:openPdf': Error: ${encodeSerializableErrorEnvelope(refusal)}`,
        );

        expect(describeRefusedDocumentOpen(error, t)).toEqual({
            message: 'errors.file.invalid',
            fileName: 'damaged.pdf',
            failure: expect.objectContaining({code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED'}),
        });
    });

    it('leaves the name out when the refusal does not carry one', () => {
        const error = new Error(`Error invoking remote method 'dialog:openPdf': Error: ${encodeSerializableErrorEnvelope({
            code: 'source-changed',
            message: 'source-changed',
        })}`);

        expect(describeRefusedDocumentOpen(error, t)).toMatchObject({
            message: 'errors.file.changedWhileOpening',
            fileName: null,
        });
    });
});
