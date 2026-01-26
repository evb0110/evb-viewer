import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import type {
    IPageProcessingState,
    IProcessingProject,
    TProcessingStage,
} from 'electron/page-processing/project';
import { getElectronAPI } from '@app/utils/electron';

/**
 * Composable for managing the processing project state.
 * Handles loading, saving, creating, and closing projects.
 */
export const useProcessingProject = () => {
    const project = shallowRef<IProcessingProject | null>(null);
    const isLoading = ref(false);
    const isSaving = ref(false);
    const error = ref<string | null>(null);

    let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const SAVE_DEBOUNCE_MS = 1000;

    const hasProject = computed(() => project.value !== null);

    const projectId = computed(() => project.value?.id ?? null);

    const pageCount = computed(() => project.value?.totalPages ?? 0);

    const originalPdfPath = computed(() => project.value?.originalPdfPath ?? null);

    const workingCopyPath = computed(() => project.value?.workingCopyPath ?? null);

    const currentStage = computed(() => project.value?.currentStage ?? 'rotation');

    /**
     * Creates a new processing project from a PDF path.
     */
    async function createProject(pdfPath: string, pageCount: number): Promise<string | null> {
        isLoading.value = true;
        error.value = null;

        try {
            const api = getElectronAPI();

            // Create project via IPC
            const result = await api.pageProcessing.createProject({
                pdfPath,
                pageCount,
            });

            if (!result.success || !result.projectId) {
                throw new Error(result.error ?? 'Failed to create project');
            }

            // Load the created project
            const loadResult = await api.pageProcessing.loadProject(result.projectId);

            if (!loadResult.success || !loadResult.project) {
                throw new Error(loadResult.error ?? 'Failed to load created project');
            }

            project.value = loadResult.project;
            return result.projectId;
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to create project';
            return null;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * Loads an existing project by ID.
     */
    async function loadProject(projectIdToLoad: string): Promise<boolean> {
        isLoading.value = true;
        error.value = null;

        try {
            const api = getElectronAPI();

            // Load project state from backend
            const result = await api.pageProcessing.loadProject(projectIdToLoad);

            if (!result.success || !result.project) {
                throw new Error(result.error ?? 'Project not found');
            }

            // Validate schema version
            if (result.project.schemaVersion !== 1) {
                console.warn('[useProcessingProject] Project schema version mismatch, migration may be needed');
            }

            project.value = result.project;
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to load project';
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    /**
     * Saves the current project state with debouncing.
     */
    function saveProject(): void {
        if (!project.value) {
            return;
        }

        // Clear existing debounce timer
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
        }

        saveDebounceTimer = setTimeout(() => {
            saveProjectImmediate();
        }, SAVE_DEBOUNCE_MS);
    }

    /**
     * Saves the current project state immediately (no debounce).
     */
    async function saveProjectImmediate(): Promise<boolean> {
        if (!project.value) {
            return false;
        }

        isSaving.value = true;

        try {
            const api = getElectronAPI();

            // Update modification timestamp
            const updatedProject: IProcessingProject = {
                ...project.value,
                modifiedAt: Date.now(),
            };

            const result = await api.pageProcessing.saveProject(updatedProject);

            if (!result.success) {
                throw new Error(result.error ?? 'Failed to save project');
            }

            project.value = updatedProject;
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to save project';
            return false;
        } finally {
            isSaving.value = false;
        }
    }

    /**
     * Updates the project state and triggers auto-save.
     */
    function updateProject(updates: Partial<IProcessingProject>): void {
        if (!project.value) {
            return;
        }

        project.value = {
            ...project.value,
            ...updates,
        };

        saveProject();
    }

    /**
     * Updates a specific page's state.
     */
    function updatePage(pageNumber: number, updates: Partial<IPageProcessingState>): void {
        if (!project.value) {
            return;
        }

        const pageIndex = pageNumber - 1;
        if (pageIndex < 0 || pageIndex >= project.value.pages.length) {
            return;
        }

        const existingPage = project.value.pages[pageIndex];
        if (!existingPage) {
            return;
        }

        const newPages = [...project.value.pages];
        newPages[pageIndex] = {
            ...existingPage,
            ...updates,
        };

        project.value = {
            ...project.value,
            pages: newPages,
        };

        saveProject();
    }

    /**
     * Gets a specific page's state.
     */
    function getPage(pageNumber: number): IPageProcessingState | null {
        if (!project.value) {
            return null;
        }

        const pageIndex = pageNumber - 1;
        if (pageIndex < 0 || pageIndex >= project.value.pages.length) {
            return null;
        }

        return project.value.pages[pageIndex] ?? null;
    }

    /**
     * Closes the current project and cleans up resources.
     */
    async function closeProject(): Promise<void> {
        // Flush any pending saves
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }

        // Save before closing
        await saveProjectImmediate();

        project.value = null;
        error.value = null;
    }

    /**
     * Resets the project to initial state (discards all changes).
     */
    async function resetProject(): Promise<boolean> {
        if (!project.value) {
            return false;
        }

        const currentProjectId = project.value.id;
        project.value = null;
        return loadProject(currentProjectId);
    }

    /**
     * Sets the current stage.
     */
    function setCurrentStage(stage: TProcessingStage): void {
        if (!project.value) {
            return;
        }

        project.value = {
            ...project.value,
            currentStage: stage,
        };

        saveProject();
    }

    return {
        // State
        project,
        isLoading,
        isSaving,
        error,

        // Computed
        hasProject,
        projectId,
        pageCount,
        originalPdfPath,
        workingCopyPath,
        currentStage,

        // Methods
        createProject,
        loadProject,
        saveProject,
        saveProjectImmediate,
        closeProject,
        resetProject,
        updateProject,
        updatePage,
        getPage,
        setCurrentStage,
    };
};
