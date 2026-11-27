import type {TAssistantDriver} from '@contracts/assistant';
// T3 Code apps/server/src/provider/model-manifest.json (e8d3075e48), MIT, copied unchanged.
import manifest from '@electron/features/agent/t3ModelManifest.json';

interface IManifestEffortOption {
    id: string;
    isDefault?: boolean;
}

interface IManifestModel {
    slug: string;
    aliases?: string[];
    status?: string;
    profile?: string;
}

interface IManifestProvider {
    profiles?: Record<string, {capabilities?: {optionDescriptors?: Array<{id: string; options?: IManifestEffortOption[]}>}}>;
    models: IManifestModel[];
}

const PROVIDER_BY_DRIVER: Record<TAssistantDriver, string> = {
    codex: 'codex',
    claude: 'claudeAgent',
};

export interface IAssistantManifestModel {
    isLegacy: boolean;
    defaultEffort: string | null;
}

/**
 * What T3 Code's bundled catalog knows about a reported model: whether it is
 * legacy (listed under "Show more") and its default reasoning level, which
 * Claude Code itself does not report.
 */
export function describeManifestModel(driver: TAssistantDriver, ids: readonly string[]): IAssistantManifestModel | null {
    const provider = (manifest.providers as Record<string, IManifestProvider | undefined>)[PROVIDER_BY_DRIVER[driver]];
    if (!provider) {
        return null;
    }
    const wanted = new Set(
        ids
            .map((id) =>
                id
                    .trim()
                    .toLowerCase()
                    .replace(/\[[^\]]*\]$/u, '')
                    .replace(/-\d{8}$/u, ''),
            )
            .filter(Boolean),
    );
    const model =
        provider.models.find((entry) => wanted.has(entry.slug.toLowerCase())) ??
        provider.models.find((entry) => entry.aliases?.some((alias) => wanted.has(alias.toLowerCase())));
    if (!model) {
        return null;
    }
    const effort = model.profile
        ? provider.profiles?.[model.profile]?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === 'effort')
        : undefined;
    return {
        isLegacy: model.status === 'legacy',
        defaultEffort: effort?.options?.find((option) => option.isDefault)?.id ?? null,
    };
}
