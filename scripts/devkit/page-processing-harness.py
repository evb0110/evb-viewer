#!/usr/bin/env python3
"""
Page Processing Harness (devkit)

Creates a small regression corpus from a PDF by rendering selected pages into
multiple "modes" (color/gray/mono/jpeg) at multiple DPIs, then runs the bundled
page-processor CLI and records split/deskew outputs + debug telemetry.

This is intentionally stdlib-only so it can run on any dev machine without
extra Python deps.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


RE_RANGE = re.compile(r"^\s*(\d+)\s*-\s*(\d+)\s*$")
RE_INT = re.compile(r"^\s*\d+\s*$")


def run(cmd: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def parse_pages(expr: str, max_page: int) -> list[int]:
    pages: set[int] = set()
    for part in (p.strip() for p in expr.split(",") if p.strip()):
        m = RE_RANGE.match(part)
        if m:
            a = int(m.group(1))
            b = int(m.group(2))
            lo, hi = (a, b) if a <= b else (b, a)
            for p in range(max(1, lo), min(max_page, hi) + 1):
                pages.add(p)
            continue
        if RE_INT.match(part):
            p = int(part)
            if 1 <= p <= max_page:
                pages.add(p)
            continue
        raise ValueError(f"Invalid pages expression part: {part!r}")
    return sorted(pages)


def pick_sample_pages(npages: int, sample: int, seed: int) -> list[int]:
    fixed = [1, 2, 3, 10, npages // 2, npages // 2 + 1, npages - 2, npages - 1, npages]
    pages = {p for p in fixed if 1 <= p <= npages}
    rng = random.Random(seed)
    remaining = [p for p in range(1, npages + 1) if p not in pages]
    if remaining and sample > 0:
        for p in rng.sample(remaining, k=min(sample, len(remaining))):
            pages.add(p)
    return sorted(pages)


def safe_stem(path: Path) -> str:
    # Keep it filesystem-friendly but still recognizable.
    s = path.stem
    s = re.sub(r"[^a-zA-Z0-9._-]+", "_", s).strip("_")
    return s or "document"


def now_tag() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


@dataclass(frozen=True)
class RenderVariant:
    name: str
    mode: str  # color|gray|mono|jpeg
    dpi: int
    jpeg_quality: int | None = None


def render_page(
    *,
    pdftoppm: str,
    pdf: Path,
    page: int,
    variant: RenderVariant,
    out_dir: Path,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir / f"p{page:04d}_r{variant.dpi}_{variant.name}"

    cmd = [pdftoppm, "-r", str(variant.dpi), "-f", str(page), "-l", str(page), "-singlefile"]

    if variant.mode == "gray":
        cmd += ["-gray", "-png"]
        out_path = base.with_suffix(".png")
    elif variant.mode == "mono":
        cmd += ["-mono", "-png"]
        out_path = base.with_suffix(".png")
    elif variant.mode == "jpeg":
        q = variant.jpeg_quality if variant.jpeg_quality is not None else 70
        cmd += ["-jpeg", "-jpegopt", f"quality={q}"]
        out_path = base.with_suffix(".jpg")
    else:
        cmd += ["-png"]
        out_path = base.with_suffix(".png")

    cmd += [str(pdf), str(base)]
    run(cmd)
    if not out_path.exists():
        # pdftoppm sometimes uses .jpeg extension; be flexible.
        alt = base.with_suffix(".jpeg")
        if alt.exists():
            return alt
        raise RuntimeError(f"pdftoppm did not produce expected output: {out_path}")
    return out_path


def extract_result_json(stdout_text: str) -> dict:
    # The processor prints multiple JSON lines; we want the `type=="result"` one.
    for line in reversed([l for l in stdout_text.splitlines() if l.strip()]):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict) and obj.get("type") == "result":
            return obj
    raise RuntimeError("No {type:'result'} JSON line found in processor output")


def run_processor(
    *,
    processor: str,
    image: Path,
    out_dir: Path,
    operations: list[str],
    force_split: bool,
    auto_detect: bool,
    debug_split_overlay: bool,
) -> tuple[dict, float]:
    out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        processor,
        "process",
        str(image),
        str(out_dir),
        "--operations",
        *operations,
    ]
    if force_split:
        cmd.append("--force-split")
    if not auto_detect:
        cmd.append("--no-auto-detect")

    env = os.environ.copy()
    if debug_split_overlay:
        env["PAGE_PROCESSOR_DEBUG_SPLIT"] = "1"

    t0 = time.perf_counter()
    proc = subprocess.run(
        cmd,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    t1 = time.perf_counter()
    result = extract_result_json(proc.stdout)
    # Persist stdout/stderr alongside artifacts for debugging.
    (out_dir / "stdout.log").write_text(proc.stdout, encoding="utf-8")
    (out_dir / "stderr.log").write_text(proc.stderr, encoding="utf-8")
    return result, (t1 - t0)


def main() -> int:
    ap = argparse.ArgumentParser(description="Run page-processing regression harness (devkit)")
    ap.add_argument("pdf", type=Path, help="Path to PDF file")
    ap.add_argument("--out", type=Path, default=None, help="Output directory (default: .devkit/tmp/pp-harness/...)")
    ap.add_argument("--pages", type=str, default="", help="Pages to render, e.g. '1-3,10,50' (default: sample)")
    ap.add_argument("--sample", type=int, default=8, help="Random sample pages (only when --pages is not set)")
    ap.add_argument("--seed", type=int, default=1337, help="Seed for random sampling")
    ap.add_argument("--dpis", type=str, default="300", help="Comma-separated DPIs, e.g. '150,300,450'")
    ap.add_argument(
        "--modes",
        type=str,
        default="color,gray,mono",
        help="Comma-separated modes: color,gray,mono,jpeg (jpeg uses --jpeg-quality)",
    )
    ap.add_argument("--jpeg-quality", type=int, default=70, help="JPEG quality when mode includes jpeg")
    ap.add_argument("--operations", type=str, default="split,deskew", help="Comma-separated ops for processor")
    ap.add_argument("--force-split", action="store_true", help="Force split even when not detected as facing pages")
    ap.add_argument("--no-auto-detect", action="store_true", help="Disable auto-detect (usually use with --force-split)")
    ap.add_argument("--no-debug-split-overlay", action="store_true", help="Disable debug overlay image output")
    ap.add_argument(
        "--processor",
        type=str,
        default="resources/page-processing/darwin-arm64/bin/page-processor/page-processor",
        help="Path to page-processor binary",
    )
    ap.add_argument("--pdftoppm", type=str, default="pdftoppm", help="pdftoppm binary")
    ap.add_argument("--qpdf", type=str, default="qpdf", help="qpdf binary")

    args = ap.parse_args()

    pdf = args.pdf.resolve()
    if not pdf.exists():
        ap.error(f"PDF not found: {pdf}")

    processor = Path(args.processor).resolve()
    if not processor.exists():
        ap.error(f"page-processor not found: {processor}")

    # Determine page count.
    try:
        npages_out = run([args.qpdf, "--show-npages", str(pdf)]).stdout.strip()
        npages = int(npages_out)
    except Exception as e:
        ap.error(f"Failed to determine page count via qpdf: {e}")
        return 2

    if args.out:
        out_root = args.out
    else:
        out_root = Path(".devkit/tmp/pp-harness") / f"{now_tag()}_{safe_stem(pdf)}"
    out_root.mkdir(parents=True, exist_ok=True)

    # Pages
    if args.pages.strip():
        pages = parse_pages(args.pages, npages)
    else:
        pages = pick_sample_pages(npages, args.sample, args.seed)
    if not pages:
        ap.error("No pages selected")

    # Variants
    try:
        dpis = [int(x.strip()) for x in args.dpis.split(",") if x.strip()]
    except Exception:
        ap.error(f"Invalid --dpis: {args.dpis!r}")
    if not dpis:
        ap.error("No DPIs specified")

    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    if not modes:
        ap.error("No modes specified")

    variants: list[RenderVariant] = []
    for dpi in dpis:
        for mode in modes:
            if mode == "jpeg":
                variants.append(RenderVariant(name=f"jpeg{args.jpeg_quality}", mode="jpeg", dpi=dpi, jpeg_quality=args.jpeg_quality))
            elif mode in ("color", "gray", "mono"):
                variants.append(RenderVariant(name=mode, mode=mode, dpi=dpi))
            else:
                ap.error(f"Unknown mode: {mode!r}")

    operations = [o.strip() for o in args.operations.split(",") if o.strip()]
    if not operations:
        ap.error("No operations specified")

    auto_detect = not args.no_auto_detect
    debug_overlay = not args.no_debug_split_overlay

    render_dir = out_root / "render"
    runs_dir = out_root / "runs"
    summary_path = out_root / "summary.ndjson"

    summary_f = summary_path.open("w", encoding="utf-8")
    try:
        # Header meta as first line (easy to parse).
        summary_f.write(json.dumps({
            "type": "meta",
            "pdf": str(pdf),
            "npages": npages,
            "pages": pages,
            "variants": [v.__dict__ for v in variants],
            "operations": operations,
            "force_split": bool(args.force_split),
            "auto_detect": bool(auto_detect),
            "debug_split_overlay": bool(debug_overlay),
        }) + "\n")

        for page in pages:
            for v in variants:
                img = render_page(
                    pdftoppm=args.pdftoppm,
                    pdf=pdf,
                    page=page,
                    variant=v,
                    out_dir=render_dir / f"p{page:04d}",
                )

                run_dir = runs_dir / f"p{page:04d}" / f"r{v.dpi}" / v.name
                try:
                    result, wall_s = run_processor(
                        processor=str(processor),
                        image=img,
                        out_dir=run_dir,
                        operations=operations,
                        force_split=bool(args.force_split),
                        auto_detect=bool(auto_detect),
                        debug_split_overlay=bool(debug_overlay),
                    )
                    split_debug = result.get("split_debug") or {}
                    summary_f.write(json.dumps({
                        "type": "run",
                        "page": page,
                        "variant": v.__dict__,
                        "input_image": str(img),
                        "out_dir": str(run_dir),
                        "wall_s": wall_s,
                        "success": bool(result.get("success", False)),
                        "was_facing_pages": bool((result.get("detection") or {}).get("was_facing_pages", False)),
                        "output_count": len(result.get("output_paths") or []),
                        "gutter_x_norm": split_debug.get("gutter_x_norm"),
                        "gutter_x": split_debug.get("gutter_x"),
                        "left_size": split_debug.get("left_size"),
                        "right_size": split_debug.get("right_size"),
                        "timings_ms": result.get("timings_ms"),
                    }) + "\n")
                except Exception as e:
                    summary_f.write(json.dumps({
                        "type": "run",
                        "page": page,
                        "variant": v.__dict__,
                        "input_image": str(img),
                        "out_dir": str(run_dir),
                        "success": False,
                        "error": str(e),
                    }) + "\n")
                summary_f.flush()

    finally:
        summary_f.close()

    print(f"Wrote: {summary_path}")
    print(f"Artifacts: {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

