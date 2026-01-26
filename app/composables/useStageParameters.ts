import type {
    IContentRect,
    IDeskewParams,
    IDewarpParams,
    IGlobalProcessingSettings,
    IMarginParams,
    IPageProcessingState,
    IProcessingProject,
    ISplitParams,
    TProcessingStage,
    TRotation,
} from 'electron/page-processing/project';

/**
 * Type mapping for stage-specific parameters.
 * In the electron model, these are stored flat on IPageProcessingState.
 */
type TStageParams = {
    rotation: TRotation;
    split: ISplitParams;
    deskew: IDeskewParams;
    dewarp: IDewarpParams;
    content: IContentRect;
    margins: IMarginParams;
    output: null;
};

/**
 * Composable for managing per-page parameter overrides.
 * Works with the electron data model where params are flat on page state.
 */
export const useStageParameters = (
    projectRef: () => IProcessingProject | null,
    updatePageFn: (pageNumber: number, updates: Partial<IPageProcessingState>) => void,
    updateProjectFn: (updates: Partial<IProcessingProject>) => void,
) => {
    /**
     * Gets the effective parameters for a page and stage.
     * Returns manual override if set, otherwise auto-detected value.
     */
    function getPageParams<S extends Exclude<TProcessingStage, 'output'>>(
        pageNumber: number,
        stage: S,
    ): TStageParams[S] | null {
        const project = projectRef();
        if (!project) {
            return null;
        }

        const pageIndex = pageNumber - 1;
        if (pageIndex < 0 || pageIndex >= project.pages.length) {
            return null;
        }

        const page = project.pages[pageIndex];
        if (!page) {
            return null;
        }

        // Get the value directly from page state
        // In electron model, manual overrides are stored directly on the page
        switch (stage) {
            case 'rotation':
                return (page.rotation ?? page.autoDetected.rotation) as TStageParams[S] | null;
            case 'split':
                return (page.split ?? page.autoDetected.split) as TStageParams[S] | null;
            case 'deskew':
                return (page.deskew ?? page.autoDetected.deskew) as TStageParams[S] | null;
            case 'dewarp':
                return (page.dewarp ?? page.autoDetected.dewarp) as TStageParams[S] | null;
            case 'content':
                return (page.contentRect ?? page.autoDetected.contentRect) as TStageParams[S] | null;
            case 'margins':
                return (page.margins ?? project.globalSettings.defaultMargins) as TStageParams[S] | null;
            default:
                return null;
        }
    }

    /**
     * Checks if a page has a manual override for a stage.
     */
    function hasPageOverride(pageNumber: number, stage: TProcessingStage): boolean {
        const project = projectRef();
        if (!project || stage === 'output') {
            return false;
        }

        const pageIndex = pageNumber - 1;
        if (pageIndex < 0 || pageIndex >= project.pages.length) {
            return false;
        }

        const page = project.pages[pageIndex];
        if (!page) {
            return false;
        }

        // Check if the direct property is set (not using auto-detected)
        switch (stage) {
            case 'rotation':
                return page.rotation !== null;
            case 'split':
                return page.split !== null;
            case 'deskew':
                return page.deskew !== null;
            case 'dewarp':
                return page.dewarp !== null;
            case 'content':
                return page.contentRect !== null;
            case 'margins':
                return page.margins !== null;
            default:
                return false;
        }
    }

    /**
     * Sets a manual override for a page and stage.
     */
    function setPageOverride<S extends Exclude<TProcessingStage, 'output'>>(
        pageNumber: number,
        stage: S,
        params: TStageParams[S],
    ): void {
        const updates: Partial<IPageProcessingState> = {};

        switch (stage) {
            case 'rotation':
                updates.rotation = params as TRotation;
                break;
            case 'split':
                updates.split = params as ISplitParams;
                break;
            case 'deskew':
                updates.deskew = params as IDeskewParams;
                break;
            case 'dewarp':
                updates.dewarp = params as IDewarpParams;
                break;
            case 'content':
                updates.contentRect = params as IContentRect;
                break;
            case 'margins':
                updates.margins = params as IMarginParams;
                break;
        }

        updatePageFn(pageNumber, updates);
    }

    /**
     * Clears the manual override for a page and stage, reverting to auto-detected.
     */
    function clearOverride(pageNumber: number, stage: TProcessingStage): void {
        if (stage === 'output') {
            return;
        }

        const updates: Partial<IPageProcessingState> = {};

        switch (stage) {
            case 'rotation':
                updates.rotation = null;
                break;
            case 'split':
                updates.split = null;
                break;
            case 'deskew':
                updates.deskew = null;
                break;
            case 'dewarp':
                updates.dewarp = null;
                break;
            case 'content':
                updates.contentRect = null;
                break;
            case 'margins':
                updates.margins = null;
                break;
        }

        updatePageFn(pageNumber, updates);
    }

    /**
     * Applies parameters to all pages for a stage.
     */
    function applyToAll<S extends Exclude<TProcessingStage, 'output'>>(
        stage: S,
        params: TStageParams[S],
    ): void {
        const project = projectRef();
        if (!project) {
            return;
        }

        const newPages = project.pages.map(page => {
            const newPage = { ...page };

            switch (stage) {
                case 'rotation':
                    newPage.rotation = params as TRotation;
                    break;
                case 'split':
                    newPage.split = params as ISplitParams;
                    break;
                case 'deskew':
                    newPage.deskew = params as IDeskewParams;
                    break;
                case 'dewarp':
                    newPage.dewarp = params as IDewarpParams;
                    break;
                case 'content':
                    newPage.contentRect = params as IContentRect;
                    break;
                case 'margins':
                    newPage.margins = params as IMarginParams;
                    break;
            }

            return newPage;
        });

        updateProjectFn({ pages: newPages });
    }

    /**
     * Applies parameters to a selection of pages for a stage.
     */
    function applyToSelection<S extends Exclude<TProcessingStage, 'output'>>(
        stage: S,
        params: TStageParams[S],
        pageNumbers: number[],
    ): void {
        const project = projectRef();
        if (!project) {
            return;
        }

        const pageSet = new Set(pageNumbers);

        const newPages = project.pages.map(page => {
            if (!pageSet.has(page.originalPageNumber)) {
                return page;
            }

            const newPage = { ...page };

            switch (stage) {
                case 'rotation':
                    newPage.rotation = params as TRotation;
                    break;
                case 'split':
                    newPage.split = params as ISplitParams;
                    break;
                case 'deskew':
                    newPage.deskew = params as IDeskewParams;
                    break;
                case 'dewarp':
                    newPage.dewarp = params as IDewarpParams;
                    break;
                case 'content':
                    newPage.contentRect = params as IContentRect;
                    break;
                case 'margins':
                    newPage.margins = params as IMarginParams;
                    break;
            }

            return newPage;
        });

        updateProjectFn({ pages: newPages });
    }

    /**
     * Clears overrides for all pages for a stage.
     */
    function clearAllOverrides(stage: TProcessingStage): void {
        const project = projectRef();
        if (!project || stage === 'output') {
            return;
        }

        const newPages = project.pages.map(page => {
            const newPage = { ...page };

            switch (stage) {
                case 'rotation':
                    newPage.rotation = null;
                    break;
                case 'split':
                    newPage.split = null;
                    break;
                case 'deskew':
                    newPage.deskew = null;
                    break;
                case 'dewarp':
                    newPage.dewarp = null;
                    break;
                case 'content':
                    newPage.contentRect = null;
                    break;
                case 'margins':
                    newPage.margins = null;
                    break;
            }

            return newPage;
        });

        updateProjectFn({ pages: newPages });
    }

    /**
     * Updates the global settings.
     */
    function updateGlobalSettings(updates: Partial<IGlobalProcessingSettings>): void {
        const project = projectRef();
        if (!project) {
            return;
        }

        updateProjectFn({globalSettings: {
            ...project.globalSettings,
            ...updates,
        }});
    }

    /**
     * Gets the global settings.
     */
    function getGlobalSettings(): IGlobalProcessingSettings | null {
        const project = projectRef();
        return project?.globalSettings ?? null;
    }

    /**
     * Checks if a page is using auto-detected values (no override).
     */
    function isUsingAutoDetected(pageNumber: number, stage: TProcessingStage): boolean {
        return !hasPageOverride(pageNumber, stage);
    }

    /**
     * Copies parameters from one page to another.
     */
    function copyParams(
        fromPageNumber: number,
        toPageNumber: number,
        stage: TProcessingStage,
    ): void {
        if (stage === 'output') {
            return;
        }

        const params = getPageParams(fromPageNumber, stage as Exclude<TProcessingStage, 'output'>);
        if (params) {
            setPageOverride(toPageNumber, stage as Exclude<TProcessingStage, 'output'>, params);
        }
    }

    /**
     * Gets the count of pages with overrides for a stage.
     */
    function getOverrideCount(stage: TProcessingStage): number {
        const project = projectRef();
        if (!project || stage === 'output') {
            return 0;
        }

        let count = 0;
        for (const page of project.pages) {
            let hasOverride = false;

            switch (stage) {
                case 'rotation':
                    hasOverride = page.rotation !== null;
                    break;
                case 'split':
                    hasOverride = page.split !== null;
                    break;
                case 'deskew':
                    hasOverride = page.deskew !== null;
                    break;
                case 'dewarp':
                    hasOverride = page.dewarp !== null;
                    break;
                case 'content':
                    hasOverride = page.contentRect !== null;
                    break;
                case 'margins':
                    hasOverride = page.margins !== null;
                    break;
            }

            if (hasOverride) {
                count++;
            }
        }

        return count;
    }

    /**
     * Gets all pages that have overrides for a stage.
     */
    function getPagesWithOverrides(stage: TProcessingStage): number[] {
        const project = projectRef();
        if (!project || stage === 'output') {
            return [];
        }

        const pages: number[] = [];

        for (const page of project.pages) {
            let hasOverride = false;

            switch (stage) {
                case 'rotation':
                    hasOverride = page.rotation !== null;
                    break;
                case 'split':
                    hasOverride = page.split !== null;
                    break;
                case 'deskew':
                    hasOverride = page.deskew !== null;
                    break;
                case 'dewarp':
                    hasOverride = page.dewarp !== null;
                    break;
                case 'content':
                    hasOverride = page.contentRect !== null;
                    break;
                case 'margins':
                    hasOverride = page.margins !== null;
                    break;
            }

            if (hasOverride) {
                pages.push(page.originalPageNumber);
            }
        }

        return pages;
    }

    return {
        // Methods
        getPageParams,
        hasPageOverride,
        setPageOverride,
        clearOverride,
        applyToAll,
        applyToSelection,
        clearAllOverrides,
        updateGlobalSettings,
        getGlobalSettings,
        isUsingAutoDetected,
        copyParams,
        getOverrideCount,
        getPagesWithOverrides,
    };
};
