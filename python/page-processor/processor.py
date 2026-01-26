"""
Core Page Processor

Orchestrates the processing pipeline for scanned book pages.
"""

import cv2
import numpy as np
import os
import time
from pathlib import Path
from typing import Callable, Optional

from detection import (
    detect_facing_pages,
    detect_skew_angle,
    detect_curvature,
    detect_content_bounds,
)
from split import find_gutter_position, split_facing_pages
from deskew_wrapper import deskew_page
from crop import crop_to_content


class PageProcessor:
    """
    Main processor for scanned book pages.

    Handles the full pipeline of:
    1. Loading image
    2. Detection (facing pages, skew, curvature, content bounds)
    3. Processing (split, deskew, dewarp, crop)
    4. Saving results
    """

    def __init__(
        self,
        min_skew_angle: float = 0.5,
        min_curvature: float = 0.1,
        crop_padding: int = 30,
        auto_detect: bool = True,
        force_split: bool = False,
    ):
        self.min_skew_angle = min_skew_angle
        self.min_curvature = min_curvature
        self.crop_padding = crop_padding
        self.auto_detect = auto_detect
        self.force_split = force_split

    def process(
        self,
        input_path: str,
        output_dir: str,
        operations: list[str],
        progress_callback: Optional[Callable[[dict], None]] = None,
    ) -> dict:
        """
        Process a single page image.

        Args:
            input_path: Path to input image
            output_dir: Directory for output files
            operations: List of operations to perform
            progress_callback: Function to call with progress updates

        Returns:
            Dictionary with results and metadata
        """
        def progress(stage: str, message: str, **kwargs):
            if progress_callback:
                progress_callback({
                    "stage": stage,
                    "message": message,
                    **kwargs,
                })

        timings_ms: dict = {}
        total_start = time.monotonic()

        # Load image
        load_start = time.monotonic()
        progress("loading", f"Loading {input_path}")
        image = cv2.imread(input_path)
        if image is None:
            raise ValueError(f"Failed to load image: {input_path}")
        timings_ms["load"] = int((time.monotonic() - load_start) * 1000)

        original_height, original_width = image.shape[:2]
        input_stem = Path(input_path).stem

        # PNG compression is lossless; lower values speed up saves dramatically on large pages.
        try:
            png_compression = int(os.environ.get("PAGE_PROCESSOR_PNG_COMPRESSION", "1"))
        except Exception:
            png_compression = 1
        png_compression = max(0, min(9, png_compression))

        # Detection phase
        detect_start = time.monotonic()
        progress("detecting", "Analyzing page characteristics")
        detection = {
            "was_facing_pages": False,
            "skew_angle": 0.0,
            "curvature_score": 0.0,
            "content_bounds": None,
        }

        detect_breakdown: dict = {}

        if 'split' in operations and self.auto_detect:
            t0 = time.monotonic()
            detection["was_facing_pages"] = detect_facing_pages(image)
            detect_breakdown["facing_pages"] = int((time.monotonic() - t0) * 1000)

        if 'deskew' in operations:
            t0 = time.monotonic()
            detection["skew_angle"] = detect_skew_angle(image)
            detect_breakdown["skew_angle"] = int((time.monotonic() - t0) * 1000)

        if 'dewarp' in operations:
            t0 = time.monotonic()
            detection["curvature_score"] = detect_curvature(image)
            detect_breakdown["curvature_score"] = int((time.monotonic() - t0) * 1000)

        if 'crop' in operations:
            t0 = time.monotonic()
            detection["content_bounds"] = detect_content_bounds(image)
            detect_breakdown["content_bounds"] = int((time.monotonic() - t0) * 1000)

        timings_ms["detect"] = {
            "total": int((time.monotonic() - detect_start) * 1000),
            **detect_breakdown,
        }

        # Processing phase
        pages = [image]
        operations_applied = []
        split_debug: Optional[dict] = None

        # 1. Split facing pages
        split_start = time.monotonic()
        should_split = False
        if 'split' in operations:
            if self.force_split:
                should_split = True
                detection["was_facing_pages"] = True
            elif self.auto_detect and detection["was_facing_pages"]:
                should_split = True

        if should_split:
            progress("splitting", "Splitting facing pages")
            gutter_x = find_gutter_position(image)
            left, right = split_facing_pages(image, gutter_x=gutter_x)
            pages = [left, right]
            operations_applied.append("split")
            split_debug = {
                "gutter_x": int(gutter_x),
                "gutter_x_norm": float(gutter_x) / float(max(1, original_width)),
                "left_size": {"width": int(left.shape[1]), "height": int(left.shape[0])},
                "right_size": {"width": int(right.shape[1]), "height": int(right.shape[0])},
            }

            # Optional debug overlay to validate gutter detection visually.
            if os.environ.get("PAGE_PROCESSOR_DEBUG_SPLIT"):
                try:
                    overlay = image.copy()
                    thickness = max(2, int(round(original_width / 1200)))
                    cv2.line(overlay, (int(gutter_x), 0), (int(gutter_x), original_height - 1), (0, 0, 255), thickness)
                    debug_path = Path(output_dir) / f"{input_stem}__debug_split.png"
                    cv2.imwrite(
                        str(debug_path),
                        overlay,
                        [cv2.IMWRITE_PNG_COMPRESSION, png_compression],
                    )
                    split_debug["debug_overlay_path"] = str(debug_path)
                except Exception:
                    # Debug outputs are best-effort only.
                    pass
        timings_ms["split"] = int((time.monotonic() - split_start) * 1000)

        # Process each page (may be 1 or 2 after splitting)
        deskew_start = time.monotonic()
        processed_pages: list[np.ndarray] = []
        deskew_debug: list[dict] = []
        for i, page in enumerate(pages):
            page_suffix = f"_{i+1}" if len(pages) > 1 else ""

            # 2. Deskew
            if 'deskew' in operations:
                # IMPORTANT:
                # If we split a spread, each half can have different "best" skew angle. Using the
                # whole-spread angle tends to over-rotate one side (often near the gutter), which
                # looks like a wrong/warped deskew. So we detect skew per output page after split.
                if len(pages) > 1:
                    page_skew = float(detect_skew_angle(page) or 0.0)
                else:
                    page_skew = float(detection.get("skew_angle") or 0.0)

                if abs(page_skew) >= self.min_skew_angle:
                    progress("deskewing", f"Deskewing page{page_suffix} by {page_skew:.2f}°")
                    page = deskew_page(page, page_skew)
                    if 'deskew' not in operations_applied:
                        operations_applied.append("deskew")
                    deskew_debug.append({"page_index": i + 1, "angle": float(page_skew), "applied": True})
                else:
                    deskew_debug.append({"page_index": i + 1, "angle": float(page_skew), "applied": False})

            # 3. Dewarp
            if 'dewarp' in operations:
                # Import lazily; page_dewarp pulls heavy deps (matplotlib/sympy) and should not
                # impact non-dewarp runs.
                from dewarp import dewarp_page

                curvature = float(detection.get("curvature_score") or 0.0)
                if curvature >= self.min_curvature:
                    progress("dewarping", f"Dewarping page{page_suffix}")
                    page = dewarp_page(page)
                    if 'dewarp' not in operations_applied:
                        operations_applied.append("dewarp")

            processed_pages.append(page)
        timings_ms["deskew_dewarp"] = int((time.monotonic() - deskew_start) * 1000)

        crop_start = time.monotonic()
        if 'crop' in operations:
            if len(processed_pages) == 1:
                progress("cropping", "Cropping page")
                bounds = detect_content_bounds(processed_pages[0])
                if bounds:
                    processed_pages[0] = crop_to_content(processed_pages[0], bounds, padding=self.crop_padding)
                    if 'crop' not in operations_applied:
                        operations_applied.append("crop")
            else:
                # When splitting, avoid asymmetric "content crop" that can cut one half differently
                # and/or remove information near the gutter. We:
                # - unify top/bottom crop between halves
                # - crop only on the *outer* edges (left edge of left page, right edge of right page)
                bounds_list = [detect_content_bounds(p) for p in processed_pages]
                valid_bounds = [b for b in bounds_list if b]
                if valid_bounds:
                    y1 = min(int(b["y"]) for b in valid_bounds)
                    y2 = max(int(b["y"] + b["height"]) for b in valid_bounds)
                    pad = int(self.crop_padding)

                    cropped_pages: list[np.ndarray] = []
                    for i, page in enumerate(processed_pages):
                        b = bounds_list[i]
                        if not b:
                            cropped_pages.append(page)
                            continue

                        ph, pw = page.shape[:2]
                        y1p = max(0, y1 - pad)
                        y2p = min(ph, y2 + pad)

                        # Preserve the gutter-side edge to avoid cutting inner content.
                        if i == 0:
                            x1 = max(0, int(b["x"]) - pad)
                            x2 = pw
                        else:
                            x1 = 0
                            x2 = min(pw, int(b["x"] + b["width"]) + pad)

                        if x2 <= x1 or y2p <= y1p:
                            cropped_pages.append(page)
                            continue

                        cropped_pages.append(page[y1p:y2p, x1:x2].copy())

                    processed_pages = cropped_pages
                    if 'crop' not in operations_applied:
                        operations_applied.append("crop")
        timings_ms["crop"] = int((time.monotonic() - crop_start) * 1000)

        # Normalize page sizes after splitting:
        # pad to the largest width/height (no scaling) and center the content.
        normalize_start = time.monotonic()
        if len(processed_pages) > 1:
            target_w = max(int(p.shape[1]) for p in processed_pages)
            target_h = max(int(p.shape[0]) for p in processed_pages)

            normalized: list[np.ndarray] = []
            for page in processed_pages:
                ph, pw = page.shape[:2]
                if pw == target_w and ph == target_h:
                    normalized.append(page)
                    continue

                if len(page.shape) == 3:
                    canvas = np.full((target_h, target_w, 3), 255, dtype=np.uint8)
                else:
                    canvas = np.full((target_h, target_w), 255, dtype=np.uint8)

                x_off = max(0, (target_w - pw) // 2)
                y_off = max(0, (target_h - ph) // 2)

                canvas[y_off:y_off + ph, x_off:x_off + pw] = page
                normalized.append(canvas)

            processed_pages = normalized
        timings_ms["normalize"] = int((time.monotonic() - normalize_start) * 1000)

        # Save outputs
        save_start = time.monotonic()
        output_paths = []
        output_sizes = []
        for i, page in enumerate(processed_pages):
            page_suffix = f"_{i+1}" if len(processed_pages) > 1 else ""
            output_filename = f"{input_stem}{page_suffix}.png"
            output_path = Path(output_dir) / output_filename

            progress("saving", f"Saving {output_filename}")
            cv2.imwrite(
                str(output_path),
                page,
                [cv2.IMWRITE_PNG_COMPRESSION, png_compression],
            )
            output_paths.append(str(output_path))
            ph, pw = page.shape[:2]
            output_sizes.append({"width": int(pw), "height": int(ph)})
        timings_ms["save"] = int((time.monotonic() - save_start) * 1000)

        return {
            "success": True,
            "input_path": input_path,
            "output_paths": output_paths,
            "output_sizes": output_sizes,
            "operations_applied": operations_applied,
            "detection": detection,
            "split_debug": split_debug,
            "deskew_debug": deskew_debug if 'deskew' in operations else None,
            "original_size": {
                "width": original_width,
                "height": original_height,
            },
            "timings_ms": {
                **timings_ms,
                "total": int((time.monotonic() - total_start) * 1000),
            },
        }
