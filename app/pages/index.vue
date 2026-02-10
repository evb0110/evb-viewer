<template>
    <div class="h-screen flex flex-col bg-neutral-100 dark:bg-neutral-900">
        <!-- Toolbar -->
        <header class="toolbar">
            <UTooltip v-if="!pdfSrc" text="Open PDF" :delay-duration="1200">
                <UButton
                    icon="i-lucide-folder-open"
                    variant="ghost"
                    color="neutral"
                    class="toolbar-icon-button"
                    aria-label="Open PDF"
                    @click="handleOpenFileFromUi"
                />
            </UTooltip>

            <template v-if="pdfSrc">
                <!-- Left section: File & view controls -->
                <div class="toolbar-section">
                    <UTooltip text="Save" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-save"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!canSave || isAnySaving || isHistoryBusy"
                            :loading="isSaving"
                            aria-label="Save"
                            @click="handleSave(); closeAllDropdowns()"
                        />
                    </UTooltip>
                    <UTooltip text="Save As…" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-save-all"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!pdfSrc || isAnySaving || isHistoryBusy"
                            :loading="isSavingAs"
                            aria-label="Save As"
                            @click="handleSaveAs(); closeAllDropdowns()"
                        />
                    </UTooltip>
                    <UTooltip text="Export DOCX" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-file-text"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            :disabled="!workingCopyPath || isAnySaving || isHistoryBusy || isExportingDocx"
                            :loading="isExportingDocx"
                            aria-label="Export DOCX"
                            @click="handleExportDocx(); closeAllDropdowns()"
                        />
                    </UTooltip>

                    <div class="toolbar-button-group">
                        <div class="toolbar-group-item">
                            <UTooltip text="Undo" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-undo-2"
                                    variant="ghost"
                                    color="neutral"
                                    class="toolbar-group-button"
                                    :disabled="!canUndo || isHistoryBusy || isAnySaving"
                                    aria-label="Undo"
                                    @click="handleUndo(); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Redo" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-redo-2"
                                    variant="ghost"
                                    color="neutral"
                                    class="toolbar-group-button"
                                    :disabled="!canRedo || isHistoryBusy || isAnySaving"
                                    aria-label="Redo"
                                    @click="handleRedo(); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                    </div>

                    <UTooltip text="Toggle Sidebar" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-panel-left"
                            :variant="showSidebar ? 'soft' : 'ghost'"
                            :color="showSidebar ? 'primary' : 'neutral'"
                            class="toolbar-icon-button"
                            aria-label="Toggle sidebar"
                            @click="showSidebar = !showSidebar; closeAllDropdowns()"
                        />
                    </UTooltip>
                    <UTooltip text="Annotations" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-pen-tool"
                            :variant="isAnnotationPanelOpen ? 'soft' : 'ghost'"
                            :color="isAnnotationPanelOpen ? 'primary' : 'neutral'"
                            class="toolbar-icon-button"
                            aria-label="Annotations"
                            @click="openAnnotations(); closeAllDropdowns()"
                        />
                    </UTooltip>

                    <div v-if="pdfSrc" class="toolbar-button-group">
                        <div class="toolbar-group-item">
                            <UTooltip text="Free Text (T)" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-type"
                                    :variant="annotationTool === 'text' ? 'soft' : 'ghost'"
                                    :color="annotationTool === 'text' ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Free text"
                                    @click="handleAnnotationToolChange(annotationTool === 'text' ? 'none' : 'text'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Highlight (H)" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-highlighter"
                                    :variant="annotationTool === 'highlight' ? 'soft' : 'ghost'"
                                    :color="annotationTool === 'highlight' ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Highlight"
                                    @click="handleAnnotationToolChange(annotationTool === 'highlight' ? 'none' : 'highlight'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Underline (U)" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-underline"
                                    :variant="annotationTool === 'underline' ? 'soft' : 'ghost'"
                                    :color="annotationTool === 'underline' ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Underline"
                                    @click="handleAnnotationToolChange(annotationTool === 'underline' ? 'none' : 'underline'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Strikethrough (S)" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-strikethrough"
                                    :variant="annotationTool === 'strikethrough' ? 'soft' : 'ghost'"
                                    :color="annotationTool === 'strikethrough' ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Strikethrough"
                                    @click="handleAnnotationToolChange(annotationTool === 'strikethrough' ? 'none' : 'strikethrough'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                    </div>

                    <div v-if="pdfSrc" class="toolbar-button-group">
                        <div class="toolbar-group-item">
                            <UTooltip text="Rectangle (R)" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-square"
                                    :variant="annotationTool === 'rectangle' ? 'soft' : 'ghost'"
                                    :color="annotationTool === 'rectangle' ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Rectangle"
                                    @click="handleAnnotationToolChange(annotationTool === 'rectangle' ? 'none' : 'rectangle'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Circle (C)" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-circle"
                                    :variant="annotationTool === 'circle' ? 'soft' : 'ghost'"
                                    :color="annotationTool === 'circle' ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Circle"
                                    @click="handleAnnotationToolChange(annotationTool === 'circle' ? 'none' : 'circle'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Line (L)" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-minus"
                                    :variant="annotationTool === 'line' ? 'soft' : 'ghost'"
                                    :color="annotationTool === 'line' ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Line"
                                    @click="handleAnnotationToolChange(annotationTool === 'line' ? 'none' : 'line'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Arrow (A)" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-arrow-up-right"
                                    :variant="annotationTool === 'arrow' ? 'soft' : 'ghost'"
                                    :color="annotationTool === 'arrow' ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Arrow"
                                    @click="handleAnnotationToolChange(annotationTool === 'arrow' ? 'none' : 'arrow'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                    </div>

                </div>

                <!-- Spacer to push center -->
                <div class="flex-1" />

                <!-- Center section: Document controls -->
                <div class="toolbar-section toolbar-center">
                    <OcrPopup
                        ref="ocrPopupRef"
                        :pdf-document="pdfDocument"
                        :pdf-data="pdfData"
                        :current-page="currentPage"
                        :total-pages="totalPages"
                        :working-copy-path="workingCopyPath"
                        @open="closeOtherDropdowns('ocr')"
                        @ocr-complete="handleOcrComplete"
                    />

                    <div class="toolbar-inline-group">
                        <PdfZoomDropdown
                            ref="zoomDropdownRef"
                            v-model:zoom="zoom"
                            v-model:fit-mode="fitMode"
                            @open="pageDropdownRef?.close()"
                        />
                    </div>

                    <div class="toolbar-button-group">
                        <div class="toolbar-group-item">
                            <UTooltip text="Fit Width" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-move-horizontal"
                                    :variant="isFitWidthActive ? 'soft' : 'ghost'"
                                    :color="isFitWidthActive ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Fit width"
                                    @click="handleFitMode('width'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Fit Height" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-move-vertical"
                                    :variant="isFitHeightActive ? 'soft' : 'ghost'"
                                    :color="isFitHeightActive ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Fit height"
                                    @click="handleFitMode('height'); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Continuous Scroll" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-scroll"
                                    :variant="continuousScroll ? 'soft' : 'ghost'"
                                    :color="continuousScroll ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Continuous scroll"
                                    @click="continuousScroll = !continuousScroll; closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                    </div>

                    <div class="toolbar-inline-group">
                        <PdfPageDropdown
                            ref="pageDropdownRef"
                            v-model="currentPage"
                            :total-pages="totalPages"
                            :page-labels="pageLabels"
                            :page-label-ranges="pageLabelRanges"
                            @go-to-page="handleGoToPage"
                            @update:page-label-ranges="handlePageLabelRangesUpdate"
                            @open="zoomDropdownRef?.close()"
                        />
                    </div>

                    <div class="toolbar-button-group">
                        <div class="toolbar-group-item">
                            <UTooltip text="Hand Tool" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-hand"
                                    :variant="dragMode ? 'soft' : 'ghost'"
                                    :color="dragMode ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Hand tool"
                                    @click="enableDragMode(); closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                        <div class="toolbar-group-item">
                            <UTooltip text="Text Select" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-text-cursor"
                                    :variant="!dragMode ? 'soft' : 'ghost'"
                                    :color="!dragMode ? 'primary' : 'neutral'"
                                    class="toolbar-group-button"
                                    aria-label="Text select"
                                    @click="dragMode = false; closeAllDropdowns()"
                                />
                            </UTooltip>
                        </div>
                    </div>
                </div>

                <!-- Spacer to push right section -->
                <div class="flex-1" />

                <!-- Right section: Window control -->
                <div class="toolbar-section">
                    <UTooltip text="Close File" :delay-duration="1200">
                        <UButton
                            icon="i-lucide-x"
                            variant="ghost"
                            color="neutral"
                            class="toolbar-icon-button"
                            aria-label="Close file"
                            @click="handleCloseFileFromUi"
                        />
                    </UTooltip>
                </div>
            </template>
        </header>

        <!-- Main -->
        <main class="flex-1 overflow-hidden flex">
            <div
                v-if="pdfSrc && showSidebar"
                class="sidebar-wrapper"
                :style="sidebarWrapperStyle"
            >
                <PdfSidebar
                    ref="sidebarRef"
                    v-model:active-tab="sidebarTab"
                    v-model:search-query="searchQuery"
                    :is-open="showSidebar"
                    :pdf-document="pdfDocument"
                    :current-page="currentPage"
                    :total-pages="totalPages"
                    :page-labels="pageLabels"
                    :search-results="results"
                    :current-result-index="currentResultIndex"
                    :total-matches="totalMatches"
                    :is-searching="isSearching"
                    :search-progress="searchProgress"
                    :is-truncated="isTruncated"
                    :min-query-length="minQueryLength"
                    :width="sidebarWidth"
                    :annotation-tool="annotationTool"
                    :annotation-keep-active="annotationKeepActive"
                    :annotation-settings="annotationSettings"
                    :annotation-comments="annotationComments"
                    :annotation-active-comment-stable-key="annotationActiveCommentStableKey"
                    :annotation-placing-page-note="annotationPlacingPageNote"
                    :bookmark-edit-mode="bookmarkEditMode"
                    @search="handleSearch"
                    @next="handleSearchNext"
                    @previous="handleSearchPrevious"
                    @go-to-page="handleGoToPage"
                    @go-to-result="handleGoToResult"
                    @update:annotation-tool="handleAnnotationToolChange"
                    @update:annotation-keep-active="annotationKeepActive = $event"
                    @annotation-setting="handleAnnotationSettingChange"
                    @annotation-comment-selection="handleCommentSelection"
                    @annotation-start-place-note="handleStartPlaceNote"
                    @annotation-focus-comment="handleAnnotationFocusComment"
                    @annotation-open-note="handleOpenAnnotationNote"
                    @annotation-copy-comment="handleCopyAnnotationComment"
                    @annotation-delete-comment="handleDeleteAnnotationComment"
                    @bookmarks-change="handleBookmarksChange"
                    @update:bookmark-edit-mode="bookmarkEditMode = $event"
                />
                <div
                    class="sidebar-resizer"
                    :class="{ 'is-active': isResizingSidebar }"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize sidebar"
                    @pointerdown.prevent="startSidebarResize"
                />
            </div>
            <div class="flex-1 overflow-hidden">
                <PdfViewer
                    v-if="pdfSrc"
                    ref="pdfViewerRef"
                    :src="pdfSrc"
                    :zoom="zoom"
                    :fit-mode="fitMode"
                    :drag-mode="dragMode"
                    :continuous-scroll="continuousScroll"
                    :annotation-tool="annotationTool"
                    :annotation-cursor-mode="annotationCursorMode"
                    :annotation-keep-active="annotationKeepActive"
                    :annotation-settings="annotationSettings"
                    :search-page-matches="pageMatches"
                    :current-search-match="currentResult"
                    :working-copy-path="workingCopyPath"
                    @update:current-page="currentPage = $event"
                    @update:total-pages="totalPages = $event"
                    @update:document="pdfDocument = $event"
                    @loading="isLoading = $event"
                    @annotation-state="handleAnnotationState"
                    @annotation-modified="handleAnnotationModified"
                    @annotation-comments="annotationComments = $event"
                    @annotation-open-note="handleOpenAnnotationNote"
                    @annotation-comment-click="handleAnnotationCommentClick"
                    @annotation-context-menu="handleViewerAnnotationContextMenu"
                    @annotation-tool-auto-reset="handleAnnotationToolAutoReset"
                    @annotation-tool-cancel="handleAnnotationToolCancel"
                    @annotation-note-placement-change="annotationPlacingPageNote = $event"
                    @shape-context-menu="handleShapeContextMenu"
                />
                <div
                    v-else
                    class="empty-state"
                >
                    <!-- Recent Files (primary focus for returning users) -->
                    <div
                        v-if="recentFiles.length > 0"
                        class="recent-files"
                    >
                        <div class="recent-files-header">
                            <h3 class="text-sm font-medium text-neutral-600 dark:text-neutral-400">
                                Recent Files
                            </h3>
                            <UTooltip text="Clear Recent Files" :delay-duration="1200">
                                <UButton
                                    icon="i-lucide-trash-2"
                                    variant="ghost"
                                    size="xs"
                                    color="neutral"
                                    class="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                                    aria-label="Clear recent files"
                                    @click="clearRecentFiles"
                                />
                            </UTooltip>
                        </div>
                        <ul class="recent-files-list">
                            <li
                                v-for="file in recentFiles"
                                :key="file.originalPath"
                                class="recent-file-item"
                                @click="openRecentFile(file)"
                            >
                                <UIcon
                                    name="i-lucide-file-text"
                                    class="size-5 text-neutral-400 flex-shrink-0"
                                />
                                <div class="recent-file-info">
                                    <span class="recent-file-name">{{ file.fileName }}</span>
                                    <span class="recent-file-path">{{ getParentFolder(file.originalPath) }}</span>
                                </div>
                                <span class="recent-file-time">{{ formatRelativeTime(file.timestamp) }}</span>
                                <UTooltip text="Remove from Recent" :delay-duration="1200">
                                    <UButton
                                        icon="i-lucide-x"
                                        size="xs"
                                        variant="ghost"
                                        color="neutral"
                                        class="recent-file-remove"
                                        aria-label="Remove recent file"
                                        @click.stop="removeRecentFile(file)"
                                    />
                                </UTooltip>
                            </li>
                        </ul>
                    </div>

                    <!-- Open file action (clickable) -->
                    <p class="empty-state-hint text-sm text-neutral-500 dark:text-neutral-400">
                        {{ recentFiles.length > 0 ? 'Or open another file...' : 'Open a PDF file' }}
                    </p>
                    <UTooltip text="Open PDF" :delay-duration="1200">
                        <button
                            class="open-file-action group"
                            aria-label="Open PDF"
                            @click="handleOpenFileFromUi"
                        >
                            <UIcon
                                name="i-lucide-folder-open"
                                class="size-8 text-neutral-400 group-hover:text-primary-500 transition-colors"
                            />
                        </button>
                    </UTooltip>
                </div>
            </div>
        </main>
        <footer class="status-bar">
            <div class="status-bar-path" :title="statusFilePath">
                {{ statusFilePath }}
            </div>
            <div class="status-bar-metrics">
                <span class="status-bar-item">{{ statusFileSizeLabel }}</span>
                <span class="status-bar-item">{{ statusZoomLabel }}</span>
                <UTooltip :text="statusSaveDotTooltip" :delay-duration="800">
                    <button
                        type="button"
                        class="status-save-dot-button"
                        :class="[statusSaveDotClass, { 'is-actionable': statusSaveDotCanSave }]"
                        :disabled="!statusSaveDotCanSave"
                        :aria-label="statusSaveDotAriaLabel"
                        @click="handleStatusSaveClick"
                    >
                        <span class="status-save-dot" />
                    </button>
                </UTooltip>
            </div>
        </footer>
        <PdfAnnotationNoteWindow
            v-for="note in sortedAnnotationNoteWindows"
            :key="note.comment.stableKey"
            :comment="note.comment"
            :text="note.text"
            :saving="note.saving"
            :error="note.error"
            :position="annotationNotePositions[note.comment.stableKey] ?? null"
            :z-index="90 + note.order"
            @update:text="updateAnnotationNoteText(note.comment.stableKey, $event)"
            @update:position="updateAnnotationNotePosition(note.comment.stableKey, $event)"
            @close="closeAnnotationNote(note.comment.stableKey)"
            @delete="handleDeleteAnnotationComment(note.comment)"
            @focus="bringAnnotationNoteToFront(note.comment.stableKey)"
        />
        <div
            v-if="annotationContextMenu.visible"
            class="annotation-context-menu"
            :style="annotationContextMenuStyle"
            @click.stop
        >
            <template v-if="annotationContextMenu.comment">
                <p class="annotation-context-menu__section-title">
                    <span
                        v-if="annotationContextMenu.comment.color"
                        class="annotation-context-menu__color-swatch"
                        :style="{ background: annotationContextMenu.comment.color }"
                    />
                    {{ contextMenuAnnotationLabel }}
                </p>
                <button type="button" class="annotation-context-menu__action" @click="openContextMenuNote">
                    Open Pop-up Note
                </button>
                <button
                    type="button"
                    class="annotation-context-menu__action"
                    :disabled="!annotationContextMenuCanCopy"
                    @click="copyContextMenuNoteText"
                >
                    Copy Text to Clipboard
                </button>
                <button
                    type="button"
                    class="annotation-context-menu__action annotation-context-menu__action--danger"
                    @click="deleteContextMenuComment"
                >
                    {{ contextMenuDeleteActionLabel }}
                </button>
                <div class="annotation-context-menu__divider" />
            </template>

            <template v-if="annotationContextMenu.hasSelection">
                <p class="annotation-context-menu__section-title">
                    Markup Selection
                </p>
                <button
                    type="button"
                    class="annotation-context-menu__action"
                    @click="createContextMenuMarkup('highlight')"
                >
                    Highlight
                </button>
                <button
                    type="button"
                    class="annotation-context-menu__action"
                    @click="createContextMenuMarkup('underline')"
                >
                    Underline
                </button>
                <button
                    type="button"
                    class="annotation-context-menu__action"
                    @click="createContextMenuMarkup('strikethrough')"
                >
                    Strikethrough
                </button>
                <div class="annotation-context-menu__divider" />
            </template>

            <p class="annotation-context-menu__section-title">
                Add Note
            </p>
            <button
                type="button"
                class="annotation-context-menu__action"
                :disabled="!annotationContextMenuCanCreateFree"
                @click="createContextMenuFreeNote"
            >
                Add Note Here
            </button>
            <button
                v-if="annotationContextMenu.hasSelection"
                type="button"
                class="annotation-context-menu__action"
                @click="createContextMenuSelectionNote"
            >
                Add Note to Selection
            </button>
        </div>

        <PdfAnnotationProperties
            :shape="selectedShapeForProperties"
            :x="shapePropertiesPopover.x"
            :y="shapePropertiesPopover.y"
            @update="handleShapePropertyUpdate"
            @close="closeShapeProperties"
        />
    </div>
