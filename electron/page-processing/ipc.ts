import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
    app,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'fs/promises';
import { Worker } from 'worker_threads';
import {
    getPageProcessingPaths,
    validatePageProcessingTools,
} from '@electron/page-processing/paths';
import type {
    IProcessingJob,
    IProcessingRequest,
    IProcessingProgress,
    IProcessingResult,
} from '@electron/page-processing/types';
import type {
    ICreateProjectRequest,
    ICreateProjectResult,
    IGenerateOutputRequest,
    IGenerateOutputResult,
    ILoadProjectResult,
    IPreviewStageRequest,
    IPreviewStageResult,
    IProcessingProject,
    IProjectStatusResult,
    IRunStageRequest,
    IRunStageResult,
    ISaveProjectResult,
} from '@electron/page-processing/project';
import { createProject } from '@electron/page-processing/project';
import { createLogger } from '@electron/utils/logger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('page-processing-ipc');

// Track active processing jobs
const activeJobs = new Map<string, IProcessingJob>();

// Track active stage jobs (for the new stage-based pipeline)
const activeStageJobs = new Map<string, {
    worker: Worker;
    aborted: boolean 
}>();

// ============================================================================
// Project Storage Functions
// ============================================================================

function getProjectsBaseDir(): string {
    return join(app.getPath('userData'), 'page-processing');
}

function getProjectDir(projectId: string): string {
    return join(getProjectsBaseDir(), projectId);
}

function getProjectFilePath(projectId: string): string {
    return join(getProjectDir(projectId), 'project.json');
}

async function ensureProjectsDir(): Promise<void> {
    const baseDir = getProjectsBaseDir();
    await mkdir(baseDir, { recursive: true });
}

async function ensureProjectDir(projectId: string): Promise<string> {
    const projectDir = getProjectDir(projectId);
    await mkdir(projectDir, { recursive: true });
    // Create standard subdirectories
    await mkdir(join(projectDir, 'cache'), { recursive: true });
    await mkdir(join(projectDir, 'previews'), { recursive: true });
    await mkdir(join(projectDir, 'output'), { recursive: true });
    return projectDir;
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    const jsonContent = JSON.stringify(data, null, 2);

    try {
        await writeFile(tempPath, jsonContent, 'utf-8');
        await rename(tempPath, filePath);
    } catch (err) {
        // Clean up temp file if rename failed
        try {
            await rm(tempPath, { force: true });
        } catch {
            // Ignore cleanup errors
        }
        throw err;
    }
}

async function readProjectFile(projectId: string): Promise<IProcessingProject | null> {
    const filePath = getProjectFilePath(projectId);
    try {
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content) as IProcessingProject;
    } catch {
        return null;
    }
}

async function writeProjectFile(project: IProcessingProject): Promise<void> {
    const filePath = getProjectFilePath(project.id);
    await atomicWriteJson(filePath, project);
}

function safeSendToWindow(
    window: BrowserWindow | null | undefined,
    channel: string,
    ...args: unknown[]
) {
    if (!window) {
        return;
    }
    if (window.isDestroyed()) {
        return;
    }
    if (window.webContents.isDestroyed()) {
        return;
    }

    try {
        window.webContents.send(channel, ...args);
    } catch (err) {
        log.debug(`Failed to send IPC message to channel "${channel}": ${err instanceof Error ? err.message : String(err)}`);
    }
}

function getWorkerPath(): string {
    // Worker is compiled to dist-electron alongside main.js
    // __dirname resolves to dist-electron (where main.js is)
    return join(__dirname, 'page-processing-worker.js');
}

function createWorker(request: IProcessingRequest): Worker {
    const paths = getPageProcessingPaths();
    const workerPath = getWorkerPath();

    log.debug(`Creating page processing worker: ${workerPath}`);
    log.debug(`Tool paths: processor=${paths.processor}, pdftoppm=${paths.pdftoppm}, qpdf=${paths.qpdf}`);

    return new Worker(workerPath, {workerData: {
        processorBinary: paths.processor,
        pdftoppmBinary: paths.pdftoppm,
        qpdfBinary: paths.qpdf,
        tempDir: app.getPath('temp'),
        request,
    }});
}

