import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { IPdfPathValidationOptions } from '@contracts/electronApiDocuments';
import {runtimeSchema as s} from '@contracts/platformFeature';
import {isRecord} from '@contracts/runtimeGuards';

type TPdfValidationPathArgs = [
    path: TDocumentRef,
    options?: IPdfPathValidationOptions,
];

function fail(message: string): never {
    throw new Error(message);
}

export const pdfValidationPathArgs = s.fromParser<TPdfValidationPathArgs>(
    (value) => {
        if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
            fail('expected 1-2 arguments');
        }
        const args = value as unknown[];
        const path = args[0];
        const documentRef = parseDocumentRef(path);
        if (documentRef === null) {
            fail('path must be an absolute document reference');
        }
        const rawOptions = args[1];
        if (rawOptions === undefined) {
            return [documentRef];
        }
        if (!isRecord(rawOptions) || (rawOptions.purpose !== 'opening' && rawOptions.purpose !== 'save')) {
            fail('validation options must be {purpose: \'opening\' | \'save\'}');
        }
        return [
            documentRef,
            {purpose: rawOptions.purpose},
        ];
    },
    () => [
        parseDocumentRef('/tmp/document.pdf') ?? fail('invalid fixture document reference'),
        {purpose: 'opening'},
    ],
);
