import type {
    IPdfNativeTextBoxMutation,
    IPdfNativeTextBoxAppearanceRequest,
    IPdfNativeTextBoxAppearanceMetadata,
} from '@contracts/electronApiDocuments';
import {firstUnsupportedAnnotationCharacter} from '@contracts/firstUnsupportedAnnotationCharacter';
import {parsePdfAnnotationRef} from '@contracts/pdfAnnotationRefs';
import {PDF_NATIVE_IDENTITY_BINDING_LIMITS} from '@contracts/nativePdfIdentityBindings';
import {requirePageIndex} from '@contracts/pageNumbers';
import {isRecord} from '@contracts/runtimeGuards';
import {
    PDF_NATIVE_MUTATION_LIMITS,
    fail,
    isNativeF32,
    isPdfRotation,
    normalizeNativeF32,
    normalizeOptionalString,
    normalizeOptionalTimestamp,
    type IPdfNativeValidationOptions,
} from '@contracts/nativePdfMutationAdmission';
import * as v from 'valibot';

export const PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS = {
    textBoxes: 256,
    textBoxTextBytes: 64 * 1024,
    totalTextBytes: 1024 * 1024,
    requestBytes: 8 * 1024 * 1024,
    /** Encoded PDF bytes; decoded PDF.js resources use their own admission. */
    outputBytes: 16 * 1024 * 1024,
} as const;

const textBoxSourceNumber = v.pipe(v.number(), v.finite(), v.check(isNativeF32, 'must fit a native PDF number'));
const textBoxSourceInset = v.pipe(textBoxSourceNumber, v.minValue(0));
const textBoxSourceRect = v.strictTuple([
    textBoxSourceNumber,
    textBoxSourceNumber,
    textBoxSourceNumber,
    textBoxSourceNumber,
]);
const textBoxSourceColor = v.pipe(v.array(v.pipe(textBoxSourceNumber, v.minValue(0), v.maxValue(1))),
    v.check(value => [
        1,
        3,
        4,
    ].includes(value.length), 'must have one, three or four color components'));
export const PDF_NATIVE_TEXT_BOX_SOURCE_DESCRIPTOR_SCHEMA = v.pipe(v.strictObject({
    version: v.literal(1),
    settlementRect: v.exactOptional(v.pipe(textBoxSourceRect, v.check(r => r[2] > r[0] && r[3] > r[1], 'must have positive dimensions'))),
    rawRD: v.exactOptional(v.strictTuple([
        textBoxSourceInset,
        textBoxSourceInset,
        textBoxSourceInset,
        textBoxSourceInset,
    ])),
    borderWidth: textBoxSourceInset,
    borderColor: v.exactOptional(textBoxSourceColor),
    background: v.exactOptional(textBoxSourceColor),
    staleFill: v.boolean(),
}), v.check(value => (value.borderWidth > 0) === (value.borderColor !== undefined), 'border color must match a positive border width'));

