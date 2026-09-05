import type {
    AnnotationId,
    IAnnotationIdentity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

type TBindingKey = Exclude<keyof IAnnotationIdentity, 'id'>;

export class ExternalIdentityConflictError extends Error {}

export class ExternalIdentityIndex {
    readonly #indexes: Record<TBindingKey, Map<string, AnnotationId>> = {pdfRef: new Map()};

    bind(identity: IAnnotationIdentity) {
        this.replace([{
            before: null,
            after: identity,
        }]);
    }

    replace(changes: ReadonlyArray<{
        readonly before: IAnnotationIdentity | null;
        readonly after: IAnnotationIdentity | null;
    }>) {
        const staged: Record<TBindingKey, Map<string, AnnotationId | null>> = {pdfRef: new Map()};
        const ownerOf = (key: TBindingKey, value: string) => staged[key].has(value)
            ? staged[key].get(value) ?? null
            : this.#indexes[key].get(value) ?? null;
        changes.forEach(({before}) => {
            if (!before) {
                return;
            }
            for (const key of Object.keys(this.#indexes) as TBindingKey[]) {
                const value = before[key]?.trim();
                if (value && ownerOf(key, value) === before.id) {
                    staged[key].set(value, null);
                }
            }
        });
        changes.forEach(({after}) => {
            if (!after) {
                return;
            }
            for (const key of Object.keys(this.#indexes) as TBindingKey[]) {
                const value = after[key]?.trim();
                if (!value) continue;
                const owner = ownerOf(key, value);
                if (owner && owner !== after.id) {
                    throw new ExternalIdentityConflictError(`${key} ${value} is already bound to ${owner}`);
                }
                staged[key].set(value, after.id);
            }
        });
        (Object.keys(this.#indexes) as TBindingKey[]).forEach((key) => {
            staged[key].forEach((id, value) => {
                if (id) this.#indexes[key].set(value, id);
                else this.#indexes[key].delete(value);
            });
        });
    }

    resolve(bindings: Omit<IAnnotationIdentity, 'id'>): AnnotationId | null {
        const matches = new Set<AnnotationId>();
        for (const key of Object.keys(this.#indexes) as TBindingKey[]) {
            const value = bindings[key]?.trim();
            if (!value) continue;
            const match = this.#indexes[key].get(value);
            if (match) matches.add(match);
        }
        if (matches.size > 1) {
            throw new ExternalIdentityConflictError('External bindings resolve to different annotations');
        }
        return matches.values().next().value ?? null;
    }

    clear() {
        Object.values(this.#indexes).forEach(index => index.clear());
    }
}
