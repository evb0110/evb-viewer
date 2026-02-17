<script setup lang="ts">
const repositoryUrl = 'https://github.com/evb0110/evb-viewer';

const bookmarks = [
    {
        id: 'workspace-overview',
        title: 'Workspace overview', 
    },
    {
        id: 'unsigned-installation',
        title: 'Installing unsigned builds', 
    },
    {
        id: 'open-and-combine',
        title: 'Open and combine files', 
    },
    {
        id: 'tabs-and-splits',
        title: 'Tabs and split editor', 
    },
    {
        id: 'window-management',
        title: 'Window management', 
    },
    {
        id: 'pages-panel',
        title: 'Pages panel and ordering', 
    },
    {
        id: 'annotations-notes',
        title: 'Annotations and notes', 
    },
    {
        id: 'bookmarks-panel',
        title: 'Bookmarks panel', 
    },
    {
        id: 'search-navigation',
        title: 'Search and navigation', 
    },
    {
        id: 'ocr-export',
        title: 'OCR and exports', 
    },
    {
        id: 'menus-shortcuts',
        title: 'Menus and shortcuts', 
    },
    {
        id: 'license',
        title: 'License', 
    },
];

const shortcuts = [
    {
        action: 'Open file',
        keys: 'Cmd/Ctrl + O', 
    },
    {
        action: 'Save',
        keys: 'Cmd/Ctrl + S', 
    },
    {
        action: 'Save As',
        keys: 'Cmd/Ctrl + Shift + S', 
    },
    {
        action: 'Export DOCX',
        keys: 'Cmd/Ctrl + Shift + E', 
    },
    {
        action: 'New tab',
        keys: 'Cmd/Ctrl + T', 
    },
    {
        action: 'Close tab',
        keys: 'Cmd/Ctrl + W', 
    },
    {
        action: 'Undo',
        keys: 'Cmd/Ctrl + Z', 
    },
    {
        action: 'Redo',
        keys: 'Cmd + Shift + Z (macOS) / Ctrl + Y (Windows/Linux)', 
    },
    {
        action: 'Zoom in',
        keys: 'Cmd/Ctrl + =', 
    },
    {
        action: 'Zoom out',
        keys: 'Cmd/Ctrl + -', 
    },
    {
        action: 'Actual size',
        keys: 'Cmd/Ctrl + 0', 
    },
    {
        action: 'Fit width',
        keys: 'Cmd/Ctrl + 1', 
    },
    {
        action: 'Fit height',
        keys: 'Cmd/Ctrl + 2', 
    },
    {
        action: 'Split editor right',
        keys: 'Cmd/Ctrl + \\', 
    },
    {
        action: 'Find in document',
        keys: 'Cmd/Ctrl + F', 
    },
    {
        action: 'Cycle tabs',
        keys: 'Ctrl + Tab / Ctrl + Shift + Tab', 
    },
];

const menuMap = [
    {
        menu: 'File',
        actions: 'Open File, Open Recent, Save, Save As, Export DOCX/Images/TIFF, Convert to PDF, New Tab, Close Tab',
    },
    {
        menu: 'Actions',
        actions: 'Undo, Redo, Copy',
    },
    {
        menu: 'Pages',
        actions: 'Delete selected pages, extract selected pages, rotate, insert pages',
    },
    {
        menu: 'View',
        actions: 'Zoom controls, fit modes, page layout modes, split/focus/move/copy editor groups',
    },
    {
        menu: 'Window',
        actions: 'Move active tab to new window, move active tab to another window, merge this window into',
    },
    {
        menu: 'Help',
        actions: 'About EVB Viewer',
    },
];

useSeoMeta({
    title: 'Documentation',
    ogTitle: 'EVB Viewer Documentation',
    ogDescription: 'End-user guide for EVB Viewer workspace, menus, editing tools, and export workflows.',
});

function scrollToBookmark(id: string): void {
    document.getElementById(id)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
    });
    window.history.replaceState(null, '', `#${id}`);
}
</script>