function handleWorkerMessage(
    jobId: string,
    webContentsId: number,
    message: {
        type: 'progress' | 'complete' | 'log';
        jobId?: string;
        progress?: IProcessingProgress;
        result?: IProcessingResult;
        level?: string;
        message?: string;
    },
) {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === webContentsId);

    if (message.type === 'log') {
        // Forward worker logs to main logger
        const logLevel = message.level || 'debug';
        if (logLevel === 'warn') {
            log.warn(message.message || '');
        } else if (logLevel === 'error') {
            log.debug(`[worker-error] ${message.message || ''}`);
        } else {
            log.debug(`[worker] ${message.message || ''}`);
        }

        // Forward worker logs to renderer console
        safeSendToWindow(window, 'pageProcessing:log', {
            jobId,
            level: logLevel,
            message: message.message || '',
        });
        return;
    }

    if (message.type === 'progress' && message.progress) {
        // Forward progress to renderer
        safeSendToWindow(window, 'pageProcessing:progress', message.progress);
        return;
    }

    if (message.type === 'complete' && message.result) {
        // Forward completion to renderer
        safeSendToWindow(window, 'pageProcessing:complete', message.result);

        // Mark as completed; the worker exits naturally when it has no more work.
        // Avoid `worker.terminate()` here because it exits with code 1.
        const job = activeJobs.get(jobId);
        if (job) {
            job.completed = true;
        }
        return;
    }
}

/**
 * Start a new page processing job.
 *
 * This function returns immediately with the job status. The actual processing
 * happens in a separate worker thread, and results are sent via 'pageProcessing:complete'
 * IPC message when done.
 */
function handleProcess(
    event: IpcMainInvokeEvent,
    request: IProcessingRequest,
): {
    started: boolean;
    jobId: string;
    error?: string;
} {
    const { jobId } = request;
    log.debug(`handleProcess called: jobId=${jobId}, pdfPath=${request.pdfPath}, pages=${request.pages.length}`);

    try {
        const worker = createWorker(request);
        const webContentsId = event.sender.id;

        // Track the job
        activeJobs.set(jobId, {
            jobId,
            worker,
            webContentsId,
            completed: false,
            terminatedByUs: false,
            startTime: Date.now(),
        });

        // Handle messages from worker
        worker.on('message', (message) => {
            handleWorkerMessage(jobId, webContentsId, message);
        });

        // Handle worker errors - mark as completed to prevent exit handler from also sending failure
        worker.on('error', (err: Error) => {
            log.debug(`Worker error for job ${jobId}: ${err.message}`);
            const job = activeJobs.get(jobId);
            if (job) {
                job.completed = true;
                job.terminatedByUs = true;
                job.worker.terminate();
            }
            const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === webContentsId);
            safeSendToWindow(window, 'pageProcessing:complete', {
                jobId,
                success: false,
                pageResults: [],
                errors: [`Worker error: ${err.message}`],
                stats: {
                    totalPagesInput: request.pages.length,
                    totalPagesOutput: 0,
                    processingTimeMs: Date.now() - (job?.startTime ?? Date.now()),
                },
            } satisfies IProcessingResult);
        });

        // Handle worker exit - only send failure if job wasn't already completed
        // Worker.terminate() causes exit code 1, so we need to check if we terminated it intentionally
        worker.on('exit', (code) => {
            const job = activeJobs.get(jobId);
            const wasCompletedOrTerminated = job?.completed || job?.terminatedByUs;

            if (code !== 0 && !wasCompletedOrTerminated) {
                log.debug(`Worker exited with code ${code} for job ${jobId}`);
                const window = BrowserWindow.getAllWindows().find(w => w.webContents.id === webContentsId);
                safeSendToWindow(window, 'pageProcessing:log', {
                    jobId,
                    level: 'error',
                    message: `Worker exited with code ${code}`,
                });
                safeSendToWindow(window, 'pageProcessing:complete', {
                    jobId,
                    success: false,
                    pageResults: [],
                    errors: [`Worker exited unexpectedly with code ${code}`],
                    stats: {
                        totalPagesInput: request.pages.length,
                        totalPagesOutput: 0,
                        processingTimeMs: Date.now() - (job?.startTime ?? Date.now()),
                    },
                } satisfies IProcessingResult);
            }
            activeJobs.delete(jobId);
        });

        // Start the processing job in the worker (worker starts automatically with workerData)
        log.debug(`Page processing job ${jobId} started in worker thread`);

        // Return immediately - results will be sent via 'pageProcessing:complete' event
        return {
            started: true,
            jobId,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to start page processing worker: ${errMsg}`);
        return {
            started: false,
            jobId,
            error: errMsg,
        };
    }
}

/**
 * Cancel an active processing job.
 */
function handleCancel(
    _event: IpcMainInvokeEvent,
    jobId: string,
): {
    cancelled: boolean;
    error?: string;
} {
    log.debug(`handleCancel called: jobId=${jobId}`);

    const job = activeJobs.get(jobId);
    if (!job) {
        return {
            cancelled: false,
            error: `Job not found: ${jobId}`,
        };
    }

    try {
        job.completed = true;
        job.terminatedByUs = true;
        job.worker.terminate();

        log.debug(`Job ${jobId} cancelled successfully`);
        return {cancelled: true};
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to cancel job ${jobId}: ${errMsg}`);
        return {
            cancelled: false,
            error: errMsg,
        };
    }
}

