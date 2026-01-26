import {
    computed,
    ref,
    watch,
} from 'vue';
import type {
    IProcessingProject,
    TProcessingStage,
    TPageStatus,
} from 'electron/page-processing/project';

/**
 * Stage display order and metadata
 */
const PROCESSING_STAGES: Array<{
    key: TProcessingStage;
    label: string;
    description: string;
}> = [
    {
        key: 'rotation',
        label: 'Rotation',
        description: 'Fix page orientation (0/90/180/270 degrees)',
    },
    {
        key: 'split',
        label: 'Split Pages',
        description: 'Split facing pages into single pages',
    },
    {
        key: 'deskew',
        label: 'Deskew',
        description: 'Correct page skew/rotation',
    },
    {
        key: 'dewarp',
        label: 'Dewarp',
        description: 'Remove page curvature from book scans',
    },
    {
        key: 'content',
        label: 'Content',
        description: 'Detect and crop to content bounds',
    },
    {
        key: 'margins',
        label: 'Margins',
        description: 'Set output margins and padding',
    },
    {
        key: 'output',
        label: 'Output',
        description: 'Generate final processed PDF',
    },
];

/**
 * Stage prerequisites (which stages must be complete before this one)
 */
const STAGE_PREREQUISITES: Record<TProcessingStage, TProcessingStage[]> = {
    rotation: [],
    split: ['rotation'],
    deskew: [
        'rotation',
        'split',
    ],
    dewarp: [
        'rotation',
        'split',
        'deskew',
    ],
    content: [
        'rotation',
        'split',
        'deskew',
        'dewarp',
    ],
    margins: [
        'rotation',
        'split',
        'deskew',
        'dewarp',
        'content',
    ],
    output: [
        'rotation',
        'split',
        'deskew',
        'dewarp',
        'content',
        'margins',
    ],
};

/**
 * Composable for managing stage workflow navigation and gating.
 * Tracks current stage, stage statuses, and validates stage transitions.
 */
export const useProcessingStages = (
    projectRef: () => IProcessingProject | null,
    updateProjectFn: (updates: Partial<IProcessingProject>) => void,
) => {
    const currentStage = ref<TProcessingStage>('rotation');

    // Sync with project when it changes
    watch(
        () => projectRef(),
        (newProject) => {
            if (newProject) {
                currentStage.value = newProject.currentStage;
            }
        },
        { immediate: true },
    );

    const stages = computed(() => PROCESSING_STAGES);

    const currentStageIndex = computed(() => {
        return PROCESSING_STAGES.findIndex(s => s.key === currentStage.value);
    });

    const currentStageInfo = computed(() => {
        return PROCESSING_STAGES.find(s => s.key === currentStage.value) ?? null;
    });

    const isFirstStage = computed(() => currentStageIndex.value === 0);

    const isLastStage = computed(() => currentStageIndex.value === PROCESSING_STAGES.length - 1);

    /**
     * Gets the aggregate status for all pages.
     * Since the electron model uses a single `status` per page (not per stage),
     * we check if all pages have a completed status.
     */
    function getOverallPageStatus(): TPageStatus {
        const project = projectRef();
        if (!project || project.pages.length === 0) {
            return 'pending';
        }

        let hasError = false;
        let hasProcessing = false;
        let allComplete = true;

        for (const page of project.pages) {
            if (page.status === 'error') {
                hasError = true;
            }
            if (page.status === 'processing') {
                hasProcessing = true;
            }
            if (page.status !== 'complete') {
                allComplete = false;
            }
        }

        if (hasError) {
            return 'error';
        }
        if (hasProcessing) {
            return 'processing';
        }
        if (allComplete) {
            return 'complete';
        }
        return 'pending';
    }

    /**
     * Checks if all prerequisites for a stage are complete.
     * In the simplified model, we just check if earlier stages have been visited.
     */
    function arePrerequisitesMet(stage: TProcessingStage): boolean {
        const targetIndex = PROCESSING_STAGES.findIndex(s => s.key === stage);
        const currentIndex = currentStageIndex.value;

        // Can always go to current or earlier stages
        return targetIndex <= currentIndex + 1;
    }

    /**
     * Checks if we can advance to a specific stage.
     */
    function canAdvanceToStage(stage: TProcessingStage): boolean {
        const targetIndex = PROCESSING_STAGES.findIndex(s => s.key === stage);
        if (targetIndex <= currentStageIndex.value) {
            return true;
        }
        return arePrerequisitesMet(stage);
    }

    /**
     * Gets the list of incomplete prerequisites for a stage.
     */
    function getIncompletePrerequisites(stage: TProcessingStage): TProcessingStage[] {
        const prerequisites = STAGE_PREREQUISITES[stage];
        const incomplete: TProcessingStage[] = [];
        const currentIndex = currentStageIndex.value;

        for (const prereq of prerequisites) {
            const prereqIndex = PROCESSING_STAGES.findIndex(s => s.key === prereq);
            if (prereqIndex > currentIndex) {
                incomplete.push(prereq);
            }
        }

        return incomplete;
    }

    /**
     * Sets the current stage.
     */
    function setStage(stage: TProcessingStage): boolean {
        if (!canAdvanceToStage(stage)) {
            return false;
        }

        currentStage.value = stage;
        updateProjectFn({ currentStage: stage });

        return true;
    }

    /**
     * Advances to the next stage if possible.
     */
    function nextStage(): boolean {
        if (isLastStage.value) {
            return false;
        }

        const nextIndex = currentStageIndex.value + 1;
        const nextStageKey = PROCESSING_STAGES[nextIndex]?.key;

        if (!nextStageKey) {
            return false;
        }

        return setStage(nextStageKey);
    }

    /**
     * Goes back to the previous stage.
     */
    function previousStage(): boolean {
        if (isFirstStage.value) {
            return false;
        }

        const prevIndex = currentStageIndex.value - 1;
        const prevStageKey = PROCESSING_STAGES[prevIndex]?.key;

        if (!prevStageKey) {
            return false;
        }

        return setStage(prevStageKey);
    }

    /**
     * Gets pages with errors.
     */
    function getPagesWithErrors(): number[] {
        const project = projectRef();
        if (!project) {
            return [];
        }

        const errorPages: number[] = [];

        for (const page of project.pages) {
            if (page.status === 'error') {
                errorPages.push(page.originalPageNumber);
            }
        }

        return errorPages;
    }

    /**
     * Gets pages that are still pending.
     */
    function getPendingPages(): number[] {
        const project = projectRef();
        if (!project) {
            return [];
        }

        const pendingPages: number[] = [];

        for (const page of project.pages) {
            if (page.status === 'pending') {
                pendingPages.push(page.originalPageNumber);
            }
        }

        return pendingPages;
    }

    return {
        // State
        currentStage,

        // Computed
        stages,
        currentStageIndex,
        currentStageInfo,
        isFirstStage,
        isLastStage,

        // Methods
        getOverallPageStatus,
        arePrerequisitesMet,
        canAdvanceToStage,
        getIncompletePrerequisites,
        setStage,
        nextStage,
        previousStage,
        getPagesWithErrors,
        getPendingPages,
    };
};
