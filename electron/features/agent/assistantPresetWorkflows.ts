import {
    AGENT_ASSISTANT_PRESET_IDS,
    type TAgentAssistantPresetId,
} from '@contracts/agent';
import { isOneOf } from '@contracts/runtimeGuards';

// Universal, edge-case-aware workflows shared by the MCP prompts (prompts/get) and the
// in-app assistant preset chips. Each workflow is a decision tree the model follows so a
// single preset button works regardless of the document's current state.

export const ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW = [
    'Before any multi-page metadata write, inspect the current metadata and relevant document evidence, then run the matching read-only preview and examine its normalized result, issues, and diff. Do not call evb_run_action for the write until that inspection and preview have completed, even when the user explicitly asked to apply the edit.',
    'Resolve user terms with EVB Viewer semantics. If the request still permits materially different results after read-only inspection, ask one focused clarification and stop; never choose the larger or more destructive interpretation.',
    'A plan stated in chat is not a preview. Never say a preview, write, save, or verification happened unless the corresponding tool completed and, for writes, a follow-up read confirmed the new state.',
    'If a write tool or file.save returns an error or times out after it may have changed the document, re-read the target state and dirty state before retrying. If the desired change is present, or the document is no longer dirty after file.save, do not repeat the action.',
    'If file.save succeeds but reports pendingChangesAfterSave, the completed save persisted the earlier changes while newer edits remain dirty. Report the pending edits and do not automatically save again.',
].join('\n');

export const ASSISTANT_LARGE_DOCUMENT_WORKFLOW = [
    'Handle the active document as a large or hard document: thousands of pages, scans, dictionaries, weak OCR, missing TOC, or slow global text coverage.',
    'Start with evb_workspace_snapshot and document.open_documents/readiness to get tab id, physical page count, current page, document kind, and readiness hints. If the document is very large, do not begin with full document.inspect_text unless the user specifically needs global OCR coverage.',
    'Use bounded probes first: document.read_pages for only the current page, likely TOC pages, front/body transition pages, tail pages, or pages found by a narrow search. When calling document.search on a large PDF, include pages or startPage/endPage (for example front matter 1-40 or a small sampled range) instead of starting with an unbounded whole-document search. Treat textStatus.coverageScope = requested-pages as local evidence, not global coverage. A blank cover/current page or a timed-out broad probe is inconclusive; sample non-cover/front/body/tail pages before recommending OCR. If any sampled page has embedded text, continue with text/search probes instead of OCR-all-pages unless the user specifically needs complete text coverage. If page text is empty, ambiguous, or visually important, use document.capture_page_image on the same page or a normalized crop.',
    'For dictionaries, grammars, catalogs, and other reference books, build structure from samples: cover/title pages, alphabet or chapter starts, running heads, printed page labels, first/last entries, and a few evenly spaced pages. Prefer multiple small probes over one broad scan.',
    'For page labels, infer offsets from sampled visible folios before previewing ranges; avoid asking for every materialized label on huge documents. For bookmarks, read existing TOC/bookmarks when cheap, otherwise derive a candidate outline from verified samples and add only destinations whose page or pageYRatio is proven by text or image evidence.',
    'If any global operation times out or returns partial evidence, continue with targeted read_pages/search/image probes and report the limitation. Recommend OCR all pages only when the task truly needs reliable full-document text or multiple meaningful sampled pages have no embedded text, and never pretend that sampled evidence proves complete coverage.',
].join('\n');

