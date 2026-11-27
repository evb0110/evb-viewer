import {sameWitness} from './contentWitness';
import {hasNoUserEdits} from './manifest';
import type {
    DocumentDirectory,
    IDraftRevisionGuard,
    IRevision,
    TDraftResult,
    TForeignRevisionState,
    TMutation,
    TMutationResult,
    TReplacement,
} from './documentDirectory';
import {saveDocument, type TSaveResult} from './saveDocument';
import type {IStoreFile} from './storePort';

export type TRevisionTokenScheme = 'numeric' | 'browser';

export interface IRevisionTokenCodec {
    readonly scheme: TRevisionTokenScheme;
    format(docId: string, revisionId: number, foreign?: TForeignRevisionState): string;
    formatCurrent(doc: DocumentDirectory): string;
    parseId(docId: string, token: string): number;
}

const NUMERIC_REVISION_CODEC: IRevisionTokenCodec = {
    scheme: 'numeric',
    format: (_docId, revisionId) => String(revisionId),
    formatCurrent: (doc) => String(doc.state().current?.id ?? 1),
    parseId: (_docId, token) => {
        if (!/^\d+$/u.test(token)) {
            return -1;
        }
        const id = Number(token);
        return Number.isSafeInteger(id) ? id : -1;
    },
};

const formatBrowserToken = (docId: string, revisionId: number, foreign?: TForeignRevisionState) => {
    const suffix = foreign === 'committed' ? ':f' : foreign === 'staged' ? ':s' : '';
    return `drt1:browser:${docId}:${revisionId}${suffix}`;
};

const BROWSER_REVISION_CODEC: IRevisionTokenCodec = {
    scheme: 'browser',
    format: formatBrowserToken,
    formatCurrent: (doc) => {
        const current = doc.state().current;
        return formatBrowserToken(doc.id, current?.id ?? 1, current?.foreign);
    },
    parseId: (docId, token) => {
        const match = /^drt1:browser:([^:]+):(\d+)(?::([fs]))?$/u.exec(token);
        if (!match || match[1] !== docId) {
            return -1;
        }
        const id = Number(match[2]);
        const foreign: TForeignRevisionState | undefined = match[3] === 'f' ? 'committed' : match[3] === 's' ? 'staged' : undefined;
        return Number.isSafeInteger(id) && formatBrowserToken(docId, id, foreign) === token ? id : -1;
    },
};

export function createRevisionTokenCodec(scheme: TRevisionTokenScheme): IRevisionTokenCodec {
    return scheme === 'browser' ? BROWSER_REVISION_CODEC : NUMERIC_REVISION_CODEC;
}

export interface IOpenDocumentOptions {
    codec: IRevisionTokenCodec;
    /** Whether this open handle still represents the active entry in its host registry. */
    isActive?: () => boolean;
    /** Awaited before any user edit (not an open-time or imported rewrite), e.g. naming the directory in the window checkpoint. */
    beforeEdit?: () => Promise<unknown>;
    /** Awaited before any mutation, restore, retain, append, or save, e.g. preserving desktop pinned revisions. */
    beforeMutation?: () => Promise<unknown>;
}

export interface ICheckRevisionOptions {
    requireToken?: boolean;
    strict?: boolean;
    allowStagedBase?: boolean;
    expectedByteRevision?: number | undefined;
    forbidPendingAppend?: boolean;
}

export type TRevisionCheckResult =
    | {status: 'ok'; expectedId: number | null; currentToken: string}
    | {status: 'missing-revision'; currentToken: string}
    | {status: 'stale-revision'; expected: string | null; actual: string};

export type TOpenMutationResult =
    | {status: 'committed'; revision: IRevision; previousToken: string; currentToken: string}
    | {status: 'missing-revision'; currentToken: string}
    | {status: 'stale-revision'; expected: string | null; actual: string}
    | {status: 'conflict'};

export type TOpenRestoreResult =
    | {status: 'committed'; revision: IRevision | null; previousToken: string; currentToken: string}
    | {status: 'missing-revision'; currentToken: string}
    | {status: 'stale-revision'; expected: string | null; actual: string}
    | {status: 'conflict'; sourceBackingUnavailable: boolean};