<template>
  <div>
    <div class="docs-layout section-reveal">
      <aside class="docs-bookmark-column">
        <UCard class="docs-bookmark-card">
          <p class="bookmark-title">
            Bookmarks
          </p>
          <nav class="bookmark-nav">
            <button
              v-for="entry in bookmarks"
              :key="entry.id"
              type="button"
              class="bookmark-link"
              @click="scrollToBookmark(entry.id)"
            >
              {{ entry.title }}
            </button>
          </nav>
          <UButton
            label="Repository"
            :to="repositoryUrl"
            target="_blank"
            icon="i-simple-icons-github"
            color="neutral"
            variant="outline"
          />
        </UCard>
      </aside>

      <main class="docs-main">
        <section
          id="workspace-overview"
          class="docs-section"
        >
          <h2>Workspace overview</h2>
          <p>
            EVB Viewer is a desktop document workspace for PDFs and DjVu files with OCR, annotations, page
            operations, split views, and export tools.
          </p>
          <ul class="docs-list">
            <li>Top: tab bar for opening, reordering, splitting, and moving tabs.</li>
            <li>Under tabs: toolbar for save, export, OCR, zoom, selection/hand mode, and settings.</li>
            <li>Center: document viewer with single page or facing layouts.</li>
            <li>Left sidebar: annotations, pages, bookmarks, and search panels.</li>
            <li>Bottom status bar: file path, file size, zoom, save state, and "show in folder".</li>
          </ul>
        </section>

        <section
          id="unsigned-installation"
          class="docs-section"
        >
          <h2>Installing unsigned builds (all OSes)</h2>
          <p>
            EVB Viewer builds are currently unsigned. Download installers from the official GitHub releases page.
          </p>
          <ul class="docs-list">
            <li>Always install files published under <code>evb0110/evb-viewer</code> releases.</li>
            <li>If your OS shows a warning, use the per-platform override steps below.</li>
          </ul>
          <p><strong>macOS (DMG):</strong></p>
          <ul class="docs-list">
            <li>Open the DMG and drag EVB Viewer into Applications.</li>
            <li>On first launch, if macOS blocks the app, right-click the app and choose <code>Open</code>.</li>
            <li>If needed: System Settings > Privacy &amp; Security, then click <code>Open Anyway</code>.</li>
          </ul>
          <p><strong>Windows (EXE):</strong></p>
          <ul class="docs-list">
            <li>Run the installer EXE from Downloads.</li>
            <li>If SmartScreen appears, click <code>More info</code>, then <code>Run anyway</code>.</li>
            <li>Complete setup, then start EVB Viewer from Start menu or desktop shortcut.</li>
          </ul>
          <p><strong>Linux (DEB):</strong></p>
          <ul class="docs-list">
            <li>Install with your package manager or double-click the DEB in your software center.</li>
            <li>CLI option: <code>sudo apt install ./evb-viewer-*.deb</code>.</li>
            <li>After install, launch EVB Viewer from your desktop app launcher.</li>
          </ul>
        </section>

        <section
          id="open-and-combine"
          class="docs-section"
        >
          <h2>Open and combine files</h2>
          <p>
            Use <code>File > Open File...</code> to open PDF, DjVu, and supported image files.
          </p>
          <ul class="docs-list">
            <li>Supported image types include PNG, JPG/JPEG, TIFF, BMP, WEBP, and GIF.</li>
            <li>You can select multiple PDFs/images at once. EVB Viewer merges them into one generated PDF.</li>
            <li>Generated file naming follows the first selected file, for example <code>report-combined.pdf</code>.</li>
            <li>If a document is already open, combined output opens in a new tab so current work stays intact.</li>
            <li><code>Open Recent</code> keeps history and includes a command to clear recent files.</li>
          </ul>
          <p>
            <code>File > Convert to PDF...</code> has two behaviors: in DjVu mode it opens DjVu conversion options;
            otherwise it opens file selection and creates a PDF from selected sources.
          </p>
        </section>

        <section
          id="tabs-and-splits"
          class="docs-section"
        >
          <h2>Tabs and split editor</h2>
          <p>
            Tabs support drag reordering, middle-click close, unsaved indicators, and contextual actions.
          </p>
          <ul class="docs-list">
            <li>Right-click a tab to open context commands for split, focus, move/copy tab, and window transfer.</li>
            <li><code>View > Editor Groups > Split Editor</code> splits right, left, up, or down.</li>
            <li>Split panes include a draggable divider so you can rebalance layout space.</li>
            <li><code>Focus Editor Group</code> switches active pane without moving files.</li>
            <li><code>Move Tab to Group</code> moves the tab; <code>Copy Tab to Group</code> duplicates the view state.</li>
          </ul>
        </section>

        <section
          id="window-management"
          class="docs-section"
        >
          <h2>Window management</h2>
          <p>
            EVB Viewer can move tabs between native windows and merge entire workspaces.
          </p>
          <ul class="docs-list">
            <li><code>Window > Move Active Tab to New Window</code> detaches the current tab.</li>
            <li><code>Window > Move Active Tab to Window</code> transfers the tab to another open EVB Viewer window.</li>
            <li><code>Window > Merge This Window Into</code> moves all tabs into a selected target window.</li>
            <li>When a transfer empties a source window, the source window closes automatically.</li>
            <li>Tab context menu includes per-tab move commands to another window.</li>
          </ul>
        </section>

        <section
          id="pages-panel"
          class="docs-section"
        >
          <h2>Pages panel and ordering</h2>
          <ul class="docs-list">
            <li>Click a thumbnail to jump to a page.</li>
            <li>Use <code>Shift</code> + click for range selection and <code>Cmd/Ctrl</code> + click for multi-select toggles.</li>
            <li>Selection toolbar supports rotate, extract to new PDF, export pages, delete, and quick deselect.</li>
            <li>Right-click selected thumbnails for page context actions: insert before/after, select all, invert selection.</li>
            <li>Drag thumbnails to reorder pages.</li>
            <li>Drop external files between thumbnails to insert pages directly into the document.</li>
          </ul>
        </section>

        <section
          id="annotations-notes"
          class="docs-section"
        >
          <h2>Annotations and notes</h2>
          <p>
            The annotations panel provides creation tools, style controls, and note management.
          </p>
          <ul class="docs-list">
            <li>Tools include free text, highlight, underline, strikethrough, rectangle, circle, line, and arrow.</li>
            <li>Style editor controls tool color, stroke/fill, thickness, and text sizing where relevant.</li>
            <li>Sticky notes can be created from selected text or placed at any position on a page.</li>
            <li>Notes list supports filtering, quick focus, copy text, and delete actions.</li>
            <li>Double-clicking a note opens its pop-up note window for focused editing.</li>
          </ul>
        </section>

        <section
          id="bookmarks-panel"
          class="docs-section"
        >
          <h2>Bookmarks panel</h2>
          <ul class="docs-list">
            <li>Display modes: top-level only, fully expanded, or current-path expanded.</li>
            <li>Edit mode enables bookmark creation, rename, sibling/child insertion, and deletion.</li>
            <li>Bookmark context actions include bold, italic, and custom text color.</li>
            <li>Style range lets you set style at a start bookmark and apply to a contiguous range.</li>
            <li>Drag and drop supports bookmark tree reordering.</li>
          </ul>
        </section>

        <section
          id="search-navigation"
          class="docs-section"
        >
          <h2>Search and navigation</h2>
          <ul class="docs-list">
            <li>Press <code>Cmd/Ctrl + F</code> to jump to the sidebar search tab.</li>
            <li>Search runs across pages and shows progress while indexing large documents.</li>
            <li>Use <code>Enter</code> for next match and <code>Shift + Enter</code> for previous match.</li>
            <li>Click any search result to go directly to that match in the document.</li>
            <li>Page dropdown controls fast page jumps and works with custom page labels.</li>
          </ul>
        </section>

        <section
          id="ocr-export"
          class="docs-section"
        >
          <h2>OCR and exports</h2>
          <p>
            OCR turns scanned documents into searchable PDFs and can drive DOCX export.
          </p>
          <ul class="docs-list">
            <li>OCR popup supports all pages, current page, or custom range modes.</li>
            <li>Language selection is grouped by script families for faster setup.</li>
            <li>You can cancel running OCR and monitor progress page-by-page.</li>
            <li>After OCR completes, the document is searchable and ready for text export.</li>
            <li><code>Export DOCX</code> is available from toolbar and OCR popup.</li>
            <li><code>Export Images...</code> and <code>Export Multi-page TIFF...</code> provide page scope selection (all/current/range/selected).</li>
            <li><code>Capture Region</code> copies a selected region to clipboard; press <code>Esc</code> to cancel capture mode.</li>
          </ul>
        </section>

        <section
          id="menus-shortcuts"
          class="docs-section"
        >
          <h2>Menus and shortcuts</h2>
          <UCard class="table-card">
            <div class="table-wrap">
              <table class="platform-table">
                <thead>
                  <tr>
                    <th scope="col">
                      Menu
                    </th>
                    <th scope="col">
                      What it controls
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in menuMap"
                    :key="row.menu"
                  >
                    <td>{{ row.menu }}</td>
                    <td>{{ row.actions }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </UCard>
          <UCard class="table-card">
            <div class="table-wrap">
              <table class="platform-table">
                <thead>
                  <tr>
                    <th scope="col">
                      Action
                    </th>
                    <th scope="col">
                      Shortcut
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="shortcut in shortcuts"
                    :key="shortcut.action"
                  >
                    <td>{{ shortcut.action }}</td>
                    <td>{{ shortcut.keys }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </UCard>
          <p>
            Most editing and layout controls are available both from menus and from tab/page context menus.
          </p>
          <p>
            For bugs and feature requests, see the project repository.
          </p>
        </section>

        <section
          id="license"
          class="docs-section"
        >
          <h2>License</h2>
          <p>MIT. Copyright © 2026 Eugene Barsky.</p>
        </section>
      </main>
    </div>
  </div>
</template>
