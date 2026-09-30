import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TTranslateFn} from '@i18n-app';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';
import {classifyDocumentOpenError} from '@app/modules/workspace-shell/composables/document-session/classifyDocumentOpenError';

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