export type TOpenStageAppendResult =
    | {status: 'staged'; lease: string}
    | {status: 'aborted'}
    | {status: 'missing-revision'; currentToken: string}
    | {status: 'stale-revision'; expected: string | null; actual: string}
    | {status: 'conflict'};

export type TOpenSaveOutcome =
    | {status: 'result'; result: TSaveResult; previousToken: string; currentToken: string}
    | {status: 'missing-revision'; currentToken: string}
    | {status: 'stale-revision'; expected: string | null; actual: string};

export interface IOpenMutateOptions {
    requireToken?: boolean;
    strict?: boolean;
    openOnly?: boolean;
    expectedByteRevision?: number | undefined;
    beforeRun?: () => Promise<unknown>;
}

export interface IOpenSaveOptions {
    requireToken?: boolean;
    commitLease?: string | undefined;
    commitReplacement?: TReplacement | undefined;
    saveAs?: string | undefined;
    beforeSave?: () => Promise<unknown>;
}

interface IPendingAppend {
    lease: string;
    token: string;
    byteRevision: number;
    length: number;
}

/**
 * Shared open-document controller over a `DocumentDirectory`: owns revision-token encoding/parsing,
 * expected-revision validation, active-entry checks, staged/in-place append leases, restore/retain,
 * and save orchestration for both browser and desktop hosts.
 */
export class OpenDocument {
    readonly codec: IRevisionTokenCodec;
    private readonly activeCheck: () => boolean;
    private readonly beforeEditHook: (() => Promise<unknown>) | undefined;
    private readonly beforeMutationHook: (() => Promise<unknown>) | undefined;
    private pendingAppend: IPendingAppend | undefined;

    constructor(
        readonly doc: DocumentDirectory,
        options: IOpenDocumentOptions,
    ) {
        this.codec = options.codec;
        this.activeCheck = options.isActive ?? (() => true);
        this.beforeEditHook = options.beforeEdit;
        this.beforeMutationHook = options.beforeMutation;
    }

    token(): string {
        return this.codec.formatCurrent(this.doc);
    }

    contentRevision(): number {
        return this.doc.state().current?.id ?? 1;
    }

    byteRevision(): number {
        return this.doc.state().byteRevision;
    }

    hasPendingAppend(): boolean {
        return this.pendingAppend !== undefined;
    }

    isActive(): boolean {
        return this.activeCheck();
    }

    parseRevisionId(token: string): number {
        return this.codec.parseId(this.doc.id, token);
    }

    /** Resolves a caller's token into the store's expected revision id (`null` for unmaterialized rev 1, `-1` if stale). */
    resolveExpectedId(expected: string | null | undefined, options: {allowStagedBase?: boolean} = {}): number | null {
        const current = this.doc.state().current;
        if (expected === null || expected === undefined) {
            return current?.id ?? null;
        }
        const currentToken = this.codec.format(this.doc.id, current?.id ?? 1, current?.foreign);
        if (expected === currentToken) {
            return current?.id ?? null;
        }
        if (options.allowStagedBase === true && current?.foreign === 'staged' && expected === this.codec.format(this.doc.id, 1)) {
            return 1;
        }
        return -1;
    }

    checkRevision(expected: string | null | undefined, options: ICheckRevisionOptions = {}): TRevisionCheckResult {
        const state = this.doc.state();
        const current = state.current;
        const currentToken = this.codec.format(this.doc.id, current?.id ?? 1, current?.foreign);
        if (!expected) {
            if (options.requireToken) {
                return {status: 'missing-revision', currentToken};
            }
            if (
                options.strict ||
                !this.activeCheck() ||
                (options.expectedByteRevision !== undefined && state.byteRevision !== options.expectedByteRevision)
            ) {
                return {status: 'stale-revision', expected: expected ?? null, actual: currentToken};
            }
            return {status: 'ok', expectedId: current?.id ?? null, currentToken};
        }
        if (
            !this.activeCheck() ||
            (options.forbidPendingAppend && this.pendingAppend !== undefined) ||
            (options.expectedByteRevision !== undefined && state.byteRevision !== options.expectedByteRevision)
        ) {
            return {status: 'stale-revision', expected, actual: currentToken};
        }
        const allowStagedBase = options.strict ? false : (options.allowStagedBase ?? false);
        const matches =
            expected === currentToken ||
            (allowStagedBase && current?.foreign === 'staged' && expected === this.codec.format(this.doc.id, 1));
        if (!matches) {
            return {status: 'stale-revision', expected, actual: currentToken};
        }
        return {status: 'ok', expectedId: current?.id ?? null, currentToken};
    }