</template>

<script setup lang="ts">
import {
    onMounted,
    onUnmounted,
    nextTick,
    ref,
    shallowRef,
    computed,
    watch,
} from 'vue';
import { useDebounceFn } from '@vueuse/core';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TFitMode } from '@app/types/shared';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdf-page-labels';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';


type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

interface IPdfViewerExpose {
    scrollToPage: (page: number) => void;
    saveDocument: () => Promise<Uint8Array | null>;
    highlightSelection: () => Promise<boolean>;
    commentSelection: () => Promise<boolean>;
    commentAtPoint: (
        pageNumber: number,
        pageX: number,
        pageY: number,
        options?: { preferTextAnchor?: boolean },
    ) => Promise<boolean>;
    startCommentPlacement: () => void;
    cancelCommentPlacement: () => void;
    undoAnnotation: () => void;
    redoAnnotation: () => void;
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype>;
    getAllShapes: () => IShapeAnnotation[];
    loadShapes: (shapes: IShapeAnnotation[]) => void;
    clearShapes: () => void;
    deleteSelectedShape: () => void;
    hasShapes: { value: boolean };
    selectedShapeId: { value: string | null };
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
    getSelectedShape: () => IShapeAnnotation | null;
    applyStampImage: (file: File) => void;
}

interface IOcrPopupExpose {
    close: () => void;
    open: () => void;
    exportDocx: () => Promise<boolean>;
    isExporting: { value: boolean };
}

interface IAnnotationNotePosition {
    x: number;
    y: number;
}

interface IAnnotationNoteWindowState {
    comment: IAnnotationCommentSummary;
    text: string;
    lastSavedText: string;
    saving: boolean;
    error: string | null;
    order: number;
    saveMode: 'auto' | 'embedded';
}

const ANNOTATION_KEEP_ACTIVE_STORAGE_KEY = 'pdf.annotations.keepActive';

const {
    pdfSrc,
    pdfData,
    workingCopyPath,
    isDirty,
    error: pdfError,
    isElectron,
    openFile,
    openFileDirect,
    loadPdfFromData,
    closeFile,
    saveFile,
    saveWorkingCopy,
    saveWorkingCopyAs,
    markDirty,
    canUndo: canUndoFile,
    canRedo: canRedoFile,
    undo,
    redo,
} = usePdfFile();

const {
    recentFiles,
    loadRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();

async function openRecentFile(file: { originalPath: string }) {
    await handleOpenFileDirectWithPersist(file.originalPath);
}

function wait(ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function waitUntilIdle() {
    let attempts = 0;
    while (
        (isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value)
        && attempts < 120
    ) {
        await wait(25);
        attempts += 1;
    }
}

async function ensureCurrentDocumentPersistedBeforeSwitch() {
    if (!pdfSrc.value) {
        return true;
    }

    await waitUntilIdle();
    if (isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value) {
        return false;
    }

    if (annotationNoteWindows.value.length > 0) {
        const savedAllNotes = await persistAllAnnotationNotes(true);
        if (!savedAllNotes) {
            return false;
        }
    }

    const hasPendingChanges = (
        annotationDirty.value
        || isDirty.value
        || hasAnnotationChanges()
        || pageLabelsDirty.value
        || bookmarksDirty.value
    );
    if (!hasPendingChanges) {
        return true;
    }

    await handleSave();

    return !(
        annotationDirty.value
        || isDirty.value
        || hasAnnotationChanges()
        || pageLabelsDirty.value
        || bookmarksDirty.value
    );
}

async function handleOpenFileFromUi() {
    const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
    if (!canProceed) {
        return;
    }
    await openFile();
    closeAllDropdowns();
}

async function handleOpenFileDirectWithPersist(path: string) {
    const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
    if (!canProceed) {
        return;
    }
    await openFileDirect(path);
    closeAllDropdowns();
}

async function handleCloseFileFromUi() {
    const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
    if (!canProceed) {
        return;
    }
    await closeFile();
    closeAllDropdowns();
}

function formatRelativeTime(timestamp: number) {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return days === 1 ? 'Yesterday' : `${days} days ago`;
    }
    if (hours > 0) {
        return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    }
    if (minutes > 0) {
        return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    }
    return 'Just now';
}

function getParentFolder(filePath: string) {
    const parts = filePath.split('/');
    parts.pop(); // Remove filename
    // Show last 2 folder segments for context, or full path if shorter
    const folderParts = parts.slice(-2);
    return folderParts.join('/');
}

// Expose for testing
if (typeof window !== 'undefined') {
    window.__openFileDirect = handleOpenFileDirectWithPersist;
}

const menuCleanups: Array<() => void> = [];

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
    return Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'));
}

function handleGlobalShortcut(event: KeyboardEvent) {
    if (event.key === 'Escape') {
        closeAnnotationContextMenu();
        closeShapeProperties();
        pdfViewerRef.value?.cancelCommentPlacement();
        annotationPlacingPageNote.value = false;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && pdfSrc.value) {
        event.preventDefault();
        openSearch();
        nextTick(() => sidebarRef.value?.focusSearch());
        return;
    }

    if (!pdfSrc.value) {
        return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
        return;
    }

    const key = event.key.toLowerCase();
    switch (key) {
        case 'v':
            handleAnnotationToolChange('none');
            return;
        case 'h':
            openAnnotations();
            handleAnnotationToolChange('highlight');
            return;
        case 'u':
            openAnnotations();
            handleAnnotationToolChange('underline');
            return;
        case 's':
            openAnnotations();
            handleAnnotationToolChange('strikethrough');
            return;
        case 'i':
            openAnnotations();
            handleAnnotationToolChange('draw');
            return;
        case 't':
            openAnnotations();
            handleAnnotationToolChange('text');
            return;
        case 'r':
            openAnnotations();
            handleAnnotationToolChange('rectangle');
            return;
        case 'c':
            openAnnotations();
            handleAnnotationToolChange('circle');
            return;
        case 'l':
            openAnnotations();
            handleAnnotationToolChange('line');
            return;
        case 'a':
            openAnnotations();
            handleAnnotationToolChange('arrow');
            return;
        case 'escape':
            handleAnnotationToolChange('none');
            return;
        case 'delete':
        case 'backspace':
            pdfViewerRef.value?.deleteSelectedShape();
            return;
        default:
            return;
    }
}

function handleGlobalPointerDown(event: PointerEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;

    if (shapePropertiesPopover.value.visible) {
        if (!target?.closest('.annotation-properties')) {
            closeShapeProperties();
        }
    }

    if (annotationContextMenu.value.visible) {
        if (!target?.closest('.annotation-context-menu')) {
            closeAnnotationContextMenu();
        }
    }
}