/**
 * Validate that all required tools are available.
 * This is now fully async and non-blocking.
 */
function handleValidateTools() {
    return validatePageProcessingTools();
}

// ============================================================================
// New Project-Based IPC Handlers
// ============================================================================

function generateProjectId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `proj_${timestamp}_${random}`;
}

/**
 * Create a new processing project from a PDF file.
 */
async function handleCreateProject(
    _event: IpcMainInvokeEvent,
    request: ICreateProjectRequest,
): Promise<ICreateProjectResult> {
    log.debug(`handleCreateProject: pdfPath=${request.pdfPath}`);

    try {
        await ensureProjectsDir();

        const projectId = generateProjectId();
        const projectDir = await ensureProjectDir(projectId);

        // Determine working copy path
        const workingCopyPath = request.workingCopyPath ?? join(projectDir, 'working-copy.pdf');
        const pageCount = request.pageCount ?? 0;

        // Create project using the helper function
        const project = createProject(
            request.pdfPath,
            pageCount,
            workingCopyPath,
        );

        // Override the generated ID with our project ID
        project.id = projectId;

        // Apply custom settings if provided
        if (request.globalSettings) {
            Object.assign(project.globalSettings, request.globalSettings);
        }
        if (request.outputSettings) {
            Object.assign(project.outputSettings, request.outputSettings);
        }

        await writeProjectFile(project);

        log.debug(`Project created: ${projectId}`);
        return {
            success: true,
            projectId,
            projectDir,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to create project: ${errMsg}`);
        return {
            success: false,
            error: errMsg,
        };
    }
}

/**
 * Load an existing project by ID.
 */
async function handleLoadProject(
    _event: IpcMainInvokeEvent,
    projectId: string,
): Promise<ILoadProjectResult> {
    log.debug(`handleLoadProject: projectId=${projectId}`);

    try {
        const project = await readProjectFile(projectId);

        if (!project) {
            return {
                success: false,
                error: `Project not found: ${projectId}`,
            };
        }

        return {
            success: true,
            project,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to load project: ${errMsg}`);
        return {
            success: false,
            error: errMsg,
        };
    }
}

/**
 * Save project state to disk.
 */
