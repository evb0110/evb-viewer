import {
    existsSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

function read(path: string) {
    return readFileSync(join(process.cwd(), path), 'utf8');
}

function sourceFiles(path: string): string[] {
    return readdirSync(join(process.cwd(), path), {withFileTypes: true}).flatMap((entry) => {
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
            return sourceFiles(child);
        }
        return /\.(?:ts|vue)$/.test(entry.name) ? [child] : [];
    });
}

interface IPolicyNumberSpec {
    constantName: string;
    literal: string;
    /**
     * Restricts a match to bindings whose name is about the same concept. A
     * round number is only a competing source of truth when something names it
     * as the same policy: 512 is also a routine buffer length or pixel edge, and
     * flagging every one of those would turn this guard into noise that gets
     * silenced rather than read.
     */
    boundName?: RegExp;
}

/**
 * Whether `source` binds the policy number itself instead of importing the
 * constant. A binding is a declaration, an object field, a comparison that
 * re-implements the threshold in place, or an assignment to the constant.
 * Prose that quotes the number, or a byte size that merely starts with the same
 * digits, is not a competing source of truth, so neither is flagged.
 */
function duplicatesPolicyNumber(source: string, spec: IPolicyNumberSpec): boolean {
    if (new RegExp(String.raw`\b${spec.constantName}\b\s*=(?!=)`, 'm').test(source)) {
        return true;
    }
    const value = String.raw`${spec.literal}(?![\d_]|\s*\*)`;
    const bindings = [
        String.raw`\b(?:const|let|var|readonly)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*${value}`,
        String.raw`^\s*([A-Za-z_$][\w$]*)\s*:\s*${value}`,
        String.raw`([A-Za-z_$][\w$.?!()[\]]*)\s*[<>]=?\s*${value}`,
    ];
    return bindings.some(binding => [...source.matchAll(new RegExp(binding, 'gm'))]
        .some(match => !spec.boundName || spec.boundName.test(match[1] ?? '')));
}

/**
 * Yields every call to `callee` in `source`, in source order, parentheses
 * balanced, so assertions can be made about what a call does without pinning
 * the formatting it is written in.
 *
 * Known limitation: the scan counts parentheses textually rather than
 * tokenizing, so an unbalanced parenthesis inside a string, template literal,
 * regular expression or comment inside the call would end that call early. No
 * annotation source needs one today, and a truncated call would no longer
 * contain the text the assertions below look for, so this fails loudly instead
 * of passing quietly if that ever changes.
 */
function* balancedCalls(source: string, callee: string): Generator<string> {
    for (const match of source.matchAll(new RegExp(String.raw`\b${callee}\(`, 'g'))) {
        const start = match.index ?? 0;
        let depth = 0;
        for (let index = start + match[0].length - 1; index < source.length; index += 1) {
            const character = source[index];
            if (character === '(') {
                depth += 1;
                continue;
            }
            if (character !== ')') {
                continue;
            }
            depth -= 1;
            if (depth === 0) {
                yield source.slice(start, index + 1);
                break;
            }
        }
    }
}

/**
 * Returns the `watch(...)` call whose source argument mentions `sourceRef`.
 */
function findWatchCall(source: string, sourceRef: string): string | null {
    for (const call of balancedCalls(source, 'watch')) {
        if (call.includes(sourceRef)) {
            return call;
        }
    }
    return null;
}

/**
 * The parameter list of the arrow function whose `=>` sits at `arrowIndex`,
 * without its parentheses. Reading backwards from the arrow is what makes a
 * destructured or multi-parameter list readable: a forward scan cannot tell the
 * callback's own parentheses from the enclosing call's.
 */
function parameterListBefore(source: string, arrowIndex: number): string {
    let end = arrowIndex;
    while (end > 0 && /\s/.test(source[end - 1] ?? '')) {
        end -= 1;
    }
    if (source[end - 1] !== ')') {
        let start = end;
        while (start > 0 && /[\w$]/.test(source[start - 1] ?? '')) {
            start -= 1;
        }
        return source.slice(start, end);
    }
    let depth = 0;
    for (let index = end - 1; index >= 0; index -= 1) {
        const character = source[index];
        if (character === ')') {
            depth += 1;
            continue;
        }
        if (character !== '(') {
            continue;
        }
        depth -= 1;
        if (depth === 0) {
            return source.slice(index + 1, end - 1);
        }
    }
    return '';
}