onMounted(() => {
    console.log('Electron API available:', isElectron.value);

    if (window.electronAPI) {
        menuCleanups.push(
            window.electronAPI.onMenuOpenPdf(() => {
                void handleOpenFileFromUi();
            }),
            window.electronAPI.onMenuSave(() => handleSave()),
            window.electronAPI.onMenuSaveAs(() => handleSaveAs()),
            window.electronAPI.onMenuExportDocx(() => handleExportDocx()),
            window.electronAPI.onMenuUndo(() => handleUndo()),
            window.electronAPI.onMenuRedo(() => handleRedo()),
            window.electronAPI.onMenuZoomIn(() => { zoom.value = Math.min(zoom.value + 0.25, 5); }),
            window.electronAPI.onMenuZoomOut(() => { zoom.value = Math.max(zoom.value - 0.25, 0.25); }),
            window.electronAPI.onMenuActualSize(() => { zoom.value = 1; }),
            window.electronAPI.onMenuFitWidth(() => { handleFitMode('width'); }),
            window.electronAPI.onMenuFitHeight(() => { handleFitMode('height'); }),
            window.electronAPI.onMenuOpenRecentFile((path: string) => {
                void handleOpenFileDirectWithPersist(path);
            }),
            window.electronAPI.onMenuClearRecentFiles(() => {
                clearRecentFiles();
                loadRecentFiles();
            }),
        );

        loadRecentFiles();
    }

    const storedKeepActive = window.localStorage.getItem(ANNOTATION_KEEP_ACTIVE_STORAGE_KEY);
    if (storedKeepActive !== null) {
        annotationKeepActive.value = storedKeepActive === '1';
    }

    window.addEventListener('keydown', handleGlobalShortcut);
    window.addEventListener('pointerdown', handleGlobalPointerDown);
});

onUnmounted(() => {
    menuCleanups.forEach((cleanup) => cleanup());
    cleanupSidebarResizeListeners();
    window.removeEventListener('keydown', handleGlobalShortcut);
    window.removeEventListener('pointerdown', handleGlobalPointerDown);
});

watch(pdfError, (err) => {
    if (err) {
        console.error('PDF Error:', err);
    }
});

const {
    searchQuery,
    results,
    pageMatches,
    currentResultIndex,
    currentResult,
    isSearching,
    totalMatches,
    search,
    goToResult,
    setResultIndex,
    clearSearch,
    searchProgress,
    resetSearchCache,
    isTruncated,
    minQueryLength,
} = usePdfSearch();

const { clearCache: clearOcrCache } = useOcrTextContent();

const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
const zoomDropdownRef = ref<{ close: () => void } | null>(null);
const pageDropdownRef = ref<{ close: () => void } | null>(null);
const ocrPopupRef = ref<IOcrPopupExpose | null>(null);
const sidebarRef = ref<{ focusSearch: () => void | Promise<void> } | null>(null);

function closeAllDropdowns() {
    zoomDropdownRef.value?.close();
    pageDropdownRef.value?.close();
    ocrPopupRef.value?.close();
}

function closeOtherDropdowns(except: 'zoom' | 'page' | 'ocr') {
    if (except !== 'zoom') zoomDropdownRef.value?.close();
    if (except !== 'page') pageDropdownRef.value?.close();
    if (except !== 'ocr') ocrPopupRef.value?.close();
}

const zoom = ref(1);
const fitMode = ref<TFitMode>('width');
const currentPage = ref(1);
const totalPages = ref(0);
const pageLabels = ref<string[] | null>(null);
const pageLabelRanges = ref<IPdfPageLabelRange[]>([]);
const pageLabelsDirty = ref(false);
const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
const bookmarksDirty = ref(false);
const isLoading = ref(false);
const dragMode = ref(true);
const continuousScroll = ref(true);
const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
const annotationTool = ref<TAnnotationTool>('none');
const annotationKeepActive = ref(true);
const annotationPlacingPageNote = ref(false);
const annotationSettings = ref<IAnnotationSettings>({
    highlightColor: '#ffd400',
    highlightOpacity: 0.35,
    highlightThickness: 12,
    highlightFree: true,
    highlightShowAll: true,
    underlineColor: '#2563eb',
    underlineOpacity: 0.8,
    strikethroughColor: '#dc2626',
    strikethroughOpacity: 0.7,
    squigglyColor: '#16a34a',
    squigglyOpacity: 0.7,
    inkColor: '#e11d48',
    inkOpacity: 0.9,
    inkThickness: 2,
    textColor: '#111827',
    textSize: 12,
    shapeColor: '#2563eb',
    shapeFillColor: 'transparent',
    shapeOpacity: 1,
    shapeStrokeWidth: 2,
});
const annotationComments = ref<IAnnotationCommentSummary[]>([]);
const annotationActiveCommentStableKey = ref<string | null>(null);
const annotationNoteWindows = ref<IAnnotationNoteWindowState[]>([]);
const annotationNotePositions = ref<Record<string, IAnnotationNotePosition>>({});
const annotationNoteDebouncers = new Map<string, ReturnType<typeof useDebounceFn>>();
let annotationNoteOrderCounter = 0;
const annotationContextMenu = ref<{
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
    hasSelection: boolean;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}>({
    visible: false,
    x: 0,
    y: 0,
    comment: null,
    hasSelection: false,
    pageNumber: null,
    pageX: null,
    pageY: null,
});
const annotationEditorState = ref<IAnnotationEditorState>({
    isEditing: false,
    isEmpty: true,
    hasSomethingToUndo: false,
    hasSomethingToRedo: false,
    hasSelectedEditor: false,
});
const showSidebar = ref(false);
const sidebarTab = ref<TPdfSidebarTab>('thumbnails');
const bookmarkEditMode = ref(false);
const isSaving = ref(false);
const isSavingAs = ref(false);
const isHistoryBusy = ref(false);
const annotationRevision = ref(0);
const annotationSavedRevision = ref(0);
const isAnySaving = computed(() => isSaving.value || isSavingAs.value);
const isAnyAnnotationNoteSaving = computed(() => annotationNoteWindows.value.some(note => note.saving));
const isExportingDocx = computed(() => ocrPopupRef.value?.isExporting?.value ?? false);
const isFitWidthActive = computed(() => fitMode.value === 'width' && Math.abs(zoom.value - 1) < 0.01);
const isFitHeightActive = computed(() => fitMode.value === 'height' && Math.abs(zoom.value - 1) < 0.01);
const isAnnotationUndoContext = computed(() =>
    annotationTool.value !== 'none'
    || annotationEditorState.value.hasSomethingToUndo
    || annotationEditorState.value.hasSomethingToRedo,
);
const isAnnotationPanelOpen = computed(() => showSidebar.value && sidebarTab.value === 'annotations');
const annotationCursorMode = computed(() => isAnnotationPanelOpen.value && !dragMode.value);
const canUndo = computed(() => (
    isAnnotationUndoContext.value
        ? annotationEditorState.value.hasSomethingToUndo
        : canUndoFile.value
));
const canRedo = computed(() => (
    isAnnotationUndoContext.value
        ? annotationEditorState.value.hasSomethingToRedo
        : canRedoFile.value
));
const annotationDirty = computed(() => annotationRevision.value !== annotationSavedRevision.value);
const canSave = computed(() => isDirty.value || annotationDirty.value || pageLabelsDirty.value || bookmarksDirty.value);
const annotationContextMenuStyle = computed(() => ({
    left: `${annotationContextMenu.value.x}px`,
    top: `${annotationContextMenu.value.y}px`,
}));
const annotationContextMenuCanCopy = computed(() => {
    const text = annotationContextMenu.value.comment?.text?.trim();
    return Boolean(text);
});
const annotationContextMenuCanCreateFree = computed(() => (
    Number.isFinite(annotationContextMenu.value.pageNumber)
    && Number.isFinite(annotationContextMenu.value.pageX)
    && Number.isFinite(annotationContextMenu.value.pageY)
));
const contextMenuAnnotationLabel = computed(() => {
    const comment = annotationContextMenu.value.comment;
    if (!comment) {
        return 'Selected Annotation';
    }
    return comment.kindLabel ?? comment.subtype ?? 'Annotation';
});
const contextMenuDeleteActionLabel = computed(() => {
    const comment = annotationContextMenu.value.comment;
    if (!comment) {
        return 'Delete';
    }

    const subtype = (comment.subtype ?? '').trim().toLowerCase();
    const kind = comment.kindLabel?.trim() ?? '';
    const isMarkup = (
        subtype === 'highlight'
        || subtype === 'underline'
        || subtype === 'strikeout'
        || subtype === 'squiggly'
    );
    const hasNoteText = comment.text.trim().length > 0;
    if (!hasNoteText && isMarkup) {
        if (kind.length > 0) {
            return `Delete ${kind}`;
        }
        return 'Delete Markup';
    }

    const isExplicitNote = comment.hasNote === true || subtype === 'popup' || subtype === 'text';
    if (isExplicitNote) {
        return 'Delete Note';
    }
    return 'Delete Annotation';
});
const shapePropertiesPopover = ref<{
    visible: boolean;
    x: number;
    y: number;
}>({
    visible: false,
    x: 0,
    y: 0,
});

const selectedShapeForProperties = computed(() =>
    shapePropertiesPopover.value.visible
        ? pdfViewerRef.value?.getSelectedShape() ?? null
        : null,
);

const sortedAnnotationNoteWindows = computed(() =>
    [...annotationNoteWindows.value].sort((left, right) => left.order - right.order));
const statusFilePath = computed(() => workingCopyPath.value ?? 'No file open');
const statusFileSizeBytes = computed(() => {
    if (pdfData.value) {
        return pdfData.value.byteLength;
    }
    if (pdfSrc.value && typeof pdfSrc.value === 'object' && 'kind' in pdfSrc.value && pdfSrc.value.kind === 'path') {
        return pdfSrc.value.size;
    }
    return null;
});
const statusFileSizeLabel = computed(() => {
    if (statusFileSizeBytes.value === null) {
        return 'Size: -';
    }
    return `Size: ${formatBytes(statusFileSizeBytes.value)}`;
});
const statusZoomLabel = computed(() => `Zoom: ${Math.round(zoom.value * 100)}%`);
const statusSaveDotState = computed(() => {
    if (!pdfSrc.value) {
        return 'idle';
    }
    if (isAnySaving.value) {
        return 'saving';
    }
    if (canSave.value) {
        return 'dirty';
    }
    return 'clean';
});
const statusSaveDotClass = computed(() => `is-${statusSaveDotState.value}`);
const statusSaveDotCanSave = computed(() => (
    !!pdfSrc.value
    && canSave.value
    && !isAnySaving.value
    && !isHistoryBusy.value
));
const statusSaveDotTooltip = computed(() => {
    if (statusSaveDotState.value === 'idle') {
        return 'No file open';
    }
    if (statusSaveDotState.value === 'saving') {
        return 'Saving...';
    }
    if (statusSaveDotState.value === 'dirty') {
        return 'Unsaved changes - click to save';
    }
    return 'All changes saved';
});
const statusSaveDotAriaLabel = computed(() => {
    if (statusSaveDotState.value === 'dirty') {
        return 'Save changes';
    }
    if (statusSaveDotState.value === 'saving') {
        return 'Saving changes';
    }
    if (statusSaveDotState.value === 'clean') {
        return 'All changes saved';
    }
    return 'No file open';
});

async function handleStatusSaveClick() {
    if (!statusSaveDotCanSave.value) {
        return;
    }
    await handleSave();
}

function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return '-';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = [
        'KB',
        'MB',
        'GB',
        'TB',
    ];
    let value = bytes;
    let unitIndex = -1;

    do {
        value /= 1024;
        unitIndex += 1;
    } while (value >= 1024 && unitIndex < units.length - 1);

    const digits = value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

watch(annotationKeepActive, (value) => {
    if (typeof window === 'undefined') {
        return;
    }
    window.localStorage.setItem(ANNOTATION_KEEP_ACTIVE_STORAGE_KEY, value ? '1' : '0');
});

const SIDEBAR_DEFAULT_WIDTH = 272;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_COLLAPSE_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_RESIZER_WIDTH = 8;

const sidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH);
const lastOpenSidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH);
const isResizingSidebar = ref(false);

let resizeStartX = 0;
let resizeStartWidth = 0;

const sidebarWrapperStyle = computed(() => ({
    width: `${sidebarWidth.value + SIDEBAR_RESIZER_WIDTH}px`,
    minWidth: `${sidebarWidth.value + SIDEBAR_RESIZER_WIDTH}px`,
}));

watch(showSidebar, (isOpen) => {
    if (isOpen) {
        const width = Math.min(
            Math.max(lastOpenSidebarWidth.value, SIDEBAR_DEFAULT_WIDTH),
            SIDEBAR_MAX_WIDTH,
        );
        sidebarWidth.value = width;
        lastOpenSidebarWidth.value = width;
        return;
    }

    stopSidebarResize();
});

watch(
    () => [
        showSidebar.value,
        sidebarTab.value,
    ] as const,
    ([
        isOpen,
        tab,
    ]) => {
        if (!isOpen || tab !== 'bookmarks') {
            bookmarkEditMode.value = false;
        }
    },
);