async function handleSaveProject(
    _event: IpcMainInvokeEvent,
    project: IProcessingProject,
): Promise<ISaveProjectResult> {
    log.debug(`handleSaveProject: projectId=${project.id}`);

    try {
        // Update timestamp
        project.modifiedAt = Date.now();

        await writeProjectFile(project);

        return { success: true };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to save project: ${errMsg}`);
        return {
            success: false,
            error: errMsg,
        };
    }
}

/**
 * Run detection/processing for a specific stage.
 * This runs in a worker thread and sends progress via IPC events.
 */
async function handleRunStage(
    event: IpcMainInvokeEvent,
    request: IRunStageRequest,
): Promise<IRunStageResult> {
    const {
        projectId,
        stage,
        pages,
    } = request;
    const jobId = `${projectId}_${stage}_${Date.now()}`;
    log.debug(`handleRunStage: projectId=${projectId}, stage=${stage}, pages=${pages?.length ?? 'all'}`);

    try {
        const project = await readProjectFile(projectId);
        if (!project) {
            return {
                success: false,
                jobId,
                error: `Project not found: ${projectId}`,
            };
        }

        // For now, return success indicating the job was started
        // The actual worker implementation will be added when the Python pipeline is ready
        const _webContentsId = event.sender.id;

        // TODO: Create and run worker for stage processing
        // This is a placeholder for now - will integrate with Python pipeline
        log.debug(`Stage job ${jobId} would run here (worker not yet implemented)`);

        return {
            success: true,
            jobId,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to run stage: ${errMsg}`);
        return {
            success: false,
            jobId,
            error: errMsg,
        };
    }
}

/**
 * Get a preview image for the current stage parameters.
 */
async function handlePreviewStage(
    _event: IpcMainInvokeEvent,
    request: IPreviewStageRequest,
): Promise<IPreviewStageResult> {
    const {
        projectId,
        stage,
        pageNumber,
    } = request;
    log.debug(`handlePreviewStage: projectId=${projectId}, stage=${stage}, page=${pageNumber}`);

    try {
        const project = await readProjectFile(projectId);
        if (!project) {
            return {
                success: false,
                error: `Project not found: ${projectId}`,
            };
        }

        // Check if cached preview exists
        const projectDir = getProjectDir(projectId);
        const previewPath = join(
            projectDir,
            'previews',
            `${stage}_page${pageNumber}.png`,
        );

        // TODO: Generate preview if not cached
        // This is a placeholder - will integrate with Python pipeline

        return {
            success: true,
            previewPath,
            cached: false,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to generate preview: ${errMsg}`);
        return {
            success: false,
            error: errMsg,
        };
    }
}

/**
 * Cancel a running stage job.
 */
function handleCancelStage(
    _event: IpcMainInvokeEvent,
    jobId: string,
): {
    cancelled: boolean;
    error?: string 
} {
    log.debug(`handleCancelStage: jobId=${jobId}`);

    const job = activeStageJobs.get(jobId);
    if (!job) {
        return {
            cancelled: false,
            error: `Stage job not found: ${jobId}`,
        };
    }

    try {
        job.aborted = true;
        job.worker.terminate();
        activeStageJobs.delete(jobId);

        log.debug(`Stage job ${jobId} cancelled successfully`);
        return { cancelled: true };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to cancel stage job ${jobId}: ${errMsg}`);
        return {
            cancelled: false,
            error: errMsg,
        };
    }
}

/**
 * Generate final output PDF from processed pages.
 */
async function handleGenerateOutput(
    event: IpcMainInvokeEvent,
    request: IGenerateOutputRequest,
): Promise<IGenerateOutputResult> {
    const { projectId } = request;
    const jobId = `${projectId}_output_${Date.now()}`;
    log.debug(`handleGenerateOutput: projectId=${projectId}`);

    try {
        const project = await readProjectFile(projectId);
        if (!project) {
            return {
                success: false,
                jobId,
                error: `Project not found: ${projectId}`,
            };
        }

        // TODO: Create worker to generate output PDF
        // This is a placeholder - will integrate with Python pipeline

        return {
            success: true,
            jobId,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to generate output: ${errMsg}`);
        return {
            success: false,
            jobId,
            error: errMsg,
        };
    }
}

/**
 * Get current project status and state.
 */
async function handleGetProjectStatus(
    _event: IpcMainInvokeEvent,
    projectId: string,
): Promise<IProjectStatusResult> {
    log.debug(`handleGetProjectStatus: projectId=${projectId}`);

    try {
        const project = await readProjectFile(projectId);
        if (!project) {
            return {
                success: false,
                error: `Project not found: ${projectId}`,
            };
        }

        // Calculate stats based on page status
        const totalPages = project.pages.length;
        let completedPages = 0;

        for (const page of project.pages) {
            if (page.status === 'complete') {
                completedPages++;
            }
        }

        // Determine overall project status based on page statuses
        let status: 'idle' | 'processing' | 'error' | 'complete' = 'idle';
        const hasProcessing = project.pages.some(p => p.status === 'processing');
        const hasErrors = project.pages.some(p => p.status === 'error');
        const allComplete = project.pages.every(p => p.status === 'complete');

        if (hasProcessing) {
            status = 'processing';
        } else if (allComplete && totalPages > 0) {
            status = 'complete';
        } else if (hasErrors) {
            status = 'error';
        }

        return {
            success: true,
            status,
            currentStage: project.currentStage,
            stats: {
                totalPages,
                completedStages: completedPages,
                totalStages: totalPages,
                warnings: 0,
            },
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to get project status: ${errMsg}`);
        return {
            success: false,
            error: errMsg,
        };
    }
}