    async mutate(expected: string | null | undefined, mutation: TMutation, options: IOpenMutateOptions = {}): Promise<TOpenMutationResult> {
        const capturedByteRevision = options.expectedByteRevision ?? this.doc.state().byteRevision;
        const checkByteRevision =
            options.expectedByteRevision !== undefined || Boolean(expected) || options.strict === true ? capturedByteRevision : undefined;
        const checkCurrent = () =>
            this.checkRevision(expected, {
                requireToken: options.requireToken ?? false,
                strict: options.strict ?? false,
                forbidPendingAppend: options.strict ?? false,
                expectedByteRevision: checkByteRevision,
            });
        const pre = checkCurrent();
        if (pre.status !== 'ok') {
            return pre;
        }
        const isEdit = !options.openOnly && !(mutation.kind === 'rewrite' && (mutation.imported || mutation.openOnly));
        if (isEdit) {
            await this.beforeEditHook?.();
        }
        await this.beforeMutationHook?.();
        await options.beforeRun?.();
        if (!this.activeCheck()) {
            return this.stale(expected);
        }
        let previousToken = this.token();
        const result = await this.doc.run(async (): Promise<TMutationResult> => {
            previousToken = this.token();
            if (checkCurrent().status !== 'ok') {
                return {status: 'stale-revision', current: this.doc.state().current ?? null};
            }
            return this.doc.applyMutation(this.doc.state().current?.id ?? null, mutation);
        });
        return this.mapMutationResult(expected, previousToken, result);
    }

    /**
     * Commits a direct-to-file rewrite whose bytes `writeOutput` writes to the store path it is given
     * (used by OPFS worker rewrites where the new revision file is written in place).
     */
    async rewritePrepared(
        expected: string | null | undefined,
        previousToken: string,
        capturedByteRevision: number,
        writeOutput: (outputPath: string) => Promise<void>,
        options: {imported?: boolean; openOnly?: boolean} = {},
    ): Promise<TOpenMutationResult> {
        const isStillCurrent = () =>
            this.activeCheck() && this.token() === previousToken && this.doc.state().byteRevision === capturedByteRevision;
        try {
            const result = await this.doc.run(async (): Promise<TMutationResult> => {
                const manifest = this.doc.snapshot();
                if (!isStillCurrent()) {
                    return {status: 'stale-revision', current: manifest.current ?? null};
                }
                const {current, next, ext} = manifest;
                const name = `r${current ? next : next + 1}.${ext}`;
                const output = this.doc.path(name);
                let committed = false;
                try {
                    await writeOutput(output);
                    const afterWrite = this.doc.snapshot();
                    if (
                        !isStillCurrent() ||
                        Boolean(afterWrite.current) !== Boolean(current) ||
                        afterWrite.next !== next ||
                        afterWrite.ext !== ext
                    ) {
                        return {status: 'stale-revision', current: afterWrite.current ?? null};
                    }
                    // A first copy of the file made meanwhile is revision `next`, and `name` is its next revision.
                    if (afterWrite.current) {
                        const outcome = await this.doc.applyMutation(afterWrite.current.id, {
                            kind: 'rewrite',
                            source: () => Promise.resolve(),
                            drafts: 'clear',
                            ...(options.imported ? {imported: true} : {}),
                            ...(options.openOnly ? {openOnly: true} : {}),
                        });
                        committed = outcome.status === 'committed';
                        return outcome;
                    }
                    if (!sameWitness(await this.doc.store.publication.witness(afterWrite.destination!), afterWrite.baseline)) {
                        return {status: 'conflict'};
                    }
                    const file = await this.doc.store.port.open(output);
                    let revision: IRevision;
                    try {
                        const openOnly = options.openOnly === true && hasNoUserEdits(afterWrite);
                        revision = {
                            id: next + 1,
                            file: name,
                            length: await file.size(),
                            ...(openOnly ? {openOnly: true as const} : {}),
                        };
                        await file.flush();
                    } catch (error) {
                        await file.close().catch(() => undefined);
                        throw error;
                    }
                    await this.doc.commit({...afterWrite, next: revision.id + 1, current: revision, drafts: undefined}, file);
                    committed = true;
                    return {status: 'committed', revision};
                } finally {
                    if (!committed) {
                        const latest = this.doc.snapshot();
                        const stillReferenced =
                            latest.current?.file === name || latest.history.some((rev) => 'file' in rev && rev.file === name);
                        if (!stillReferenced) {
                            await this.doc.store.port.remove(output).catch(() => undefined);
                        }
                    }
                }
            });
            return this.mapMutationResult(expected, previousToken, result);
        } catch (error) {
            if (!this.activeCheck()) {
                return this.stale(expected);
            }
            throw error;
        }
    }

