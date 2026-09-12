import {decodeTypedStagedArtifact} from '@contracts/stagedArtifacts';
import type {
    IPdfNativeStagedCommitOptions,
    IPdfSaveAsOptions,
    IPdfSaveAsWarning,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    isPdfValidationResult,
    type IPdfValidationResult,
} from '@contracts/pdfConformance';
import { isRecord } from '@contracts/runtimeGuards';
import {normalizePdfNativeAnnotationIdentityBindings} from '@contracts/nativePdfMutations';

const pdfObjectRefPattern = /^\d+\s+\d+\s+R$/u;

export function decodeOptionalDocumentObject(
    value: unknown,
    fieldName: string,
): Record<string, unknown> | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object`);
    }
    return value;
}

export function decodeRequiredDocumentObject(value: unknown, fieldName: string): Record<string, unknown> {
    const decoded = decodeOptionalDocumentObject(value, fieldName);
    if (decoded === undefined) {
        throw new Error(`${fieldName} must be an object`);
    }
    return decoded;
}

export function decodePdfSaveAsOptions(value: unknown): IPdfSaveAsOptions | undefined {
    const decoded = decodeOptionalDocumentObject(value, 'saveAsOptions');
    if (decoded === undefined) {
        return undefined;
    }
    if (decoded?.optimizeLossless !== undefined && typeof decoded.optimizeLossless !== 'boolean') {
        throw new Error('invalid PDF save-as options');
    }
    const stagedOutput = decoded.stagedOutput === undefined ? undefined : decodeTypedStagedArtifact(decoded.stagedOutput);
    if (stagedOutput === null) throw new Error('invalid PDF save-as staged output');
    return {
        ...(decoded.optimizeLossless === undefined ? {} : {optimizeLossless: decoded.optimizeLossless}),
        ...(stagedOutput ? {stagedOutput} : {}),
    };
}

export function decodePdfRevisionOptions(value: unknown): IPdfSerializedSaveOptions | undefined {
    const decoded = decodeOptionalDocumentObject(value, 'revisionOptions');
    if (decoded === undefined) {
        return undefined;
    }
    const expectedDocumentRevisionToken = typeof decoded.expectedDocumentRevisionToken === 'string'
        ? parseDocumentRevisionToken(decoded.expectedDocumentRevisionToken)
        : null;
    if (expectedDocumentRevisionToken === null) {
        throw new Error('invalid document revision options');
    }
    const changedObjectRefsValue = decoded.changedObjectRefs;
    let changedObjectRefs: string[] | undefined;
    if (changedObjectRefsValue !== undefined) {
        if (
            !Array.isArray(changedObjectRefsValue)
            || changedObjectRefsValue.length > 128
            || !changedObjectRefsValue.every((ref): ref is string =>
                typeof ref === 'string' && pdfObjectRefPattern.test(ref))
        ) {
            throw new Error('invalid changed PDF object references');
        }
        changedObjectRefs = changedObjectRefsValue;
    }
    const workingCopyOnly = decoded.workingCopyOnly;
    if (workingCopyOnly !== undefined && workingCopyOnly !== true) {
        throw new Error('invalid working-copy-only PDF staging option');
    }
    return {
        expectedDocumentRevisionToken,
        ...(changedObjectRefs?.length
            ? {changedObjectRefs: [...new Set(changedObjectRefs)]}
            : {}),
        ...(workingCopyOnly === true ? {workingCopyOnly: true as const} : {}),
    };
}

export function decodePdfNativeStagedCommitOptions(value: unknown): IPdfNativeStagedCommitOptions | undefined {
    const decoded = decodePdfRevisionOptions(value);
    if (decoded === undefined) {
        return undefined;
    }
    const raw = decodeRequiredDocumentObject(value, 'revisionOptions');
    const identityBindings = normalizePdfNativeAnnotationIdentityBindings(
        raw.identityBindings,
        'revisionOptions.identityBindings',
        {errorKind: 'error'},
    );
    return {
        ...decoded,
        ...(raw.identityBindings === undefined ? {} : {identityBindings}),
    };
}

export function appendOptionalDocumentArg<TBase extends unknown[], TValue>(
    base: TBase,
    value: TValue | undefined,
): TBase | [...TBase, TValue] {
    return value === undefined ? base : [
        ...base,
        value,
    ];
}

export function decodePdfValidation(value: unknown): IPdfValidationResult {
    if (!isPdfValidationResult(value)) {
        throw new Error('invalid PDF validation result');
    }
    return {
        isValid: value.isValid,
        tool: value.tool,
        errors: [...value.errors],
        warnings: [...value.warnings],
    };
}

export function decodeNullablePdfValidation(value: unknown): IPdfValidationResult | null {
    return value === null ? null : decodePdfValidation(value);
}

export function decodeSaveAsWarning(value: unknown): IPdfSaveAsWarning | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)
        || value.reason !== 'working-copy-sync-required'
        || typeof value.message !== 'string') {
        throw new Error('invalid PDF save-as warning');
    }
    return {
        reason: value.reason,
        message: value.message,
    };
}

export function decodePdfPathValidationResult(value: unknown) {
    if (!isRecord(value) || (value.path !== null && typeof value.path !== 'string')) {
        throw new Error('invalid PDF persistence result');
    }
    const path = value.path === null ? null : parseDocumentRef(value.path);
    if (value.path !== null && path === null) {
        throw new Error('invalid PDF persistence path');
    }
    const warning = decodeSaveAsWarning(value.warning);
    return {
        path,
        validation: decodeNullablePdfValidation(value.validation),
        ...(warning === undefined ? {} : {warning}),
    };
}