watch(dragMode, (enabled) => {
    if (enabled) {
        window.getSelection()?.removeAllRanges();
        if (annotationTool.value !== 'none') {
            annotationTool.value = 'none';
        }
        pdfViewerRef.value?.cancelCommentPlacement();
        annotationPlacingPageNote.value = false;
    }
});

function enableDragMode() {
    dragMode.value = true;
    pdfViewerRef.value?.cancelCommentPlacement();
    annotationPlacingPageNote.value = false;
    if (annotationTool.value !== 'none') {
        annotationTool.value = 'none';
    }
}

function handleGoToPage(page: number) {
    pdfViewerRef.value?.scrollToPage(page);
}

async function syncPageLabelsFromDocument(doc: PDFDocumentProxy | null) {
    if (!doc) {
        pageLabels.value = null;
        pageLabelRanges.value = [];
        pageLabelsDirty.value = false;
        return;
    }

    let labels: string[] | null = null;
    try {
        const raw = await doc.getPageLabels();
        labels = raw && raw.length === doc.numPages ? raw : null;
    } catch {
        labels = null;
    }

    pageLabels.value = labels;
    pageLabelRanges.value = derivePageLabelRangesFromLabels(labels, doc.numPages);
    pageLabelsDirty.value = false;
}

function markPageLabelsSaved() {
    pageLabelsDirty.value = false;
}

function markBookmarksSaved() {
    bookmarksDirty.value = false;
}

function handleBookmarksChange(payload: {
    bookmarks: IPdfBookmarkEntry[];
    dirty: boolean;
}) {
    bookmarkItems.value = payload.bookmarks;

    if (payload.dirty) {
        if (!bookmarksDirty.value) {
            markDirty();
        }
        bookmarksDirty.value = true;
        return;
    }

    bookmarksDirty.value = false;
}

function handlePageLabelRangesUpdate(ranges: IPdfPageLabelRange[]) {
    if (totalPages.value <= 0) {
        return;
    }

    const normalized = normalizePageLabelRanges(ranges, totalPages.value);
    const currentNormalized = normalizePageLabelRanges(pageLabelRanges.value, totalPages.value);
    const unchanged = JSON.stringify(normalized) === JSON.stringify(currentNormalized);
    if (unchanged) {
        return;
    }
    pageLabelRanges.value = normalized;
    pageLabels.value = buildPageLabelsFromRanges(totalPages.value, normalized);
    pageLabelsDirty.value = true;
    markDirty();
}

watch(
    pdfDocument,
    (doc) => {
        void syncPageLabelsFromDocument(doc);
    },
    { immediate: true },
);

function waitForPdfReload(pageToRestore: number) {
    return new Promise<void>((resolve) => {
        const unwatch = watch(pdfDocument, (doc) => {
            if (doc) {
                unwatch();
                resetSearchCache();
                void nextTick(() => {
                    pdfViewerRef.value?.scrollToPage(pageToRestore);
                    resolve();
                });
            }
        });
    });
}

async function handleOcrComplete(ocrPdfData: Uint8Array) {
    // Remember current page before reload
    const pageToRestore = currentPage.value;

    // M4.1: Clear OCR manifest cache so new OCR data is loaded
    if (workingCopyPath.value) {
        clearOcrCache(workingCopyPath.value);
    }

    const restorePromise = waitForPdfReload(pageToRestore);

    // Persist OCR changes to the working copy so subsequent operations (OCR/search)
    // don't accidentally operate on an older on-disk version.
    await loadPdfFromData(ocrPdfData, {
        pushHistory: true,
        persistWorkingCopy: !!workingCopyPath.value,
    });

    await restorePromise;
}

async function handleExportDocx() {
    if (!ocrPopupRef.value) {
        return;
    }
    const result = await ocrPopupRef.value.exportDocx();
    if (result === false) {
        ocrPopupRef.value.open();
    }
}

function cleanupSidebarResizeListeners() {
    window.removeEventListener('pointermove', handleSidebarResize);
    window.removeEventListener('pointerup', stopSidebarResize);
    window.removeEventListener('pointercancel', stopSidebarResize);
}

function startSidebarResize(event: PointerEvent) {
    if (!showSidebar.value) {
        return;
    }

    event.preventDefault();

    isResizingSidebar.value = true;
    resizeStartX = event.clientX;
    resizeStartWidth = sidebarWidth.value;

    window.addEventListener('pointermove', handleSidebarResize);
    window.addEventListener('pointerup', stopSidebarResize);
    window.addEventListener('pointercancel', stopSidebarResize);
}

function handleSidebarResize(event: PointerEvent) {
    const deltaX = event.clientX - resizeStartX;
    const nextWidth = resizeStartWidth + deltaX;

    if (nextWidth < SIDEBAR_COLLAPSE_WIDTH) {
        isResizingSidebar.value = false;
        cleanupSidebarResizeListeners();
        lastOpenSidebarWidth.value = SIDEBAR_MIN_WIDTH;
        sidebarWidth.value = SIDEBAR_MIN_WIDTH;
        showSidebar.value = false;
        return;
    }

    const clampedWidth = Math.min(
        Math.max(nextWidth, SIDEBAR_MIN_WIDTH),
        SIDEBAR_MAX_WIDTH,
    );

    sidebarWidth.value = clampedWidth;
    lastOpenSidebarWidth.value = clampedWidth;
}

function stopSidebarResize() {
    if (!isResizingSidebar.value) {
        return;
    }

    isResizingSidebar.value = false;
    cleanupSidebarResizeListeners();
}

function openSearch() {
    showSidebar.value = true;
    sidebarTab.value = 'search';
}

function openAnnotations() {
    if (showSidebar.value && sidebarTab.value === 'annotations') {
        showSidebar.value = false;
        return;
    }
    showSidebar.value = true;
    sidebarTab.value = 'annotations';
    dragMode.value = false;
}

function closeSearch() {
    clearSearch();
    sidebarTab.value = 'thumbnails';
}

function handleAnnotationToolChange(tool: TAnnotationTool) {
    annotationTool.value = tool;
    // Sidebar tools should always return to text-selection interaction,
    // while hand-pan remains an explicit, separate toolbar mode.
    dragMode.value = false;
    pdfViewerRef.value?.cancelCommentPlacement();
    annotationPlacingPageNote.value = false;
    closeAnnotationContextMenu();
}

function handleAnnotationToolAutoReset() {
    if (annotationKeepActive.value) {
        return;
    }
    annotationTool.value = 'none';
    annotationPlacingPageNote.value = false;
    closeAnnotationContextMenu();
}

function handleAnnotationToolCancel() {
    annotationTool.value = 'none';
    annotationPlacingPageNote.value = false;
    closeAnnotationContextMenu();
}

function handleAnnotationSettingChange(payload: {
    key: keyof IAnnotationSettings;
    value: IAnnotationSettings[keyof IAnnotationSettings] 
}) {
    annotationSettings.value = {
        ...annotationSettings.value,
        [payload.key]: payload.value,
    };

    const selectedShapeId = pdfViewerRef.value?.selectedShapeId?.value;
    if (!selectedShapeId) {
        return;
    }

    if (payload.key === 'shapeColor') {
        pdfViewerRef.value?.updateShape(selectedShapeId, { color: String(payload.value) });
        return;
    }

    if (payload.key === 'shapeStrokeWidth') {
        pdfViewerRef.value?.updateShape(selectedShapeId, { strokeWidth: Number(payload.value) });
        return;
    }

    if (payload.key === 'shapeOpacity') {
        pdfViewerRef.value?.updateShape(selectedShapeId, { opacity: Number(payload.value) });
        return;
    }

    if (payload.key === 'shapeFillColor') {
        const fill = String(payload.value);
        pdfViewerRef.value?.updateShape(selectedShapeId, {fillColor: fill === 'transparent' ? undefined : fill});
    }
}

function handleAnnotationState(state: IAnnotationEditorState) {
    const hadUndo = annotationEditorState.value.hasSomethingToUndo;
    annotationEditorState.value = {
        ...annotationEditorState.value,
        ...state,
    };
    if (!hadUndo && annotationEditorState.value.hasSomethingToUndo) {
        markAnnotationDirty();
    }
}

function handleAnnotationModified() {
    markAnnotationDirty();
}

function markAnnotationDirty() {
    annotationRevision.value += 1;
    markDirty();
}

function markAnnotationSaved() {
    annotationSavedRevision.value = annotationRevision.value;
}

function resetAnnotationTracking() {
    annotationRevision.value = 0;
    annotationSavedRevision.value = 0;
}

async function handleCommentSelection() {
    if (!pdfViewerRef.value) {
        return;
    }
    await pdfViewerRef.value.commentSelection();
}

function handleStartPlaceNote() {
    if (!pdfViewerRef.value) {
        return;
    }

    if (annotationPlacingPageNote.value) {
        pdfViewerRef.value.cancelCommentPlacement();
        annotationPlacingPageNote.value = false;
        return;
    }

    showSidebar.value = true;
    sidebarTab.value = 'annotations';
    dragMode.value = false;
    annotationTool.value = 'none';
    pdfViewerRef.value.startCommentPlacement();
    annotationPlacingPageNote.value = true;
}

async function handleAnnotationFocusComment(comment: IAnnotationCommentSummary) {
    if (!pdfViewerRef.value) {
        return;
    }
    annotationActiveCommentStableKey.value = comment.stableKey;
    showSidebar.value = true;
    sidebarTab.value = 'annotations';
    dragMode.value = false;
    await pdfViewerRef.value.focusAnnotationComment(comment);
}

function handleAnnotationCommentClick(comment: IAnnotationCommentSummary) {
    annotationActiveCommentStableKey.value = comment.stableKey;
    dragMode.value = false;
}

function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
    closeAnnotationContextMenu();
    annotationActiveCommentStableKey.value = comment.stableKey;
    const matched = findMatchingAnnotationComment(comment);
    if (matched) {
        const matchedText = matched.text.trim();
        const incomingText = comment.text.trim();
        upsertAnnotationNoteWindow(matchedText.length >= incomingText.length ? matched : comment);
    } else {
        upsertAnnotationNoteWindow(comment);
    }
    dragMode.value = false;
}

function closeAnnotationContextMenu() {
    if (!annotationContextMenu.value.visible) {
        return;
    }
    annotationContextMenu.value = {
        visible: false,
        x: 0,
        y: 0,
        comment: null,
        hasSelection: false,
        pageNumber: null,
        pageX: null,
        pageY: null,
    };
}

function closeShapeProperties() {
    shapePropertiesPopover.value = {
        visible: false,
        x: 0,
        y: 0, 
    };
}

function handleShapePropertyUpdate(updates: Partial<IShapeAnnotation>) {
    const id = pdfViewerRef.value?.selectedShapeId?.value;
    if (!id) {
        return;
    }

    const nextSettings: IAnnotationSettings = {...annotationSettings.value};
    let didUpdateDefaults = false;
    if (typeof updates.color === 'string' && updates.color.trim()) {
        nextSettings.shapeColor = updates.color;
        didUpdateDefaults = true;
    }
    if (typeof updates.strokeWidth === 'number' && Number.isFinite(updates.strokeWidth)) {
        nextSettings.shapeStrokeWidth = updates.strokeWidth;
        didUpdateDefaults = true;
    }
    if (typeof updates.opacity === 'number' && Number.isFinite(updates.opacity)) {
        nextSettings.shapeOpacity = updates.opacity;
        didUpdateDefaults = true;
    }
    if ('fillColor' in updates) {
        const fill = updates.fillColor ?? 'transparent';
        nextSettings.shapeFillColor = fill;
        didUpdateDefaults = true;
    }
    if (didUpdateDefaults) {
        annotationSettings.value = nextSettings;
    }

    pdfViewerRef.value?.updateShape(id, updates);
}

function handleShapeContextMenu(payload: {
    shapeId: string;
    clientX: number;
    clientY: number;
}) {
    closeAnnotationContextMenu();
    const popoverWidth = 260;
    const popoverHeight = 200;
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - popoverWidth - margin);
    const maxY = Math.max(margin, window.innerHeight - popoverHeight - margin);

    shapePropertiesPopover.value = {
        visible: true,
        x: Math.min(Math.max(margin, payload.clientX), maxX),
        y: Math.min(Math.max(margin, payload.clientY), maxY),
    };
}

function handleViewerAnnotationContextMenu(payload: {
    comment: IAnnotationCommentSummary | null;
    clientX: number;
    clientY: number;
    hasSelection: boolean;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}) {
    if (payload.comment) {
        annotationActiveCommentStableKey.value = payload.comment.stableKey;
    } else {
        annotationActiveCommentStableKey.value = null;
    }

    const hasComment = Boolean(payload.comment);
    const hasSelection = payload.hasSelection;
    const width = 258;
    const markupSectionHeight = hasSelection ? 164 : 0;
    const estimatedHeight = (hasComment ? 258 : 0) + markupSectionHeight + 132;
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - estimatedHeight - margin);

    annotationContextMenu.value = {
        visible: true,
        x: Math.min(Math.max(margin, payload.clientX), maxX),
        y: Math.min(Math.max(margin, payload.clientY), maxY),
        comment: payload.comment,
        hasSelection: payload.hasSelection,
        pageNumber: payload.pageNumber,
        pageX: payload.pageX,
        pageY: payload.pageY,
    };
}