    async restore(
        expected: string | null | undefined,
        targetToken: string,
        options: {requireToken?: boolean; ownCurrentFileAfterRestore?: boolean} = {},
    ): Promise<TOpenRestoreResult> {
        const capturedByteRevision = this.doc.state().byteRevision;
        const pre = this.checkRevision(expected, {requireToken: options.requireToken ?? false});
        if (pre.status !== 'ok') {
            return pre;
        }
        await this.beforeEditHook?.();
        await this.beforeMutationHook?.();
        if (!this.activeCheck()) {
            return this.stale(expected);
        }
        const previousToken = this.token();
        const targetId = this.parseRevisionId(targetToken);
        let result;
        try {
            result = await this.doc.run(async () => {
                if (
                    !this.activeCheck() ||
                    (expected && expected !== this.token()) ||
                    this.doc.state().byteRevision !== capturedByteRevision
                ) {
                    return {status: 'stale-revision' as const, current: this.doc.snapshot().current ?? null};
                }
                const outcome = await this.doc.applyRestore(this.resolveExpectedId(expected), targetId);
                if (outcome.status === 'committed' && options.ownCurrentFileAfterRestore) {
                    await this.doc.applyOwnCurrentFile();
                }
                return outcome;
            });
        } catch (error) {
            if (!this.activeCheck()) {
                return this.stale(expected);
            }
            throw error;
        }
        if (result.status === 'stale-revision') {
            return this.stale(expected);
        }
        if (result.status === 'conflict') {
            const {history, baseline} = this.doc.state();
            const target = history.find((item) => item.id === targetId);
            const sourceBackingUnavailable = Boolean(target && !('file' in target) && !sameWitness(target.witness, baseline));
            return {status: 'conflict', sourceBackingUnavailable};
        }
        return {status: 'committed', revision: result.revision, previousToken, currentToken: this.token()};
    }

    async retain(tokens: readonly string[]): Promise<void> {
        await this.beforeMutationHook?.();
        await this.doc.retain(tokens.map((token) => this.parseRevisionId(token)));
    }

    setDrafts(expected: string | null | undefined, drafts: unknown, guard?: IDraftRevisionGuard): Promise<TDraftResult> {
        return this.doc.setDrafts(this.resolveExpectedId(expected), drafts, guard);
    }

