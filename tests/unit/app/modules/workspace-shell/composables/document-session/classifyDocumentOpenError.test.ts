import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TTranslateFn} from '@i18n-app';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {
    classifyDocumentOpenError,
    describeRefusedDocumentOpen,
} from '@app/modules/workspace-shell/composables/document-session/classifyDocumentOpenError';

describe('classifyDocumentOpenError', () => {
    it('localizes a serialized encrypted PDF size-limit failure', () => {
        const error = new Error(encodeSerializableErrorEnvelope({
            code: 'too-large',
            message: 'Encrypted PDF input exceeds the admission ceiling',
        }));
        const t = ((key: string) => key) as TTranslateFn;

        expect(classifyDocumentOpenError(error, null, t))
            .toBe('errors.file.encryptedTooLarge');
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

describe('classifyDocumentOpenError for a file that is gone', () => {
    it('names the file main refused to open because it is not there, never the IPC text', () => {
        const error = new Error(`Error invoking remote method 'dialog:openPdfDirect': Error: ${encodeSerializableErrorEnvelope({
            code: 'not-found',
            message: 'not-found',
            fileName: 'gone.pdf',
        })}`);
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