function openContextMenuNote() {
    const comment = annotationContextMenu.value.comment;
    if (!comment) {
        return;
    }
    handleOpenAnnotationNote(comment);
    closeAnnotationContextMenu();
}

function copyContextMenuNoteText() {
    const comment = annotationContextMenu.value.comment;
    if (!comment) {
        return;
    }
    void handleCopyAnnotationComment(comment);
    closeAnnotationContextMenu();
}

function deleteContextMenuComment() {
    const comment = annotationContextMenu.value.comment;
    if (!comment) {
        return;
    }
    void handleDeleteAnnotationComment(comment);
    closeAnnotationContextMenu();
}

async function createContextMenuFreeNote() {
    if (!pdfViewerRef.value) {
        closeAnnotationContextMenu();
        return;
    }

    const {
        pageNumber,
        pageX,
        pageY,
    } = annotationContextMenu.value;
    if (
        !Number.isFinite(pageNumber)
        || !Number.isFinite(pageX)
        || !Number.isFinite(pageY)
    ) {
        closeAnnotationContextMenu();
        return;
    }

    await pdfViewerRef.value.commentAtPoint(
        pageNumber as number,
        pageX as number,
        pageY as number,
        { preferTextAnchor: false },
    );
    closeAnnotationContextMenu();
}

async function createContextMenuSelectionNote() {
    await pdfViewerRef.value?.commentSelection();
    closeAnnotationContextMenu();
}

async function createContextMenuMarkup(tool: TAnnotationTool) {
    if (!pdfViewerRef.value) {
        closeAnnotationContextMenu();
        return;
    }
    handleAnnotationToolChange(tool);
    await nextTick();
    await pdfViewerRef.value.highlightSelection();
    if (!annotationKeepActive.value) {
        annotationTool.value = 'none';
    }
    closeAnnotationContextMenu();
}

function annotationCommentsMatch(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    if (left.stableKey && right.stableKey) {
        return left.stableKey === right.stableKey;
    }

    if (left.annotationId && right.annotationId) {
        return left.annotationId === right.annotationId && left.pageIndex === right.pageIndex;
    }

    if (left.uid && right.uid) {
        return left.uid === right.uid && left.pageIndex === right.pageIndex;
    }

    return (
        left.id === right.id
        && left.pageIndex === right.pageIndex
        && left.source === right.source
    );
}

function findMatchingAnnotationComment(comment: IAnnotationCommentSummary) {
    return annotationComments.value.find(candidate => annotationCommentsMatch(candidate, comment));
}

function isSameAnnotationComment(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    return annotationCommentsMatch(left, right);
}

function findAnnotationNoteWindowIndex(stableKey: string) {
    return annotationNoteWindows.value.findIndex(note => note.comment.stableKey === stableKey);
}

function findAnnotationNoteWindow(stableKey: string) {
    const index = findAnnotationNoteWindowIndex(stableKey);
    if (index === -1) {
        return null;
    }
    return annotationNoteWindows.value[index] ?? null;
}

function bringAnnotationNoteToFront(stableKey: string) {
    const note = findAnnotationNoteWindow(stableKey);
    if (!note) {
        return;
    }
    annotationNoteOrderCounter += 1;
    note.order = annotationNoteOrderCounter;
}

function ensureAnnotationNoteDefaultPosition(stableKey: string) {
    if (annotationNotePositions.value[stableKey]) {
        return;
    }
    const noteCount = annotationNoteWindows.value.length;
    const lane = Math.max(0, noteCount - 1) % 5;
    annotationNotePositions.value = {
        ...annotationNotePositions.value,
        [stableKey]: {
            x: 14 + lane * 20,
            y: 72 + lane * 14,
        },
    };
}

function upsertAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
    const key = comment.stableKey;
    const existing = findAnnotationNoteWindow(key);
    if (existing) {
        const hasUnsavedLocalChanges = existing.text !== existing.lastSavedText;
        existing.comment = comment;
        existing.error = null;
        if (!hasUnsavedLocalChanges) {
            const nextText = comment.text || '';
            existing.text = nextText;
            existing.lastSavedText = nextText;
        }
        bringAnnotationNoteToFront(key);
        return;
    }

    annotationNoteOrderCounter += 1;
    const initialText = comment.text || '';
    annotationNoteWindows.value = [
        ...annotationNoteWindows.value,
        {
            comment,
            text: initialText,
            lastSavedText: initialText,
            saving: false,
            error: null,
            order: annotationNoteOrderCounter,
            saveMode: 'auto',
        },
    ];
    ensureAnnotationNoteDefaultPosition(key);
}

function removeAnnotationNoteWindow(stableKey: string) {
    const before = annotationNoteWindows.value.length;
    annotationNoteWindows.value = annotationNoteWindows.value.filter(note => note.comment.stableKey !== stableKey);
    if (annotationNoteWindows.value.length !== before) {
        const debounced = annotationNoteDebouncers.get(stableKey) as ({ cancel?: () => void } & (() => void)) | undefined;
        debounced?.cancel?.();
        annotationNoteDebouncers.delete(stableKey);
    }
}

function setAnnotationNoteWindowError(stableKey: string, message: string | null) {
    const note = findAnnotationNoteWindow(stableKey);
    if (!note) {
        return;
    }
    note.error = message;
}

function updateAnnotationNoteText(stableKey: string, text: string) {
    const note = findAnnotationNoteWindow(stableKey);
    if (!note) {
        return;
    }
    note.text = text;
    note.error = null;
    if (note.text !== note.lastSavedText) {
        markAnnotationDirty();
    }
    schedulePersistAnnotationNote(stableKey);
}

function updateAnnotationNotePosition(stableKey: string, position: IAnnotationNotePosition) {
    annotationNotePositions.value = {
        ...annotationNotePositions.value,
        [stableKey]: {
            x: Math.round(position.x),
            y: Math.round(position.y),
        },
    };
}

function getAnnotationNoteDebouncedSaver(stableKey: string) {
    const existing = annotationNoteDebouncers.get(stableKey);
    if (existing) {
        return existing;
    }
    const saver = useDebounceFn(() => {
        void persistAnnotationNote(stableKey, false);
    }, 220);
    annotationNoteDebouncers.set(stableKey, saver);
    return saver;
}

function schedulePersistAnnotationNote(stableKey: string) {
    getAnnotationNoteDebouncedSaver(stableKey)();
}

async function persistAnnotationNote(stableKey: string, force = false) {
    const note = findAnnotationNoteWindow(stableKey);
    if (!note || !pdfViewerRef.value) {
        return true;
    }

    const current = note.comment;
    const nextText = note.text;
    if (!force && nextText === note.lastSavedText) {
        return true;
    }

    if (!force && note.saveMode === 'embedded') {
        // For embedded-reference annotations, autosave would require a full PDF reload.
        // Defer writes until forced save (close/save/export) to keep popup editing stable.
        return true;
    }

    if (note.saving) {
        return false;
    }

    note.saving = true;
    note.error = null;
    try {
        let saved = await pdfViewerRef.value.updateAnnotationComment(current, nextText);
        if (!saved && !force) {
            note.saveMode = 'embedded';
            return true;
        }
        if (!saved) {
            saved = await updateEmbeddedAnnotationByRef(current, nextText);
        }
        if (!saved) {
            note.error = 'Unable to update this note.';
            return false;
        }

        note.saveMode = saved && note.saveMode === 'embedded'
            ? 'embedded'
            : 'auto';

        const localUpdated: IAnnotationCommentSummary = {
            ...current,
            text: nextText,
            modifiedAt: Date.now(),
        };
        note.comment = localUpdated;
        note.text = nextText;
        note.lastSavedText = nextText;

        const latest = findMatchingAnnotationComment(current);
        if (latest && latest.text === nextText) {
            note.comment = latest;
            note.text = latest.text || '';
            note.lastSavedText = latest.text || '';
            return true;
        }
        return true;
    } finally {
        const latestNote = findAnnotationNoteWindow(stableKey);
        if (latestNote) {
            latestNote.saving = false;
            if (latestNote.text !== latestNote.lastSavedText) {
                schedulePersistAnnotationNote(stableKey);
            }
        }
    }
}

async function persistAllAnnotationNotes(force = false) {
    const notes = [...annotationNoteWindows.value];
    for (const note of notes) {
        const saved = await persistAnnotationNote(note.comment.stableKey, force);
        if (!saved) {
            return false;
        }
    }
    return true;
}

function parsePdfJsAnnotationRef(annotationId: string | null | undefined) {
    if (!annotationId) {
        return null;
    }
    const match = annotationId.trim().match(/^(\d+)R(?:(\d+))?$/i);
    if (!match) {
        return null;
    }

    const objectNumber = Number(match[1]);
    const generationNumber = match[2] ? Number(match[2]) : 0;
    if (
        !Number.isInteger(objectNumber)
        || objectNumber <= 0
        || !Number.isInteger(generationNumber)
        || generationNumber < 0
    ) {
        return null;
    }

    return PDFRef.of(objectNumber, generationNumber);
}

function parseAnnotationRefFromStableKey(stableKey: string | null | undefined) {
    if (!stableKey) {
        return null;
    }
    const match = stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/i);
    if (!match?.[1]) {
        return null;
    }
    return parsePdfJsAnnotationRef(match[1]);
}

function resolveCommentPdfRef(comment: IAnnotationCommentSummary) {
    return (
        parsePdfJsAnnotationRef(comment.annotationId ?? comment.id)
        ?? parseAnnotationRefFromStableKey(comment.stableKey)
    );
}

function toPdfDateString(date: Date = new Date()) {
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    const timezoneMinutes = -date.getTimezoneOffset();
    const sign = timezoneMinutes >= 0 ? '+' : '-';
    const absOffset = Math.abs(timezoneMinutes);
    const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
    const offsetMinutes = String(absOffset % 60).padStart(2, '0');

    return `D:${year}${month}${day}${hours}${minutes}${seconds}${sign}${offsetHours}'${offsetMinutes}'`;
}

function setAnnotationDictContents(
    dict: PDFDict | null,
    text: string,
    modifiedAt: string,
) {
    if (!dict) {
        return false;
    }

    dict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    dict.set(PDFName.of('M'), PDFString.of(modifiedAt));
    return true;
}

function updateAnnotationTextByRef(
    doc: PDFDocument,
    targetRef: PDFRef,
    text: string,
) {
    const targetDict = doc.context.lookupMaybe(targetRef, PDFDict);
    if (!targetDict) {
        return false;
    }

    const modifiedAt = toPdfDateString(new Date());
    let updated = setAnnotationDictContents(targetDict, text, modifiedAt);

    const popupValue = targetDict.get(PDFName.of('Popup'));
    if (popupValue instanceof PDFRef) {
        updated = setAnnotationDictContents(doc.context.lookupMaybe(popupValue, PDFDict) ?? null, text, modifiedAt) || updated;
    } else if (popupValue instanceof PDFDict) {
        updated = setAnnotationDictContents(popupValue, text, modifiedAt) || updated;
    }

    return updated;
}

function collectAnnotationRefsToDelete(doc: PDFDocument, targetRef: PDFRef) {
    const refs = new Map<string, PDFRef>();
    refs.set(targetRef.toString(), targetRef);

    const targetDict = doc.context.lookupMaybe(targetRef, PDFDict);
    if (targetDict) {
        const popupValue = targetDict.get(PDFName.of('Popup'));
        const popupRef = popupValue instanceof PDFRef ? popupValue : null;
        if (popupRef) {
            refs.set(popupRef.toString(), popupRef);
        }
    }

    return Array.from(refs.values());
}

function removeAnnotationRefsFromPages(doc: PDFDocument, refsToRemove: PDFRef[]) {
    if (refsToRemove.length === 0) {
        return false;
    }

    const refTags = new Set(refsToRemove.map(ref => ref.toString()));
    let removed = false;

    doc.getPages().forEach((page) => {
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            return;
        }

        for (let index = annots.size() - 1; index >= 0; index -= 1) {
            const value = annots.get(index);
            if (!(value instanceof PDFRef)) {
                continue;
            }
            if (!refTags.has(value.toString())) {
                continue;
            }
            annots.remove(index);
            removed = true;
        }
    });

    return removed;
}