    /**
     * Stages an uncommitted append past `expected`; materializes from destination only against baseline unless
     * `allowForeignBase` is true (Save As rescue). Preserves baseline-checked default and active-entry guards.
     */
    async stageAppend(
        expected: string | null | undefined,
        append: (file: IStoreFile, base: number) => Promise<number | null>,
        options: {allowForeignBase?: boolean; requireToken?: boolean} = {},
    ): Promise<TOpenStageAppendResult> {
        const allowForeignBase = options.allowForeignBase ?? false;
        const revOpts: ICheckRevisionOptions = {
            requireToken: options.requireToken ?? false,
            allowStagedBase: allowForeignBase,
        };
        const pre = this.checkRevision(expected, revOpts);
        if (pre.status !== 'ok') {
            return pre;
        }
        try {
            return await this.doc.run(async (): Promise<TOpenStageAppendResult> => {
                const beforeEnsure = this.checkRevision(expected, revOpts);
                if (beforeEnsure.status !== 'ok') {
                    return beforeEnsure;
                }
                if ((await this.doc.ensureCurrent(allowForeignBase)) === null) {
                    return {status: 'conflict'};
                }
                if (!this.activeCheck()) {
                    return this.stale(expected);
                }
                await this.doc.applyOwnCurrentFile();
                const afterOwn = this.checkRevision(expected, revOpts);
                if (afterOwn.status !== 'ok') {
                    return afterOwn;
                }
                this.pendingAppend = undefined;
                const base = this.doc.state().current!.length;
                const file = this.doc.currentFile();
                let lease: string | null = null;
                try {
                    if ((await file.size()) > base) {
                        await file.truncate(base);
                    }
                    const length = await append(file, base);
                    if (length === null) {
                        return {status: 'aborted'};
                    }
                    if (!this.activeCheck()) {
                        return this.stale(expected);
                    }
                    lease = crypto.randomUUID();
                    this.pendingAppend = {lease, token: this.token(), byteRevision: this.doc.state().byteRevision, length};
                    return {status: 'staged', lease};
                } finally {
                    if (lease === null) {
                        await file.truncate(base).catch(() => undefined);
                    }
                }
            });
        } catch (error) {
            if (!this.activeCheck()) {
                return this.stale(expected);
            }
            throw error;
        }
    }

    async commitAppend(
        expected: string | null | undefined,
        lease: string,
        options: {requireToken?: boolean} = {},
    ): Promise<TOpenMutationResult> {
        await this.beforeEditHook?.();
        await this.beforeMutationHook?.();
        if (!this.activeCheck()) {
            return this.stale(expected);
        }
        const previousToken = this.token();
        const result = await this.doc.run(() => this.commitPendingAppendInQueue(expected, lease, options.requireToken ?? false));
        if (result.status === 'missing-revision') {
            return result;
        }
        return this.mapMutationResult(expected, previousToken, result);
    }

    async discardAppend(lease: string): Promise<void> {
        if (this.pendingAppend?.lease !== lease) {
            return;
        }
        await this.doc.run(async () => {
            const pending = this.pendingAppend;
            const current = this.doc.state().current;
            if (pending?.lease !== lease || !current) {
                return;
            }
            this.pendingAppend = undefined;
            if (
                pending.token === this.token() &&
                pending.byteRevision === this.doc.state().byteRevision &&
                (await this.doc.currentFile().size()) === pending.length
            ) {
                await this.doc.currentFile().truncate(current.length);
                await this.doc.currentFile().flush();
            }
        });
    }

    withPendingAppend<T>(lease: string, read: (path: string, length: number) => Promise<T>): Promise<T> {
        return this.doc.run(async () => {
            const {length} = this.requirePendingAppend(lease);
            return read(this.doc.path(this.doc.state().current!.file), length);
        });
    }

    /** Prepares the current revision file for an external/native in-place append. */
    async prepareInPlaceAppend(allowForeignBase = false): Promise<IRevision | null> {
        await this.beforeMutationHook?.();
        const materialized = await this.doc.materialize(allowForeignBase);
        if (!materialized) {
            return null;
        }
        return this.doc.ownCurrentFile();
    }

    /** Cuts an uncommitted in-place append, or abandons the file when a writer may still hold it. */
    async discardInPlaceAppend(abandon = false): Promise<void> {
        await this.beforeMutationHook?.();
        const end = abandon ? this.doc.abandonCurrentFile() : this.doc.ownCurrentFile();
        await end.catch(() => undefined);
    }