export const ASSISTANT_BOOKMARK_WORKFLOW = [
    'Build or correct PDF bookmarks for the active document, whatever its current state.',
    ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW,
    'Bookmarks must represent meaningful document sections. In bookmark requests, "flat" means one hierarchy level of semantic entries, not one bookmark per page or page-number bookmarks. Create page-by-page bookmarks only when the user explicitly asks for them.',
    'Read evb://document/{tabId}/bookmarks once. Its version 2 response contains the bookmarks tree and flat paths; the legacy /toc URI returns the same tree under toc, named by treeField. For small or already-indexed documents, inspect text coverage with document.inspect_text; for very large documents, scans, or previous timeouts, follow the large-document bounded-probe workflow instead. A blank first page or timed-out coverage pass is not enough evidence to recommend OCR; sample likely non-cover/front/body pages with document.read_pages and proceed with search/read-pages if any sampled page has text. Use the flat path list to preserve or extend existing TOC/bookmark nodes; treat existing destinations as hints, not proof.',
    'Choose the outline source in this order: (1) a user-supplied outline if one was given; (2) the embedded TOC/bookmarks; (3) a printed contents page inside the document, located with bounded document.search queries such as "contents" or "table of contents" over likely front-matter pages and read with document.read_pages; (4) if none exist, derive the structure yourself from chapter/section starts, heading patterns, numbered headings, and running heads sampled across the document.',
    'Locate section starts with document.search and document.read_pages, but on large PDFs always search small page ranges or explicit page samples first. Resolve the printed-number vs physical-page offset using evb://document/{tabId}/page-labels so each destination points to the correct physical page and, when a heading starts below the top of that page, a pageYRatio anchor from 0 to 1.',
    'For doubtful title/page matches, duplicated or ambiguous headings, wrong-looking offsets, or OCR gaps, call document.capture_page_image through evb_run_action on candidate pages or crops and inspect the visible page before writing. If multiple meaningful sampled pages have no searchable text, say OCR is recommended instead of guessing.',
    'For dictionaries and other alphabetized reference works, do not apply a visibly partial sibling alphabet just because those are the only sampled starts you verified. Before writing letter-level bookmarks, probe the missing expected letters/ranges for that language or script; then either apply a complete expected sequence with verified destinations, apply coarser verified range bookmarks, or keep only high-level part bookmarks and explain which letter starts still need verification. Never silently omit middle letters from one alphabet direction while presenting the outline as complete.',
    'Infer a sane hierarchy (parts > chapters > sections) and a reasonable depth. When adding children under existing lesson/chapter bookmarks, prefer bookmarks.add_batch with the parentPath from the flat list instead of replacing the whole tree. Never create direct child bookmarks that reuse the exact destination of their parent; if a printed contents page only proves membership but not the child start position, omit those children or keep them in the response text until document.search/read_pages/capture_page_image can prove a distinct page or pageYRatio anchor. When the user asks for styled or visually distinguished bookmarks, set bold, italic, or color per entry when adding them (for example bold for parts and chapters, italic for front and back matter, one color for appendices), and restyle existing entries with bookmarks.set_style by paths, an inclusive sibling range, or depth/level instead of rewriting the tree. Do not add styling the user did not ask for.',
    'Call bookmarks.preview_tree through evb_read_action for full-tree changes, or use bookmarks.read before and after add/update calls for incremental changes. Inspect the normalized tree, flat path list, pageYRatio values, issues, and diff, then commit with bookmarks.apply_plan or bookmarks.add_batch through evb_run_action. If evb_run_action reports confirmation required, denied, or unavailable, no bookmarks were changed: report the preview tree and ask for a grant or manual apply. Re-read bookmarks and save with file.save only after a verified write.',
].join('\n');

export const ASSISTANT_PAGE_NUMBER_WORKFLOW = [
    'Reconstruct the PDF page labels to match the document\'s real numbering, whatever scheme it uses.',
    ASSISTANT_DOCUMENT_EDIT_SAFETY_WORKFLOW,
    'In page-numbering requests, "number pages" means setting PDF page labels to match the document\'s visible printed numbering, not physical page indexes 1 through N. Use physical indexes only when the user explicitly asks for physical numbering.',
    'Read evb://document/{tabId}/page-labels. For small or already-indexed documents, inspect text coverage with document.inspect_text; for very large documents, scans, or previous timeouts, use bounded document.read_pages and document.capture_page_image probes instead of a full coverage pass. Use searchable/OCR text as evidence but never trust it blindly.',
    'Sample the cover, the front-matter/body transition, any appendix/plate/insert sections, and the end. Detect and combine schemes as needed: roman front matter (i, ii, iii), arabic body, restarted numbering, alphabetic or prefixed labels (A, A-1), and unnumbered covers, plates, or blanks. Determine the offset for each range by finding which physical page carries each printed number.',
    'For every uncertain boundary, restart, or suspicious OCR result (l vs 1, O vs 0, missing folios), call document.capture_page_image through evb_run_action with top/bottom or normalized crops where folios sit and inspect the image before deciding.',
    'Call page_labels.preview through evb_read_action with ranges, inclusive segments, or explicit labels, and inspect the normalized segments, samples, issues, and changed-page diff. Commit with page_labels.apply_plan through evb_run_action. If evb_run_action reports confirmation required, denied, or unavailable, no labels were changed: report the preview plan and ask for a grant or manual apply. Re-read page labels and save with file.save only after a verified write.',
].join('\n');

export const ASSISTANT_OCR_READINESS_WORKFLOW = [
    'Check whether the active EVB Viewer document is ready for agent analysis.',
    'Use evb_workspace_snapshot and evb_read_action with document.open_documents or document.readiness first.',
    'For ordinary PDFs, call document.inspect_text through evb_read_action to compute searchable text coverage. For very large, slow, or scanned PDFs, start with bounded document.read_pages samples and page images; only run full inspect_text when global coverage is worth the cost. A blank cover/current page or timed-out broad probe is inconclusive; sample meaningful non-cover pages before recommending OCR.',
    'If verified full-document coverage is partial/none, or multiple meaningful bounded samples have no text, explain that running OCR on all pages is recommended. If any sampled page has embedded text, report that text exists and use search/read_pages for targeted work instead of recommending OCR-all-pages by default. If the document is DjVu or an image, recommend converting to PDF first.',
].join('\n');

const ASSISTANT_PRESET_INSTRUCTIONS: Record<TAgentAssistantPresetId, string> = {
    'add-bookmarks': ASSISTANT_BOOKMARK_WORKFLOW,
    'number-pages': ASSISTANT_PAGE_NUMBER_WORKFLOW,
    'check-ocr-readiness': ASSISTANT_OCR_READINESS_WORKFLOW,
};

export function resolveAssistantPresetInstructions(presetId: string | null | undefined) {
    if (!isOneOf(AGENT_ASSISTANT_PRESET_IDS, presetId)) {
        return null;
    }
    return ASSISTANT_PRESET_INSTRUCTIONS[presetId];
}
