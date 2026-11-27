import type {Ref} from 'vue';

/** Stable public port whose target can swap from source to PDF projection without remounting callers. */
export function createDocumentViewerExposeForwarder(
    target: Ref<Record<PropertyKey, unknown> | null>,
    stablePort: Readonly<Record<PropertyKey, unknown>> = {},
) {
    return new Proxy(
        {},
        {
            get: (_proxyTarget, property): unknown => (property in stablePort ? stablePort[property] : target.value?.[property]),
            has: (_proxyTarget, property) => property in stablePort || property in (target.value ?? {}),
        },
    );
}