    /**
     * Save or Save As: optionally commits a staged append lease (browser) or replacement mutation (desktop)
     * before delegating to `saveDocument`.
     */
    async save(expected: string | null | undefined, options: IOpenSaveOptions = {}): Promise<TOpenSaveOutcome> {
        const previousToken = this.token();
        try {
            let expectedId: number | null;
            if (options.commitLease !== undefined) {
                const check = this.checkRevision(expected, {
                    requireToken: options.requireToken ?? false,
                    allowStagedBase: true,
                });
                if (check.status !== 'ok') {
                    return check;
                }
                await this.beforeEditHook?.();
                await this.beforeMutationHook?.();
                if (!this.activeCheck()) {
                    return this.stale(expected);
                }
                const committed = await this.doc.run(() =>
                    this.commitPendingAppendInQueue(expected, options.commitLease!, options.requireToken ?? false),
                );
                if (committed.status === 'missing-revision') {
                    return committed;
                }
                if (committed.status === 'stale-revision') {
                    return this.stale(expected);
                }
                if (committed.status === 'conflict') {
                    return {status: 'result', result: committed, previousToken, currentToken: this.token()};
                }
                expectedId = committed.revision.id;
            } else {
                if (options.requireToken) {
                    const check = this.checkRevision(expected, {
                        requireToken: true,
                        allowStagedBase: true,
                    });
                    if (check.status !== 'ok') {
                        return check;
                    }
                }
                if (options.commitReplacement !== undefined) {
                    await this.beforeEditHook?.();
                }
                await this.beforeMutationHook?.();
                await options.beforeSave?.();
                if (!this.activeCheck()) {
                    return this.stale(expected);
                }
                // Resolve after pre-save hooks (which may drain a queued unchanged materialization).
                expectedId = this.resolveExpectedId(expected, {allowStagedBase: true});
            }
            if (!this.activeCheck()) {
                return this.stale(expected);
            }
            const saveOptions = {
                ...(options.commitReplacement ? {commit: {...options.commitReplacement, drafts: 'clear' as const}} : {}),
                ...(options.saveAs !== undefined ? {saveAs: options.saveAs} : {}),
            };
            const capturedByteRevision = this.doc.state().byteRevision;
            let result = await saveDocument(this.doc, {expected: expectedId, ...saveOptions});
            // A concurrent reader may queue an unchanged baseline materialization (`null -> 1`) between resolving
            // `expectedId` and `saveDocument` entering `doc.run`; `byteRevision` proves the bytes and baseline did not change.
            if (
                result.status === 'stale-revision' &&
                expectedId === null &&
                result.current?.id === 1 &&
                result.current.foreign === undefined &&
                this.doc.state().byteRevision === capturedByteRevision &&
                this.activeCheck() &&
                this.resolveExpectedId(expected, {allowStagedBase: true}) === 1
            ) {
                result = await saveDocument(this.doc, {expected: 1, ...saveOptions});
            }
            return {status: 'result', result, previousToken, currentToken: this.token()};
        } catch (error) {
            if (!this.activeCheck()) {
                return this.stale(expected);
            }
            throw error;
        }
    }

    private requirePendingAppend(lease: string): IPendingAppend {
        const pending = this.pendingAppend;
        if (pending?.lease !== lease || pending.token !== this.token() || pending.byteRevision !== this.doc.state().byteRevision) {
            throw new Error('The edit staged for this document is no longer its next revision');
        }
        return pending;
    }

    private async commitPendingAppendInQueue(
        expected: string | null | undefined,
        lease: string,
        requireToken: boolean,
    ): Promise<TMutationResult | {status: 'missing-revision'; currentToken: string}> {
        const check = this.checkRevision(expected, {requireToken, allowStagedBase: true});
        if (check.status === 'missing-revision') {
            return check;
        }
        if (check.status === 'stale-revision') {
            return {status: 'stale-revision', current: this.doc.state().current ?? null};
        }
        const {length} = this.requirePendingAppend(lease);
        if ((await this.doc.currentFile().size()) !== length) {
            throw new Error('The edit staged for this document is no longer its next revision');
        }
        this.pendingAppend = undefined;
        return this.doc.applyMutation(check.expectedId, {kind: 'extend', drafts: 'clear'});
    }

    private stale(expected: string | null | undefined) {
        return {status: 'stale-revision' as const, expected: expected ?? null, actual: this.token()};
    }

    private mapMutationResult(expected: string | null | undefined, previousToken: string, result: TMutationResult): TOpenMutationResult {
        if (result.status === 'stale-revision') {
            return this.stale(expected);
        }
        if (result.status === 'conflict') {
            return result;
        }
        return {status: 'committed', revision: result.revision, previousToken, currentToken: this.token()};
    }
}