async function deleteEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary) {
    const targetRef = resolveCommentPdfRef(comment);
    if (!targetRef) {
        return false;
    }

    let sourceData = pdfData.value ? pdfData.value.slice() : null;
    if (!sourceData && workingCopyPath.value && window.electronAPI) {
        try {
            const buffer = await window.electronAPI.readFile(workingCopyPath.value);
            sourceData = new Uint8Array(buffer);
        } catch {
            sourceData = null;
        }
    }
    if (!sourceData) {
        return false;
    }

    let document: PDFDocument;
    try {
        document = await PDFDocument.load(sourceData, { updateMetadata: false });
    } catch {
        return false;
    }

    const refsToDelete = collectAnnotationRefsToDelete(document, targetRef);
    const removed = removeAnnotationRefsFromPages(document, refsToDelete);
    if (!removed) {
        return false;
    }

    const nextData = await document.save();
    const pageToRestore = currentPage.value;
    const restorePromise = waitForPdfReload(pageToRestore);

    await loadPdfFromData(nextData, {
        pushHistory: true,
        persistWorkingCopy: !!workingCopyPath.value,
    });
    await restorePromise;
    return true;
}

async function updateEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary, text: string) {
    const targetRef = resolveCommentPdfRef(comment);
    if (!targetRef) {
        return false;
    }

    let sourceData = pdfData.value ? pdfData.value.slice() : null;
    if (!sourceData && workingCopyPath.value && window.electronAPI) {
        try {
            const buffer = await window.electronAPI.readFile(workingCopyPath.value);
            sourceData = new Uint8Array(buffer);
        } catch {
            sourceData = null;
        }
    }
    if (!sourceData) {
        return false;
    }

    let document: PDFDocument;
    try {
        document = await PDFDocument.load(sourceData, { updateMetadata: false });
    } catch {
        return false;
    }

    const updated = updateAnnotationTextByRef(document, targetRef, text);
    if (!updated) {
        return false;
    }

    const nextData = await document.save();
    const pageToRestore = currentPage.value;
    const restorePromise = waitForPdfReload(pageToRestore);

    await loadPdfFromData(nextData, {
        pushHistory: true,
        persistWorkingCopy: !!workingCopyPath.value,
    });
    await restorePromise;
    return true;
}

const MARKUP_SUBTYPE_TO_PDF_NAME: Record<TMarkupSubtype, string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
};

async function rewriteMarkupSubtypes(data: Uint8Array): Promise<Uint8Array> {
    const overrides = pdfViewerRef.value?.getMarkupSubtypeOverrides();
    const subtypeHints = annotationComments.value
        .filter(comment => (
            comment.source === 'editor'
            && (comment.subtype === 'Underline' || comment.subtype === 'StrikeOut')
            && comment.markerRect
        ))
        .map(comment => ({
            subtype: comment.subtype as TMarkupSubtype,
            pageIndex: comment.pageIndex,
            markerRect: comment.markerRect as {
                left: number;
                top: number;
                width: number;
                height: number;
            },
            consumed: false,
        }));

    if ((!overrides || overrides.size === 0) && subtypeHints.length === 0) {
        return data;
    }

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch {
        return data;
    }

    const subtypeName = PDFName.of('Subtype');
    const highlightName = PDFName.of('Highlight');
    let rewritten = false;

    const numberFromArray = (array: PDFArray, index: number) => {
        const value = array.get(index);
        return value instanceof PDFNumber ? value.asNumber() : null;
    };

    const markerRectFromDict = (dict: PDFDict, pageWidth: number, pageHeight: number) => {
        const rectArray = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
        if (!(rectArray instanceof PDFArray) || rectArray.size() < 4 || pageWidth <= 0 || pageHeight <= 0) {
            return null;
        }

        const x1 = numberFromArray(rectArray, 0);
        const y1 = numberFromArray(rectArray, 1);
        const x2 = numberFromArray(rectArray, 2);
        const y2 = numberFromArray(rectArray, 3);
        if (
            x1 === null
            || y1 === null
            || x2 === null
            || y2 === null
        ) {
            return null;
        }

        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        const width = (maxX - minX) / pageWidth;
        const height = (maxY - minY) / pageHeight;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return null;
        }

        const left = minX / pageWidth;
        const top = 1 - (maxY / pageHeight);
        return {
            left: Math.max(0, Math.min(1, left)),
            top: Math.max(0, Math.min(1, top)),
            width: Math.max(0, Math.min(1, width)),
            height: Math.max(0, Math.min(1, height)),
        };
    };

    const markerRectIoU = (
        left: {
            left: number;
            top: number;
            width: number;
            height: number;
        } | null,
        right: {
            left: number;
            top: number;
            width: number;
            height: number;
        } | null,
    ) => {
        if (!left || !right) {
            return 0;
        }
        const leftRight = left.left + left.width;
        const leftBottom = left.top + left.height;
        const rightRight = right.left + right.width;
        const rightBottom = right.top + right.height;
        const intersectionLeft = Math.max(left.left, right.left);
        const intersectionTop = Math.max(left.top, right.top);
        const intersectionRight = Math.min(leftRight, rightRight);
        const intersectionBottom = Math.min(leftBottom, rightBottom);
        const intersectionWidth = Math.max(0, intersectionRight - intersectionLeft);
        const intersectionHeight = Math.max(0, intersectionBottom - intersectionTop);
        const intersectionArea = intersectionWidth * intersectionHeight;
        if (intersectionArea <= 0) {
            return 0;
        }
        const leftArea = left.width * left.height;
        const rightArea = right.width * right.height;
        const unionArea = leftArea + rightArea - intersectionArea;
        if (unionArea <= 0) {
            return 0;
        }
        return intersectionArea / unionArea;
    };

    const pages = doc.getPages();
    for (const [
        pageIndex,
        page,
    ] of pages.entries()) {
        const pageHints = subtypeHints.filter(hint => !hint.consumed && hint.pageIndex === pageIndex);
        const {
            width: pageWidth,
            height: pageHeight,
        } = page.getSize();
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let i = 0; i < annots.size(); i++) {
            const value = annots.get(i);
            const ref = value instanceof PDFRef ? value : null;
            if (!ref) {
                continue;
            }

            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                continue;
            }

            const currentSubtype = dict.get(subtypeName);
            if (!(currentSubtype instanceof PDFName) || currentSubtype !== highlightName) {
                continue;
            }

            const refTag = `${ref.objectNumber}R${ref.generationNumber}`;
            let targetSubtype = overrides?.get(refTag) ?? null;
            if (!targetSubtype && pageHints.length > 0) {
                const markerRect = markerRectFromDict(dict, pageWidth, pageHeight);
                let bestMatch: {
                    score: number;
                    hint: (typeof pageHints)[number];
                } | null = null;
                for (const hint of pageHints) {
                    if (hint.consumed) {
                        continue;
                    }
                    const score = markerRectIoU(markerRect, hint.markerRect);
                    if (score <= 0) {
                        continue;
                    }
                    if (!bestMatch || score > bestMatch.score) {
                        bestMatch = {
                            score,
                            hint,
                        };
                    }
                }
                if (bestMatch && bestMatch.score >= 0.2) {
                    targetSubtype = bestMatch.hint.subtype;
                    bestMatch.hint.consumed = true;
                }
            }
            if (!targetSubtype) {
                continue;
            }

            const pdfSubtypeName = MARKUP_SUBTYPE_TO_PDF_NAME[targetSubtype];
            if (pdfSubtypeName && pdfSubtypeName !== 'Highlight') {
                dict.set(subtypeName, PDFName.of(pdfSubtypeName));
                rewritten = true;
            }
        }
    }

    if (!rewritten) {
        return data;
    }

    return new Uint8Array(await doc.save());
}

function parseHexColor(hex: string): [number, number, number] {
    const clean = hex.replace('#', '');
    if (clean.length === 3) {
        return [
            Number.parseInt(clean[0]! + clean[0]!, 16) / 255,
            Number.parseInt(clean[1]! + clean[1]!, 16) / 255,
            Number.parseInt(clean[2]! + clean[2]!, 16) / 255,
        ];
    }
    return [
        Number.parseInt(clean.slice(0, 2), 16) / 255,
        Number.parseInt(clean.slice(2, 4), 16) / 255,
        Number.parseInt(clean.slice(4, 6), 16) / 255,
    ];
}

async function serializeShapeAnnotations(data: Uint8Array): Promise<Uint8Array> {
    const shapes = pdfViewerRef.value?.getAllShapes() ?? [];
    if (shapes.length === 0) {
        return data;
    }

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch {
        return data;
    }

    const pages = doc.getPages();

    for (const shape of shapes) {
        const page = pages[shape.pageIndex];
        if (!page) continue;

        const {
            width: pageWidth,
            height: pageHeight,
        } = page.getSize();
        const [
            r,
            g,
            b,
        ] = parseHexColor(shape.color);
        const lineWidth = shape.strokeWidth;

        if (shape.type === 'rectangle') {
            const x = shape.x * pageWidth;
            const y = (1 - shape.y - shape.height) * pageHeight;
            const w = shape.width * pageWidth;
            const h = shape.height * pageHeight;

            const rect = doc.context.obj([
                x,
                y,
                x + w,
                y + h,
            ]);
            const annotDict = doc.context.obj({
                Type: 'Annot',
                Subtype: 'Square',
                Rect: rect,
                C: [
                    r,
                    g,
                    b,
                ],
                CA: shape.opacity,
                Border: [
                    0,
                    0,
                    lineWidth,
                ],
            });

            if (shape.fillColor) {
                const [
                    fr,
                    fg,
                    fb,
                ] = parseHexColor(shape.fillColor);
                (annotDict as PDFDict).set(PDFName.of('IC'), doc.context.obj([
                    fr,
                    fg,
                    fb,
                ]));
            }

            const annotRef = doc.context.register(annotDict);
            const annots = page.node.Annots() ?? doc.context.obj([]);
            if (annots instanceof PDFArray) {
                annots.push(annotRef);
            }
            page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
        } else if (shape.type === 'circle') {
            const x = shape.x * pageWidth;
            const y = (1 - shape.y - shape.height) * pageHeight;
            const w = shape.width * pageWidth;
            const h = shape.height * pageHeight;

            const rect = doc.context.obj([
                x,
                y,
                x + w,
                y + h,
            ]);
            const annotDict = doc.context.obj({
                Type: 'Annot',
                Subtype: 'Circle',
                Rect: rect,
                C: [
                    r,
                    g,
                    b,
                ],
                CA: shape.opacity,
                Border: [
                    0,
                    0,
                    lineWidth,
                ],
            });

            if (shape.fillColor) {
                const [
                    fr,
                    fg,
                    fb,
                ] = parseHexColor(shape.fillColor);
                (annotDict as PDFDict).set(PDFName.of('IC'), doc.context.obj([
                    fr,
                    fg,
                    fb,
                ]));
            }

            const annotRef = doc.context.register(annotDict);
            const annots = page.node.Annots() ?? doc.context.obj([]);
            if (annots instanceof PDFArray) {
                annots.push(annotRef);
            }
            page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
        } else if (shape.type === 'line' || shape.type === 'arrow') {
            const x1 = shape.x * pageWidth;
            const y1 = (1 - shape.y) * pageHeight;
            const x2 = (shape.x2 ?? shape.x) * pageWidth;
            const y2 = (1 - (shape.y2 ?? shape.y)) * pageHeight;

            const minX = Math.min(x1, x2) - lineWidth;
            const minY = Math.min(y1, y2) - lineWidth;
            const maxX = Math.max(x1, x2) + lineWidth;
            const maxY = Math.max(y1, y2) + lineWidth;

            const rect = doc.context.obj([
                minX,
                minY,
                maxX,
                maxY,
            ]);
            const l = doc.context.obj([
                x1,
                y1,
                x2,
                y2,
            ]);

            const annotDict = doc.context.obj({
                Type: 'Annot',
                Subtype: 'Line',
                Rect: rect,
                L: l,
                C: [
                    r,
                    g,
                    b,
                ],
                CA: shape.opacity,
                Border: [
                    0,
                    0,
                    lineWidth,
                ],
            });

            if (shape.type === 'arrow') {
                const leStyle = shape.lineEndStyle === 'openArrow' ? 'OpenArrow' : 'ClosedArrow';
                (annotDict as PDFDict).set(PDFName.of('LE'), doc.context.obj([
                    PDFName.of('None'),
                    PDFName.of(leStyle),
                ]));
            }

            const annotRef = doc.context.register(annotDict);
            const annots = page.node.Annots() ?? doc.context.obj([]);
            if (annots instanceof PDFArray) {
                annots.push(annotRef);
            }
            page.node.set(PDFName.of('Annots'), annots instanceof PDFArray ? annots : doc.context.obj([annotRef]));
        }
    }

    return new Uint8Array(await doc.save());
}

function normalizeBookmarkEntries(entries: IPdfBookmarkEntry[]): IPdfBookmarkEntry[] {
    if (totalPages.value <= 0) {
        return [] as IPdfBookmarkEntry[];
    }

    const maxPageIndex = totalPages.value - 1;

    function normalizeItem(item: IPdfBookmarkEntry): IPdfBookmarkEntry {
        const title = item.title.trim();
        const pageIndex = typeof item.pageIndex === 'number'
            ? Math.max(0, Math.min(maxPageIndex, Math.trunc(item.pageIndex)))
            : null;
        const namedDest = typeof item.namedDest === 'string' && item.namedDest.trim().length > 0
            ? item.namedDest
            : null;
        const bold = item.bold === true;
        const italic = item.italic === true;
        const color = typeof item.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(item.color.trim())
            ? item.color.trim().toLowerCase()
            : null;

        return {
            title: title.length > 0 ? title : 'Untitled Bookmark',
            pageIndex,
            namedDest,
            bold,
            italic,
            color,
            items: item.items.map(normalizeItem),
        };
    }

    return entries.map(normalizeItem);
}