/** The first parameter of a comma-separated parameter list. */
function firstParameter(parameters: string): string {
    let depth = 0;
    for (let index = 0; index < parameters.length; index += 1) {
        const character = parameters[index];
        if (character === '{' || character === '[') {
            depth += 1;
            continue;
        }
        if (character === '}' || character === ']') {
            depth -= 1;
            continue;
        }
        if (character === ',' && depth === 0) {
            return parameters.slice(0, index);
        }
    }
    return parameters;
}

interface IWatchedEmit {
    /** Names the watcher's first parameter introduces. */
    bindings: string[];
    /** Text of the argument the emit is called with. */
    argument: string;
    /** Whether that argument is built from the watched value. */
    carriesWatchedValue: boolean;
}

/**
 * Describes how a watcher feeds `emitName`.
 *
 * A watcher may be written `state =>`, `(state) =>`, `(state, previous) =>` or
 * with the value destructured, and every one of those is a correct watcher, so
 * the parameter spelling must not decide whether the assertions pass. What has
 * to hold is that the argument reaching the emit comes from that parameter: a
 * watcher that emitted an unrelated constant would leave the panel on a stale
 * verdict while still looking like wiring.
 */
function inspectWatchedEmit(watchCall: string, emitName: string): IWatchedEmit {
    const emitCall = [...balancedCalls(watchCall, emitName)][0] ?? '';
    const argument = emitCall.slice(emitCall.indexOf('(') + 1, -1);
    // The innermost arrow that still encloses the emit is the callback that
    // performs it: an outer getter source would also have the emit somewhere
    // after its arrow, and an arrow nested inside the emit's own arguments
    // would not have it after theirs.
    const enclosingArrows = [...watchCall.matchAll(/=>/g)]
        .map(arrow => arrow.index ?? 0)
        .filter(index => watchCall.slice(index + 2).includes(`${emitName}(`));
    const arrowIndex = enclosingArrows.at(-1);
    if (arrowIndex === undefined) {
        return {
            bindings: [],
            argument,
            carriesWatchedValue: false,
        };
    }
    const parameter = firstParameter(parameterListBefore(watchCall, arrowIndex));
    const bindings = [...parameter.matchAll(/[A-Za-z_$][\w$]*/g)].map(name => name[0]);
    return {
        bindings,
        argument,
        carriesWatchedValue: bindings.some(name => new RegExp(String.raw`\b${name}\b`).test(argument)),
    };
}

