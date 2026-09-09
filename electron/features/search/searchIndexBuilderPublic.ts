import type * as SearchIndexBuilder from '@electron/features/search/indexBuilder';

type TSearchIndexBuilder = typeof SearchIndexBuilder;

export async function buildSearchIndex(
    ...args: Parameters<TSearchIndexBuilder['buildSearchIndex']>
) {
    const {buildSearchIndex: build} = await import('@electron/features/search/indexBuilder');
    return build(...args);
}

export async function loadSearchIndex(
    ...args: Parameters<TSearchIndexBuilder['loadSearchIndex']>
) {
    const {loadSearchIndex: load} = await import('@electron/features/search/indexBuilder');
    return load(...args);
}
