import {stat} from 'fs/promises';

export async function canUseLocalTiffCombineFallback(pagePaths: string[], maxPages: number, maxTotalBytes: number) {
    if (pagePaths.length > maxPages) {
        return false;
    }

    let totalBytes = 0;
    for (const pagePath of pagePaths) {
        let pageStat;
        try {
            pageStat = await stat(pagePath);
        } catch {
            return false;
        }
        if (!pageStat.isFile()) {
            return false;
        }

        totalBytes += pageStat.size;
        if (totalBytes > maxTotalBytes) {
            return false;
        }
    }

    return true;
}