async function rewriteBookmarks(data: Uint8Array): Promise<Uint8Array> {
    if (!bookmarksDirty.value) {
        return data;
    }

    const normalizedBookmarks = normalizeBookmarkEntries(bookmarkItems.value);

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch {
        return data;
    }

    const outlinesName = PDFName.of('Outlines');
    if (normalizedBookmarks.length === 0) {
        doc.catalog.delete(outlinesName);
        return new Uint8Array(await doc.save());
    }

    interface IOutlineNodeBuild {
        ref: PDFRef;
        dict: PDFDict;
        item: IPdfBookmarkEntry;
        visibleCount: number;
    }

    const parentName = PDFName.of('Parent');
    const prevName = PDFName.of('Prev');
    const nextName = PDFName.of('Next');
    const firstName = PDFName.of('First');
    const lastName = PDFName.of('Last');
    const countName = PDFName.of('Count');
    const titleName = PDFName.of('Title');
    const destName = PDFName.of('Dest');
    const typeName = PDFName.of('Type');
    const flagsName = PDFName.of('F');
    const colorName = PDFName.of('C');

    const pdfNull = doc.context.obj(null);

    function setNodeDestination(dict: PDFDict, item: IPdfBookmarkEntry) {
        if (typeof item.pageIndex === 'number') {
            const pageRef = doc.getPage(item.pageIndex).ref;
            const destArray = doc.context.obj([
                pageRef,
                PDFName.of('XYZ'),
                pdfNull,
                pdfNull,
                pdfNull,
            ]) as PDFArray;
            dict.set(destName, destArray);
            return;
        }

        if (item.namedDest) {
            dict.set(destName, PDFString.of(item.namedDest));
        }
    }

    function setNodeStyle(dict: PDFDict, item: IPdfBookmarkEntry) {
        const flags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
        if (flags > 0) {
            dict.set(flagsName, PDFNumber.of(flags));
        }

        if (!item.color) {
            return;
        }

        const value = item.color.replace('#', '');
        const red = Number.parseInt(value.slice(0, 2), 16) / 255;
        const green = Number.parseInt(value.slice(2, 4), 16) / 255;
        const blue = Number.parseInt(value.slice(4, 6), 16) / 255;

        dict.set(colorName, doc.context.obj([
            red,
            green,
            blue,
        ]));
    }

    function buildOutlineLevel(
        items: IPdfBookmarkEntry[],
        parentRef: PDFRef,
    ): {
        first: PDFRef | null;
        last: PDFRef | null;
        visibleCount: number;
    } {
        if (items.length === 0) {
            return {
                first: null,
                last: null,
                visibleCount: 0,
            };
        }

        const nodes: IOutlineNodeBuild[] = items.map((item) => {
            const dict = doc.context.obj({}) as PDFDict;
            dict.set(titleName, PDFHexString.fromText(item.title));
            setNodeDestination(dict, item);
            setNodeStyle(dict, item);

            const ref = doc.context.register(dict);
            return {
                ref,
                dict,
                item,
                visibleCount: 1,
            };
        });

        for (const [
            index,
            node,
        ] of nodes.entries()) {
            node.dict.set(parentName, parentRef);
            if (index > 0) {
                const previous = nodes[index - 1];
                if (previous) {
                    node.dict.set(prevName, previous.ref);
                }
            }
            if (index + 1 < nodes.length) {
                const next = nodes[index + 1];
                if (next) {
                    node.dict.set(nextName, next.ref);
                }
            }
        }

        for (const node of nodes) {
            const childResult = buildOutlineLevel(node.item.items, node.ref);
            if (childResult.first && childResult.last) {
                node.dict.set(firstName, childResult.first);
                node.dict.set(lastName, childResult.last);
                if (childResult.visibleCount > 0) {
                    node.dict.set(countName, PDFNumber.of(childResult.visibleCount));
                }
                node.visibleCount += childResult.visibleCount;
            }
        }

        const first = nodes[0]?.ref ?? null;
        const last = nodes[nodes.length - 1]?.ref ?? null;
        const visibleCount = nodes.reduce((total, node) => total + node.visibleCount, 0);

        return {
            first,
            last,
            visibleCount,
        };
    }

    const outlinesDict = doc.context.obj({}) as PDFDict;
    outlinesDict.set(typeName, PDFName.of('Outlines'));
    const outlinesRef = doc.context.register(outlinesDict);

    const tree = buildOutlineLevel(normalizedBookmarks, outlinesRef);
    if (!tree.first || !tree.last) {
        doc.catalog.delete(outlinesName);
        return new Uint8Array(await doc.save());
    }

    outlinesDict.set(firstName, tree.first);
    outlinesDict.set(lastName, tree.last);
    outlinesDict.set(countName, PDFNumber.of(tree.visibleCount));
    doc.catalog.set(outlinesName, outlinesRef);
    return new Uint8Array(await doc.save());
}

async function rewritePageLabels(data: Uint8Array): Promise<Uint8Array> {
    if (!pageLabelsDirty.value || totalPages.value <= 0) {
        return data;
    }

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch {
        return data;
    }

    const normalizedRanges = normalizePageLabelRanges(pageLabelRanges.value, totalPages.value);
    const pageLabelsName = PDFName.of('PageLabels');

    if (isImplicitDefaultPageLabels(normalizedRanges, totalPages.value)) {
        doc.catalog.delete(pageLabelsName);
        return new Uint8Array(await doc.save());
    }

    const nums = doc.context.obj([]) as PDFArray;
    const styleName = PDFName.of('S');
    const prefixName = PDFName.of('P');
    const startName = PDFName.of('St');
    const typeName = PDFName.of('Type');
    const pageLabelName = PDFName.of('PageLabel');

    for (const range of normalizedRanges) {
        nums.push(PDFNumber.of(range.startPage - 1));

        const labelDict = doc.context.obj({}) as PDFDict;
        labelDict.set(typeName, pageLabelName);
        if (range.style) {
            labelDict.set(styleName, PDFName.of(range.style));
        }
        if (range.prefix.length > 0) {
            labelDict.set(prefixName, PDFHexString.fromText(range.prefix));
        }
        if (range.style && range.startNumber > 1) {
            labelDict.set(startName, PDFNumber.of(range.startNumber));
        }

        nums.push(labelDict);
    }

    const pageLabelsDict = doc.context.obj({Nums: nums}) as PDFDict;

    doc.catalog.set(pageLabelsName, pageLabelsDict);
    return new Uint8Array(await doc.save());
}

async function handleCopyAnnotationComment(comment: IAnnotationCommentSummary) {
    closeAnnotationContextMenu();
    const text = comment.text?.trim();
    if (!text) {
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        // Ignore clipboard errors in non-secure contexts.
    }
}

let annotationDeleteQueue: Promise<void> = Promise.resolve();

async function performDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
    closeAnnotationContextMenu();
    if (!pdfViewerRef.value) {
        return;
    }
    setAnnotationNoteWindowError(comment.stableKey, null);
    let deleted = await pdfViewerRef.value.deleteAnnotationComment(comment);
    if (!deleted) {
        deleted = await deleteEmbeddedAnnotationByRef(comment);
    }
    if (!deleted) {
        setAnnotationNoteWindowError(comment.stableKey, 'Unable to delete this annotation from the current document.');
        return;
    }
    annotationNoteWindows.value
        .filter(note => isSameAnnotationComment(note.comment, comment))
        .forEach(note => removeAnnotationNoteWindow(note.comment.stableKey));
}

async function handleDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
    annotationDeleteQueue = annotationDeleteQueue
        .catch(() => undefined)
        .then(async () => {
            await performDeleteAnnotationComment(comment);
        });
    await annotationDeleteQueue;
}

async function closeAnnotationNote(stableKey: string, options: { saveIfDirty?: boolean } = {}) {
    const saveIfDirty = options.saveIfDirty ?? true;
    const note = findAnnotationNoteWindow(stableKey);
    if (!note) {
        return;
    }

    if (saveIfDirty) {
        if (note.saving) {
            let attempts = 0;
            while (note.saving && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 25));
                attempts += 1;
            }
        }
        const saved = await persistAnnotationNote(stableKey, true);
        if (!saved) {
            setAnnotationNoteWindowError(stableKey, 'Unable to save this note before closing.');
            return;
        }
    }

    removeAnnotationNoteWindow(stableKey);
    closeAnnotationContextMenu();
}

async function closeAllAnnotationNotes(options: { saveIfDirty?: boolean } = {}) {
    const saveIfDirty = options.saveIfDirty ?? true;
    if (saveIfDirty) {
        const saved = await persistAllAnnotationNotes(true);
        if (!saved) {
            return false;
        }
    }

    annotationNoteWindows.value.forEach((note) => {
        const debounced = annotationNoteDebouncers.get(note.comment.stableKey) as ({ cancel?: () => void } & (() => void)) | undefined;
        debounced?.cancel?.();
        annotationNoteDebouncers.delete(note.comment.stableKey);
    });
    annotationNoteWindows.value = [];
    closeAnnotationContextMenu();
    return true;
}

async function handleSearch() {
    if (workingCopyPath.value) {
        showSidebar.value = true;
        sidebarTab.value = 'search';
        await search(
            searchQuery.value,
            workingCopyPath.value,
            totalPages.value > 0 ? totalPages.value : undefined,
        );
    }
}

function handleSearchNext() {
    goToResult('next');
}

function handleSearchPrevious() {
    goToResult('previous');
}

function handleGoToResult(index: number) {
    setResultIndex(index);
}

function hasAnnotationChanges() {
    if (pdfViewerRef.value?.hasShapes?.value) {
        return true;
    }
    const doc = pdfDocument.value;
    if (!doc) {
        return false;
    }
    try {
        const storage = doc.annotationStorage;
        if (!storage) {
            return false;
        }
        const modifiedIds = storage.modifiedIds?.ids;
        if (modifiedIds && typeof modifiedIds.size === 'number') {
            return modifiedIds.size > 0;
        }
        return false;
    } catch {
        return false;
    }
}

async function handleUndo() {
    if (isAnySaving.value || !canUndo.value) {
        return;
    }
    if (isAnnotationUndoContext.value) {
        pdfViewerRef.value?.undoAnnotation();
        return;
    }
    if (isHistoryBusy.value) {
        return;
    }
    isHistoryBusy.value = true;
    if (workingCopyPath.value) {
        clearOcrCache(workingCopyPath.value);
    }
    const pageToRestore = currentPage.value;
    const restorePromise = waitForPdfReload(pageToRestore);
    const didUndo = await undo();
    if (didUndo) {
        await restorePromise;
    }
    isHistoryBusy.value = false;
}

async function handleRedo() {
    if (isAnySaving.value || !canRedo.value) {
        return;
    }
    if (isAnnotationUndoContext.value) {
        pdfViewerRef.value?.redoAnnotation();
        return;
    }
    if (isHistoryBusy.value) {
        return;
    }
    isHistoryBusy.value = true;
    if (workingCopyPath.value) {
        clearOcrCache(workingCopyPath.value);
    }
    const pageToRestore = currentPage.value;
    const restorePromise = waitForPdfReload(pageToRestore);
    const didRedo = await redo();
    if (didRedo) {
        await restorePromise;
    }
    isHistoryBusy.value = false;
}

function handleFitMode(mode: TFitMode) {
    zoom.value = 1;
    fitMode.value = mode;
}

async function handleSave() {
    if (isSaving.value || isSavingAs.value) {
        return;
    }
    if (annotationNoteWindows.value.length > 0) {
        const savedNotes = await persistAllAnnotationNotes(true);
        if (!savedNotes) {
            return;
        }
    }
    isSaving.value = true;
    try {
        // In Electron we always operate on a working copy on disk. Saving should just copy
        // the working copy back to the original, without re-serializing the PDF in the renderer
        // (which can change compression and bloat scanned PDFs).
        if (workingCopyPath.value) {
            const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || pageLabelsDirty.value || bookmarksDirty.value;
            if (shouldSerialize) {
                const rawData = await pdfViewerRef.value?.saveDocument();
                if (rawData) {
                    let data = await rewriteMarkupSubtypes(rawData);
                    data = await serializeShapeAnnotations(data);
                    data = await rewritePageLabels(data);
                    data = await rewriteBookmarks(data);
                    const saved = await saveFile(data);
                    if (saved) {
                        pdfDocument.value?.annotationStorage?.resetModified();
                        markAnnotationSaved();
                        markPageLabelsSaved();
                        markBookmarksSaved();
                    }
                }
                return;
            }
            const saved = await saveWorkingCopy();
            if (saved) {
                markAnnotationSaved();
                markPageLabelsSaved();
                markBookmarksSaved();
            }
            return;
        }

        // Web context fallback.
        const rawData = await pdfViewerRef.value?.saveDocument();
        if (rawData) {
            let data = await rewriteMarkupSubtypes(rawData);
            data = await rewritePageLabels(data);
            data = await rewriteBookmarks(data);
            const saved = await saveFile(data);
            if (saved) {
                pdfDocument.value?.annotationStorage?.resetModified();
                markAnnotationSaved();
                markPageLabelsSaved();
                markBookmarksSaved();
            }
        }
    } finally {
        isSaving.value = false;
    }
}

