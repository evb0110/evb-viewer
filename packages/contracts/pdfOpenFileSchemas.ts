import type {TOpenFileResult} from '@contracts/electronApiDocuments';
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
        if (typeof value.originalPath !== 'string' || value.originalPath.length === 0) {
            fail('invalid encrypted PDF open-file result');
        }
        return {
            kind: value.kind,
            originalPath: value.originalPath,
        };
    }
    if (value.kind === 'djvu') {
        if (value.workingPath !== '' || typeof value.originalPath !== 'string' || value.originalPath.length === 0) {
            fail('invalid DjVu open-file result');
        }
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: value.originalPath,
        };
    }
    if (
        typeof value.workingPath !== 'string'
        || value.workingPath.length === 0
        || typeof value.originalPath !== 'string'
        || value.originalPath.length === 0
        || (value.isGenerated !== undefined && typeof value.isGenerated !== 'boolean')
        || (value.wasEncrypted !== undefined && value.wasEncrypted !== true)
    ) {
        fail('invalid PDF open-file result');
    }
    const openingGeometry = value.openingGeometry === undefined
        ? undefined
        : decodeOpeningGeometry(value.openingGeometry);
    return {
        kind: 'pdf',
        workingPath: value.workingPath,
        originalPath: value.originalPath,
        ...(value.isGenerated === undefined ? {} : {isGenerated: value.isGenerated}),
        ...(value.wasEncrypted === true ? {wasEncrypted: true as const} : {}),
        ...(openingGeometry === undefined ? {} : {openingGeometry}),
    };
}

export const openFileResult = s.fromParser<TOpenFileResult | null>(decodeOpenFileResult, () => null);