export function normalizePdfNativeTextBoxAppearanceRequest(
    value: unknown,
    options: IPdfNativeValidationOptions = {},
): IPdfNativeTextBoxAppearanceRequest {
    if (!isRecord(value) || !isRecord(value.page) || !Array.isArray(value.textBoxes)
        || value.textBoxes.length === 0 || value.textBoxes.length > PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.textBoxes) {
        fail('Text box appearance requires a page and 1 to 256 text boxes', options);
    }
    const page = value.page;
    const pageView = v.safeParse(textBoxSourceRect, page.view);
    if (!pageView.success || pageView.output[2] <= pageView.output[0] || pageView.output[3] <= pageView.output[1]
        || !isPdfRotation(page.rotation) || typeof page.userUnit !== 'number' || !isNativeF32(page.userUnit) || page.userUnit <= 0 || page.userUnit > 75_000) {
        fail('Invalid text box appearance page', options);
    }
    let totalBytes = 0;
    const keys = new Set<string>();
    const textBoxes = value.textBoxes.map((input, index) => {
        if (!isRecord(input)) fail('Invalid text box appearance input', options);
        const textBox = normalizeTextBoxes([input.textBox], `textBoxes[${index}]`, options)[0]!;
        if (textBox.originalAppearance?.sourceAnnotationId !== undefined || keys.has(textBox.stableKey)) {
            fail('Text box appearance input must have unique keys and inline or derived paint', options);
        }
        keys.add(textBox.stableKey);
        totalBytes += new TextEncoder().encode(textBox.text).byteLength;
        const source = input.source === undefined
            ? undefined : v.safeParse(PDF_NATIVE_TEXT_BOX_SOURCE_DESCRIPTOR_SCHEMA, input.source);
        if (source && !source.success) fail(`textBoxes[${index}].source must be a valid text box source descriptor`, options);
        return {
            textBox,
            ...(source === undefined ? {} : {source: source.output}),
        };
    });
    if (totalBytes > PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.totalTextBytes) {
        fail('Text box appearance batch exceeds its 1 MiB text ceiling', options);
    }
    return {
        page: {
            view: pageView.output,
            rotation: page.rotation,
            userUnit: page.userUnit,
        },
        textBoxes,
    };
}

export function normalizePdfNativeTextBoxAppearanceMetadata(
    value: unknown,
    options: IPdfNativeValidationOptions = {},
): IPdfNativeTextBoxAppearanceMetadata {
    const positiveRect = v.pipe(textBoxSourceRect, v.check(r => r[2] > r[0] && r[3] > r[1]));
    const metadata = v.safeParse(v.strictObject({textBoxes: v.pipe(v.array(v.strictObject({
        stableKey: v.pipe(v.string(), v.check(key => key.trim().length > 0 && new TextEncoder().encode(key).byteLength <= 512)),
        annotationId: v.pipe(v.string(), v.check(id => parsePdfAnnotationRef(id) !== null)),
        rect: positiveRect,
        fittedFontSize: v.pipe(textBoxSourceNumber, v.minValue(Number.MIN_VALUE), v.maxValue(512)),
        lineCount: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(65_537))),
        textBounds: v.nullable(positiveRect),
    })), v.minLength(1), v.maxLength(PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.textBoxes))}), value);
    if (!metadata.success) fail('Invalid text box appearance fit metadata', options);
    return metadata.output;
}

function normalizeNativeColorComponent(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        fail(`${label} must be an integer RGB component from 0 to 255`, options);
    }
    return value;
}