async function handleSaveAs() {
    if (isSaving.value || isSavingAs.value) {
        return;
    }
    if (annotationNoteWindows.value.length > 0) {
        const savedNotes = await persistAllAnnotationNotes(true);
        if (!savedNotes) {
            return;
        }
    }
    isSavingAs.value = true;
    try {
        let outPath: string | null = null;
        const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || pageLabelsDirty.value || bookmarksDirty.value;
        if (shouldSerialize) {
            const rawData = await pdfViewerRef.value?.saveDocument();
            if (rawData) {
                let data = await rewriteMarkupSubtypes(rawData);
                data = await serializeShapeAnnotations(data);
                data = await rewritePageLabels(data);
                data = await rewriteBookmarks(data);
                outPath = await saveWorkingCopyAs(data);
                if (outPath) {
                    pdfDocument.value?.annotationStorage?.resetModified();
                    markAnnotationSaved();
                    markPageLabelsSaved();
                    markBookmarksSaved();
                }
            }
        } else {
            outPath = await saveWorkingCopyAs();
            if (outPath) {
                markAnnotationSaved();
                markPageLabelsSaved();
                markBookmarksSaved();
            }
        }
        if (outPath) {
            // Keep the recent files list in sync with Save As.
            loadRecentFiles();
        }
    } finally {
        isSavingAs.value = false;
    }
}

watch(pdfSrc, (newSrc, oldSrc) => {
    if (newSrc && newSrc !== oldSrc) {
        resetAnnotationTracking();
        annotationComments.value = [];
        bookmarkItems.value = [];
        bookmarksDirty.value = false;
        bookmarkEditMode.value = false;
        closeAnnotationContextMenu();
        void closeAllAnnotationNotes({ saveIfDirty: false });
    }
    if (!newSrc) {
        resetSearchCache();
        closeSearch();
        annotationTool.value = 'none';
        annotationComments.value = [];
        annotationActiveCommentStableKey.value = null;
        pageLabels.value = null;
        pageLabelRanges.value = [];
        pageLabelsDirty.value = false;
        bookmarkItems.value = [];
        bookmarksDirty.value = false;
        bookmarkEditMode.value = false;
        pdfViewerRef.value?.clearShapes();
        closeAnnotationContextMenu();
        void closeAllAnnotationNotes({ saveIfDirty: false });
        resetAnnotationTracking();
        annotationEditorState.value = {
            isEditing: false,
            isEmpty: true,
            hasSomethingToUndo: false,
            hasSomethingToRedo: false,
            hasSelectedEditor: false,
        };
    }

    // Refresh recent files list after opening a file
    // This ensures the list is up-to-date when user closes the file and returns to empty state
    if (newSrc && !oldSrc) {
        loadRecentFiles();
    }
});

watch(workingCopyPath, (nextPath, previousPath) => {
    if (nextPath === previousPath) {
        return;
    }
    annotationActiveCommentStableKey.value = null;
    closeAnnotationContextMenu();
    void closeAllAnnotationNotes({ saveIfDirty: false });
});

watch(annotationComments, (comments) => {
    if (
        annotationActiveCommentStableKey.value
        && !comments.some(comment => comment.stableKey === annotationActiveCommentStableKey.value)
    ) {
        annotationActiveCommentStableKey.value = null;
    }

    if (annotationNoteWindows.value.length === 0) {
        return;
    }

    annotationNoteWindows.value.forEach((note) => {
        const updated = comments.find(comment => annotationCommentsMatch(comment, note.comment));
        if (!updated) {
            // Keep open instead of force-closing on transient sync misses.
            return;
        }

        const savedText = note.lastSavedText.trim();
        const updatedText = updated.text.trim();
        const currentTimestamp = note.comment.modifiedAt ?? 0;
        const updatedTimestamp = updated.modifiedAt ?? 0;
        const staleEmptySync = (
            !note.saving
            && savedText.length > 0
            && updatedText.length === 0
            && updatedTimestamp <= currentTimestamp
        );

        if (staleEmptySync) {
            note.comment = {
                ...updated,
                text: note.lastSavedText,
                modifiedAt: currentTimestamp || updatedTimestamp || null,
            };
            return;
        }

        note.comment = updated;
        const hasUnsavedLocalChanges = note.text !== note.lastSavedText;
        if (!note.saving && !hasUnsavedLocalChanges) {
            const nextText = updated.text || '';
            note.text = nextText;
            note.lastSavedText = nextText;
        }
    });
});
</script>

<style scoped>
/* Toolbar layout */
.toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--ui-border);
    background: var(--ui-bg);
    white-space: nowrap;
    overflow-x: auto;
    container-type: inline-size;

    --toolbar-control-height: 2.25rem;
    --toolbar-icon-size: 18px;
}

.toolbar :deep(.u-button) {
    border-radius: 0 !important;
}

.toolbar :deep(.u-button::before),
.toolbar :deep(.u-button::after) {
    border-radius: 0 !important;
}

.toolbar-section {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
}

.toolbar-center {
    gap: clamp(0.5rem, 1.5vw, 1.25rem);
}

.toolbar-button-group {
    display: flex;
    align-items: center;
    border: 1px solid var(--ui-border);
    border-radius: 0.375rem;
    overflow: hidden;
}

.toolbar-group-item {
    display: flex;
    border-radius: 0;
}

.toolbar-group-item + .toolbar-group-item {
    border-left: 1px solid var(--ui-border);
}

.toolbar-button-group :deep(button),
.toolbar-button-group :deep(.u-button) {
    border-radius: 0 !important;
}

.toolbar-icon-button {
    width: var(--toolbar-control-height);
    height: var(--toolbar-control-height);
    padding: 0.25rem;
    justify-content: center;
    border-radius: 0 !important;
    font-size: var(--toolbar-icon-size);
}

.toolbar-group-button {
    border-radius: 0 !important;
    height: var(--toolbar-control-height);
    min-width: var(--toolbar-control-height);
    padding: 0.25rem;
    font-size: var(--toolbar-icon-size);
}

.toolbar :deep(.toolbar-icon-button svg),
.toolbar :deep(.toolbar-group-button svg) {
    width: 1.1rem;
    height: 1.1rem;
}

.toolbar-inline-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.sidebar-wrapper {
    display: flex;
    height: 100%;
}

.status-bar {
    min-height: 1.9rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.25rem 0.75rem;
    border-top: 1px solid var(--ui-border);
    background: color-mix(in oklab, var(--ui-bg) 95%, var(--ui-bg-elevated) 5%);
    color: var(--ui-text-dimmed);
    font-size: 0.74rem;
    line-height: 1.2;
}

.status-bar-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.status-bar-metrics {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.875rem;
}

.status-bar-metrics > * + * {
    position: relative;
}

.status-bar-metrics > * + *::before {
    content: "";
    position: absolute;
    left: -0.5rem;
    top: 50%;
    width: 1px;
    height: 0.76rem;
    transform: translateY(-50%);
    background: color-mix(in oklab, var(--ui-border) 86%, transparent 14%);
}

.status-bar-item {
    white-space: nowrap;
}

.status-save-dot-button {
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    padding: 0;
    border-radius: 999px;
    cursor: default;
}

.status-save-dot-button.is-actionable {
    cursor: pointer;
}

.status-save-dot {
    width: 0.56rem;
    height: 0.56rem;
    border-radius: 999px;
    background: color-mix(in oklab, var(--ui-text-dimmed) 72%, var(--ui-bg) 28%);
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--ui-bg) 36%, #94a3b8 64%);
    transition: transform 0.14s ease, background-color 0.14s ease, box-shadow 0.14s ease;
}

.status-save-dot-button.is-dirty .status-save-dot {
    background: #f59e0b;
    box-shadow: 0 0 0 1px color-mix(in oklab, #f59e0b 55%, #78350f 45%);
}

.status-save-dot-button.is-clean .status-save-dot {
    background: #16a34a;
    box-shadow: 0 0 0 1px color-mix(in oklab, #16a34a 58%, #14532d 42%);
}

.status-save-dot-button.is-saving .status-save-dot {
    background: #2563eb;
    box-shadow: 0 0 0 1px color-mix(in oklab, #2563eb 58%, #1e3a8a 42%);
    animation: status-save-dot-pulse 1s ease-in-out infinite;
}

.status-save-dot-button.is-actionable:hover .status-save-dot {
    transform: scale(1.15);
}

@keyframes status-save-dot-pulse {
    0%,
    100% {
        transform: scale(1);
        opacity: 1;
    }

    50% {
        transform: scale(1.15);
        opacity: 0.72;
    }
}

.sidebar-resizer {
    width: 8px;
    cursor: col-resize;
    position: relative;
    flex-shrink: 0;
    user-select: none;
    touch-action: none;
    background: color-mix(in oklab, var(--ui-bg) 80%, var(--ui-border) 20%);
    transition: background-color 0.15s ease;
}

.sidebar-resizer:hover,
.sidebar-resizer.is-active {
    background: color-mix(in oklab, var(--ui-bg) 50%, var(--ui-primary) 50%);
}

/* Empty state layout */
.empty-state {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    gap: 1rem;
    padding: clamp(1rem, 2.6vh, 1.8rem) clamp(1rem, 2.2vw, 2rem);
    overflow: auto;
}

.empty-state-hint {
    margin: 0;
    text-align: center;
}

/* Open file action button */
.open-file-action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin: 0 auto;
    padding: 1rem 1.5rem;
    border-radius: 0.5rem;
    border: 1px dashed var(--ui-border);
    background: transparent;
    cursor: pointer;
    transition: all 0.15s ease;
}

.open-file-action:hover {
    border-color: var(--ui-primary);
    background: color-mix(in oklab, var(--ui-bg) 95%, var(--ui-primary) 5%);
}

.open-file-action:hover :deep(.iconify) {
    color: var(--ui-primary);
}

.open-file-action:active {
    transform: scale(0.98);
}

/* Recent files */
.recent-files {
    width: min(100%, 640px);
    margin: 0 auto;
    min-height: 0;
}

.recent-files-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    padding: 0 0.5rem;
}

.recent-files-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: min(60vh, 34rem);
    overflow-y: auto;
}

.recent-file-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: background-color 0.15s ease;
}

.recent-file-item:hover {
    background: var(--ui-bg-elevated);
}

.recent-file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.recent-file-name {
    color: var(--ui-text);
    font-size: 0.875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.recent-file-path {
    font-size: 0.7rem;
    color: var(--ui-text-dimmed);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.recent-file-time {
    font-size: 0.7rem;
    color: var(--ui-text-muted);
    flex-shrink: 0;
    margin-left: auto;
}

.recent-file-remove {
    opacity: 0;
    transition: opacity 0.15s ease;
}

.recent-file-item:hover .recent-file-remove {
    opacity: 1;
}

.annotation-context-menu {
    position: fixed;
    z-index: 70;
    min-width: 246px;
    display: grid;
    gap: 1px;
    border: 1px solid var(--ui-border);
    background: var(--ui-border);
    box-shadow:
        0 10px 24px rgb(15 23 42 / 20%),
        0 3px 8px rgb(15 23 42 / 15%);
}

.annotation-context-menu__section-title {
    margin: 0;
    padding: 0.45rem 0.6rem 0.35rem;
    background: color-mix(in oklab, var(--ui-bg, #fff) 94%, #e8eef8 6%);
    color: var(--ui-text-dimmed);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.35rem;
}

.annotation-context-menu__color-swatch {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 2px;
    flex-shrink: 0;
    border: 1px solid rgb(0 0 0 / 15%);
}

.annotation-context-menu__divider {
    height: 1px;
    background: color-mix(in oklab, var(--ui-border) 82%, #c7d2e6 18%);
}

.annotation-context-menu__action {
    text-align: left;
    border: none;
    background: var(--ui-bg, #fff);
    color: var(--ui-text);
    min-height: 2rem;
    padding: 0 0.6rem;
    cursor: pointer;
}

.annotation-context-menu__action:hover {
    background: color-mix(in oklab, var(--ui-bg, #fff) 93%, var(--ui-primary) 7%);
}

.annotation-context-menu__action:disabled {
    color: var(--ui-text-dimmed);
    cursor: default;
    background: color-mix(in oklab, var(--ui-bg, #fff) 96%, #f3f6fb 4%);
}

.annotation-context-menu__action--danger {
    color: #b42318;
}
</style>
