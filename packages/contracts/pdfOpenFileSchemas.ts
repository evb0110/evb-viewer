import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    decodeOpeningGeometry,
    fail,
} from '@contracts/documentsPlatformFeatureNativePageSchemas';
import {runtimeSchema as s} from '@contracts/platformFeature';
import {isRecord} from '@contracts/runtimeGuards';

export function decodeOpenFileResult(value: unknown): TOpenFileResult | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value) || (
        value.kind !== 'pdf'
        && value.kind !== 'djvu'
        && value.kind !== 'pdf-needs-password'
        && value.kind !== 'pdf-unsupported-encryption'
    )) {
        fail('invalid open-file result');
    }
    if (value.kind === 'pdf-needs-password' || value.kind === 'pdf-unsupported-encryption') {
        const originalPath = parseDocumentRef(value.originalPath);
        if (originalPath === null) {
            fail('invalid encrypted PDF open-file result');
        }
        return {
            kind: value.kind,
            originalPath,
        };
    }
    if (value.kind === 'djvu') {
        const originalPath = parseDocumentRef(value.originalPath);
        if (value.workingPath !== '' || originalPath === null) {
            fail('invalid DjVu open-file result');
        }
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath,
        };
    }
    const workingPath = parseDocumentRef(value.workingPath);
    const originalPath = parseDocumentRef(value.originalPath);
    if (
        workingPath === null
        || originalPath === null
        || (value.isGenerated !== undefined && typeof value.isGenerated !== 'boolean')
        || (value.recoveryDirtyBaseline !== undefined && typeof value.recoveryDirtyBaseline !== 'boolean')
        || (value.wasEncrypted !== undefined && value.wasEncrypted !== true)
    ) {
        fail('invalid PDF open-file result');
    }
    const openingGeometry = value.openingGeometry === undefined
        ? undefined
        : decodeOpeningGeometry(value.openingGeometry);
    return {
        kind: 'pdf',
        workingPath,
        originalPath,
        ...(value.isGenerated === undefined ? {} : {isGenerated: value.isGenerated}),
        ...(value.recoveryDirtyBaseline === undefined ? {} : {recoveryDirtyBaseline: value.recoveryDirtyBaseline}),
        ...(value.wasEncrypted === true ? {wasEncrypted: true as const} : {}),
        ...(openingGeometry === undefined ? {} : {openingGeometry}),
    };
}

export const openFileResult = s.fromParser<TOpenFileResult | null>(decodeOpenFileResult, () => null);