export function normalizeTextBoxes(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.collectionItems) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.collectionItems} text boxes`, options);
    }

    return Array.from(value, (editor, index): IPdfNativeTextBoxMutation => {
        if (!isRecord(editor)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        if (
            typeof editor.pageIndex !== 'number'
            || !Number.isSafeInteger(editor.pageIndex)
            || editor.pageIndex < 0
        ) {
            fail(`${label}[${index}].pageIndex must be a non-negative safe integer`, options);
        }
        const stableKey = normalizeOptionalString(editor.stableKey, `${label}[${index}].stableKey`, options, 512)?.trim() ?? '';
        if (!stableKey) {
            fail(`${label}[${index}].stableKey must be a non-empty string with at most 512 UTF-8 bytes`, options);
        }
        const annotationId = normalizeOptionalString(
            editor.annotationId,
            `${label}[${index}].annotationId`,
            options,
            PDF_NATIVE_IDENTITY_BINDING_LIMITS.annotationIdBytes,
        );
        if (typeof editor.text !== 'string' || editor.text.length > PDF_NATIVE_MUTATION_LIMITS.noteTextLength) {
            fail(`${label}[${index}].text must be a string with at most ${PDF_NATIVE_MUTATION_LIMITS.noteTextLength} characters`, options);
        }
        if (new TextEncoder().encode(editor.text).byteLength > PDF_NATIVE_MUTATION_LIMITS.textBoxTextBytes) {
            fail(`${label}[${index}].text exceeds the 64 KiB UTF-8 admission ceiling`, options);
        }
        let originalAppearance: IPdfNativeTextBoxMutation['originalAppearance'];
        if (editor.originalAppearance !== undefined) {
            const original = editor.originalAppearance;
            if (!isRecord(original)) fail(`${label}[${index}].originalAppearance must be an object`, options);
            if (original.sourceAnnotationId !== undefined && original.recoveryData === undefined
                && typeof original.sourceAnnotationId === 'string' && parsePdfAnnotationRef(original.sourceAnnotationId) !== null) {
                originalAppearance = {sourceAnnotationId: original.sourceAnnotationId};
            } else if (original.sourceAnnotationId === undefined && typeof original.recoveryData === 'string'
                && original.recoveryData.length <= 2 * 1024 * 1024 && original.recoveryData.length % 2 === 0 && /^[0-9a-f]+$/u.test(original.recoveryData)) {
                originalAppearance = {recoveryData: original.recoveryData};
            } else {
                fail(`${label}[${index}].originalAppearance must identify one bounded recovery graph or retained source annotation`, options);
            }
        }
        const unsupportedCharacter = originalAppearance === undefined ? firstUnsupportedAnnotationCharacter(editor.text) : undefined;
        if (unsupportedCharacter !== undefined) {
            const codepoint = unsupportedCharacter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
            fail(`${label}[${index}].text uses U+${codepoint}, which the text box fonts DejaVu Sans, Noto Sans Hebrew, Noto Sans Syriac do not support`, options);
        }
        if (!Array.isArray(editor.rect) || editor.rect.length !== 4) {
            fail(`${label}[${index}].rect must be a finite PDF rectangle with positive width and height`, options);
        }
        const rect: [number, number, number, number] = [
            normalizeNativeF32(editor.rect[0], `${label}[${index}].rect[0]`, options),
            normalizeNativeF32(editor.rect[1], `${label}[${index}].rect[1]`, options),
            normalizeNativeF32(editor.rect[2], `${label}[${index}].rect[2]`, options),
            normalizeNativeF32(editor.rect[3], `${label}[${index}].rect[3]`, options),
        ];
        if (rect[2] <= rect[0] || rect[3] <= rect[1]) {
            fail(`${label}[${index}].rect must be a finite PDF rectangle with positive width and height`, options);
        }
        if (!isPdfRotation(editor.rotation)) {
            fail(`${label}[${index}].rotation must be 0, 90, 180, or 270`, options);
        }
        if (typeof editor.fontSize !== 'number' || !isNativeF32(editor.fontSize) || editor.fontSize <= 0 || editor.fontSize > 512) {
            fail(`${label}[${index}].fontSize must be a finite number from 0 to 512`, options);
        }
        if (!Array.isArray(editor.color) || editor.color.length !== 3) {
            fail(`${label}[${index}].color must contain three integer RGB components from 0 to 255`, options);
        }
        const color: [number, number, number] = [
            normalizeNativeColorComponent(editor.color[0], `${label}[${index}].color[0]`, options),
            normalizeNativeColorComponent(editor.color[1], `${label}[${index}].color[1]`, options),
            normalizeNativeColorComponent(editor.color[2], `${label}[${index}].color[2]`, options),
        ];
        return {
            pageIndex: requirePageIndex(editor.pageIndex),
            stableKey,
            ...(originalAppearance === undefined ? {} : {originalAppearance}),
            ...(editor.annotationId === undefined ? {} : {annotationId}),
            text: editor.text,
            rect,
            rotation: editor.rotation,
            fontSize: editor.fontSize,
            color,
            ...(editor.author === undefined
                ? {}
                : {author: normalizeOptionalString(editor.author, `${label}[${index}].author`, options)}),
            ...(editor.createdAt === undefined
                ? {}
                : {createdAt: normalizeOptionalTimestamp(editor.createdAt, `${label}[${index}].createdAt`, options)}),
            ...(editor.modifiedAt === undefined
                ? {}
                : {modifiedAt: normalizeOptionalTimestamp(editor.modifiedAt, `${label}[${index}].modifiedAt`, options)}),
        };
    });
}