/**
 * List all available projects.
 */
async function handleListProjects(
    _event: IpcMainInvokeEvent,
): Promise<{
    success: boolean;
    projects?: Array<{
        id: string;
        originalPdfPath: string;
        createdAt: number;
        updatedAt: number;
        status: string;
    }>;
    error?: string;
}> {
    log.debug('handleListProjects');

    try {
        await ensureProjectsDir();
        const baseDir = getProjectsBaseDir();
        const entries = await readdir(baseDir, { withFileTypes: true });

        const projects: Array<{
            id: string;
            originalPdfPath: string;
            createdAt: number;
            updatedAt: number;
            status: string;
        }> = [];

        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('proj_')) {
                const project = await readProjectFile(entry.name);
                if (project) {
                    // Derive status from page statuses
                    const hasProcessing = project.pages.some(p => p.status === 'processing');
                    const hasErrors = project.pages.some(p => p.status === 'error');
                    const allComplete = project.pages.length > 0 && project.pages.every(p => p.status === 'complete');

                    let status = 'idle';
                    if (hasProcessing) {
                        status = 'processing';
                    } else if (allComplete) {
                        status = 'complete';
                    } else if (hasErrors) {
                        status = 'error';
                    }

                    projects.push({
                        id: project.id,
                        originalPdfPath: project.originalPdfPath,
                        createdAt: project.createdAt,
                        updatedAt: project.modifiedAt,
                        status,
                    });
                }
            }
        }

        // Sort by updatedAt descending (most recent first)
        projects.sort((a, b) => b.updatedAt - a.updatedAt);

        return {
            success: true,
            projects,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to list projects: ${errMsg}`);
        return {
            success: false,
            error: errMsg,
        };
    }
}

/**
 * Delete a project and all its artifacts.
 */
async function handleDeleteProject(
    _event: IpcMainInvokeEvent,
    projectId: string,
): Promise<{
    success: boolean;
    error?: string 
}> {
    log.debug(`handleDeleteProject: projectId=${projectId}`);

    try {
        const projectDir = getProjectDir(projectId);
        await rm(projectDir, {
            recursive: true,
            force: true, 
        });

        log.debug(`Project deleted: ${projectId}`);
        return { success: true };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to delete project: ${errMsg}`);
        return {
            success: false,
            error: errMsg,
        };
    }
}

export function registerPageProcessingHandlers() {
    // Legacy handlers (for existing pipeline)
    ipcMain.handle('pageProcessing:process', handleProcess);
    ipcMain.handle('pageProcessing:cancel', handleCancel);
    ipcMain.handle('pageProcessing:validateTools', handleValidateTools);

    // New project-based handlers
    ipcMain.handle('pageProcessing:createProject', handleCreateProject);
    ipcMain.handle('pageProcessing:loadProject', handleLoadProject);
    ipcMain.handle('pageProcessing:saveProject', handleSaveProject);
    ipcMain.handle('pageProcessing:listProjects', handleListProjects);
    ipcMain.handle('pageProcessing:deleteProject', handleDeleteProject);
    ipcMain.handle('pageProcessing:runStage', handleRunStage);
    ipcMain.handle('pageProcessing:previewStage', handlePreviewStage);
    ipcMain.handle('pageProcessing:cancelStage', handleCancelStage);
    ipcMain.handle('pageProcessing:generateOutput', handleGenerateOutput);
    ipcMain.handle('pageProcessing:getProjectStatus', handleGetProjectStatus);
}