describe('annotation architecture boundaries', () => {
    it('uses one body-only post-mount focus repair without trapping later navigation', () => {
        const noteWindow = read('app/modules/pdf-viewer/components/annotations/PdfAnnotationNoteWindow.vue');

        expect(noteWindow).toContain('initialFocusRepairFrame = window.requestAnimationFrame');
        expect(noteWindow).toContain('activeElement === document.body');
        expect(noteWindow).not.toContain('NOTE_WINDOW_FOCUS_GUARD_DURATION_MS');
        expect(noteWindow).not.toContain('focusGuardTimer');
        expect(noteWindow).not.toContain('reclaimFocusUntilDeadline');
        expect(noteWindow).not.toContain('postPaintInput.blur()');
    });

    it('keeps note-window state canonical and compatibility comments read-only', () => {
        const stateSource = read('app/types/annotationNoteWindow.ts');
        const stateBody = stateSource.match(/interface IAnnotationNoteWindowState \{([\s\S]*?)\n\}/)?.[1] ?? '';
        const properties = [...stateBody.matchAll(/^\s+(\w+)[?:]?:/gm)].map(match => match[1]);
        const noteWindowSource = read('app/modules/workspace-shell/composables/useAnnotationNoteWindows.ts');

        expect(properties).toEqual([
            'annotationId',
            'draftText',
            'minimized',
            'position',
        ]);
        expect(noteWindowSource).not.toMatch(/\bnote\.comment\s*=/);
        expect(noteWindowSource).not.toMatch(/annotationComments\.value\s*=/);
        expect(stateSource.match(/interface IAnnotationNoteWindowViewModel[\s\S]*?\n\}/)?.[0]).not.toMatch(/\bcomment\s*:/);
        expect(noteWindowSource).not.toMatch(/\bcommentProjection\b|\bnote\.comment\b/);
        expect(noteWindowSource).not.toMatch(/legacyStableKey/);
        expect(noteWindowSource).not.toMatch(/pendingText\s*=\s*new Map<string/);
        expect(noteWindowSource).toContain('const runtime = new Map<AnnotationId');
    });

    it('routes every annotation feature PDF.js internal through the leased bridge', () => {
        const productionPaths = [
            ...sourceFiles('app/modules/pdf-viewer/annotations'),
            ...sourceFiles('app/modules/pdf-viewer/runtime/annotations'),
            ...sourceFiles('app/modules/workspace-shell/composables'),
        ].filter(path => !path.includes('/annotations/bridge/'));
        const violations = productionPaths.flatMap((path) => {
            const source = read(path);
            const forbidden = [
                /from ['"]pdfjs-dist['"]/,
                /\b(?:IPdfjsEditor|AnnotationEditorUIManager)\b/,
                /@app\/services\/pdfjs\/(?:annotationEditorAdapter|annotationEditorMutation|annotationEditorCompatibility|createPdfHighlightEditorClassPatch)/,
                /\.(?:addEditListeners|removeEditListeners|updateMode|updateParams|waitForEditorsRendered)\(/,
                /__(?:freeText|evb(?!TestApi))/,
            ];
            return forbidden.some(pattern => pattern.test(source)) ? [path] : [];
        });

        expect(violations).toEqual([]);
    });

    it('has no mutable summary, move, deletion, or shape peer authority', () => {
        const application = read('app/modules/pdf-viewer/annotations/annotationApplication.ts');
        const store = read('app/modules/pdf-viewer/annotations/domain/annotationStore.ts');
        const shapeReadModel = read('app/modules/pdf-viewer/tools/useAnnotationShapes.ts');
        const shapeCommands = read('app/modules/pdf-viewer/tools/usePdfShapeTool.ts');
        const shapeContext = read('app/modules/pdf-viewer/tools/usePdfShapeContext.ts');
        const runtime = read('app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession.ts');

        expect(runtime).not.toMatch(/\bannotationReadModels\b/);
        // The shape read model projects the store; it owns no second map,
        // tombstone set, saved baseline or save snapshot of its own.
        expect(shapeReadModel).not.toMatch(/deletedEmbedded\w+\s*=\s*ref|baselineSignature|ShapeStateSnapshot/);
        expect(shapeReadModel).toMatch(/annotationApplication\.value\.store\.list\(/);
        // Managed embedded shapes hold no import baseline or save snapshot either.
        // Canonical entities enter through the application/store boundary;
        // the rendering projection has no import baseline of its own.
        expect(application).toContain('acknowledgeSave');
        expect(store).not.toMatch(/#hasShapeImportBaseline|planShapeImport/);
        expect(shapeCommands).toMatch(/store\.createShape|toCanonicalShapeEntity/);
        expect(shapeCommands).not.toContain('usePdfShapeHistory');
        expect(shapeContext).toMatch(/finishDrawingDraft|onShapePreviewed/);
    });

    it('classifies point-note markers from one shared threshold policy', () => {
        const policyPath = 'app/modules/pdf-viewer/engine/annotations/annotation-rules/pointNoteMarkerPolicy.ts';
        const policy = read(policyPath);

        expect(policy).toContain('export const POINT_NOTE_MARKER_MAX_NORMALIZED_SIZE = 0.02;');
        expect(policy).toContain('export const POINT_NOTE_MARKER_SIZE_ROUNDING_TOLERANCE = Number.EPSILON * 16;');

        // Import classification, list classification, the editor bridge, and
        // the save pipeline must agree, so none of them may keep a private
        // copy of the threshold.
        const callSites = [
            'app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue',
            'app/modules/pdf-viewer/engine/annotations/toFreeTextNoteMarkerRect.ts',
        ];
        for (const path of callSites) {
            expect(read(path)).toContain('annotation-rules/pointNoteMarkerPolicy\'');
        }

        const redeclarations = sourceFiles('app/modules/pdf-viewer')
            .filter(path => path !== policyPath)
            .filter(path => duplicatesPolicyNumber(read(path), {
                constantName: 'POINT_NOTE_MARKER_MAX_NORMALIZED_SIZE',
                literal: String.raw`0\.02`,
            }));

        expect(redeclarations).toEqual([]);
    });

    it('carries annotation enrichment state instead of inferring it from missing data', () => {
        const policyPath = 'app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy.ts';
        const policy = read(policyPath);
        const session = read('app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession.ts');
        const workspace = read('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const commentsList = read('app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue');

        // 512 is a common enough magic number that an unscoped scan would
        // report every buffer length in the module; only a binding that names
        // itself after the same page ceiling is a competing source of truth.
        const eagerPageCeiling = {
            constantName: 'MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT',
            literal: '512',
            boundName: /page|enrich/i,
        };

        expect(policy).toContain('export const MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT = 512;');
        // Completeness, cause and retryability are three separate facts.
        expect(policy).toContain('status: TAnnotationEnrichmentStatus;');
        expect(policy).toContain('reason: TAnnotationEnrichmentSkipReason | null;');
        expect(policy).toContain('canRetry: boolean;');

        expect(duplicatesPolicyNumber(session, eagerPageCeiling)).toBe(false);

        // The state reaches the panel as an explicit value, so no consumer
        // has to guess "skipped" from an absent author or annotation name.
        // `immediate` matters: a panel that opens later must still receive the
        // verdict the bridge already settled on.
        expect(session).toContain('annotationEnrichmentState');
        expect(workspace).toContain(':annotation-enrichment-state="annotationEnrichmentState"');
        expect(workspace).toContain('@annotation-retry-enrichment="requestAnnotationEnrichment"');
        expect(commentsList).toContain('enrichmentState.status === \'failed\'');
        expect(commentsList).toContain('enrichmentState.status !== \'skipped\'');
        // An offered retry must not be allowed to hide the omission.
        expect(commentsList).not.toMatch(/canRetry\s*(?:\?|&&|\|\|)[\s\S]{0,40}return null/);
        expect(commentsList).not.toMatch(/unknownAuthor[\s\S]{0,200}enrichment/i);

        const redeclarations = sourceFiles('app/modules/pdf-viewer')
            .filter(path => path !== policyPath)
            .filter(path => duplicatesPolicyNumber(read(path), eagerPageCeiling));

        expect(redeclarations).toEqual([]);
    });

    it('keeps the retired heuristic identity directory empty', () => {
        const identityPath = join(
            process.cwd(),
            'app/modules/pdf-viewer/engine/annotations/annotation-identity',
        );
        expect(existsSync(identityPath) ? readdirSync(identityPath) : []).toEqual([]);
    });

    it('keeps authored annotation intent in the session and PDF.js projection-only', () => {
        const session = read('app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession.ts');
        const application = read('app/modules/pdf-viewer/annotations/annotationApplication.ts');
        const featureController = read(
            'app/modules/pdf-viewer/runtime/usePdfViewerFeatureController.ts',
        );
        const mouseAdapter = read(
            'app/modules/pdf-viewer/runtime/composables/usePdfViewerMouseInteractions.ts',
        );

        expect(session).toContain('annotationEditorSurface.createHighlightFromSelection');
        expect(session).toContain('annotationEditorSurface.createNoteAt');
        expect(session).not.toContain('application.store.bindIdentity');
        expect(application).not.toContain('store.applyTextMarkupSelection');
        expect(application).not.toContain('store.createNote');
        expect(existsSync(join(process.cwd(), 'app/modules/pdf-viewer/annotations/bridge'))).toBe(false);
        expect(featureController).not.toContain('highlightComposable.handleViewerMouseUp');
        expect(mouseAdapter).not.toContain('handleViewerMouseUpAnnotation');
        expect(session).not.toContain('pdfjsAnnotationFacade');
    });

    it('has no single-consumer compatibility files in the annotation flow', () => {
        [
            'app/modules/pdf-viewer/annotations/domain/annotationEntity.ts',
            'app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity.ts',
            'app/modules/pdf-viewer/annotations/public.ts',
            'app/modules/pdf-viewer/runtime/contracts/createPdfViewerPublicApi.ts',
            'app/modules/pdf-viewer/runtime/sessions/usePdfAnnotationEditorLifecycle.ts',
        ].forEach(path => expect(existsSync(join(process.cwd(), path))).toBe(false));
    });
});

/**
 * The two scans above are the only thing standing between a duplicated policy
 * number, or a watcher that emits the wrong value, and a silent regression. A
 * scan that no longer catches what it was written for reads exactly like a
 * clean codebase, so each one is exercised against sources that must trip it
 * and sources that must not.
 */
describe('annotation architecture scanners', () => {
    const eagerPageCeiling = {
        constantName: 'MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT',
        literal: '512',
        boundName: /page|enrich/i,
    };

    it.each([
        {
            label: 'a redeclared ceiling',
            source: 'const MAX_EAGER_PAGE_COUNT = 512;',
        },
        {
            label: 'a lower-camel redeclared ceiling',
            source: 'let enrichmentPageLimit = 512;',
        },
        {
            label: 'an inline page comparison',
            source: 'if (pageCount > 512) { return false; }',
        },
        {
            label: 'an inline comparison against a page collection',
            source: 'return pdf.pages.length <= 512;',
        },
        {
            label: 'an options field',
            source: '    maxEnrichmentPages: 512,',
        },
        {
            label: 'an assignment to the shared constant',
            source: 'MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT = 400;',
        },
    ])('reports $label as a competing page ceiling', ({ source }) => {
        expect(duplicatesPolicyNumber(source, eagerPageCeiling)).toBe(true);
    });

    it.each([
        {
            label: 'an unrelated pixel edge',
            source: 'const THUMBNAIL_MAX_EDGE = 512;',
        },
        {
            label: 'an unrelated buffer comparison',
            source: 'if (chunk.byteLength > 512) { flush(); }',
        },
        {
            label: 'a byte size that only starts with the same digits',
            source: 'const WORKER_MAX_INPUT_BYTES = 512 * 1024 * 1024;',
        },
        {
            label: 'prose quoting the ceiling',
            source: '// Documents past 512 pages wait for a user action.',
        },
        {
            label: 'an import of the shared constant',
            source: 'import { MAX_EAGER_ANNOTATION_ENRICHMENT_PAGE_COUNT } from \'./annotationEnrichmentPolicy\';',
        },
    ])('leaves $label alone', ({ source }) => {
        expect(duplicatesPolicyNumber(source, eagerPageCeiling)).toBe(false);
    });

    it.each([
        {
            label: 'a bare parameter',
            callback: 'state => options.emitAnnotationEnrichmentState(state)',
        },
        {
            label: 'a parenthesized parameter',
            callback: '(state) => options.emitAnnotationEnrichmentState(state)',
        },
        {
            label: 'a value-and-previous pair',
            callback: '(state, previous) => options.emitAnnotationEnrichmentState(state)',
        },
        {
            label: 'a destructured value',
            callback: '({status, reason, canRetry}) => options.emitAnnotationEnrichmentState({status, reason, canRetry})',
        },
    ])('accepts a watcher that emits the watched value through $label', ({ callback }) => {
        const watchCall = `watch(commentSync.annotationEnrichmentState, ${callback}, {immediate: true})`;
        const found = findWatchCall(watchCall, 'commentSync.annotationEnrichmentState') ?? '';

        expect(found).toBe(watchCall);
        expect(inspectWatchedEmit(found, 'emitAnnotationEnrichmentState').carriesWatchedValue).toBe(true);
    });

    it.each([
        {
            label: 'a constant instead of the watched value',
            callback: 'state => options.emitAnnotationEnrichmentState(PENDING_ANNOTATION_ENRICHMENT_STATE)',
        },
        {
            label: 'a second watched source instead of the value',
            callback: '(state, previous) => options.emitAnnotationEnrichmentState(fallbackState)',
        },
    ])('rejects a watcher that emits $label', ({ callback }) => {
        const watchCall = `watch(commentSync.annotationEnrichmentState, ${callback}, {immediate: true})`;

        expect(inspectWatchedEmit(watchCall, 'emitAnnotationEnrichmentState').carriesWatchedValue).toBe(false);
    });
});
