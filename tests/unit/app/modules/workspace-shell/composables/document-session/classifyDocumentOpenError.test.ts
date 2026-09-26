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
});
