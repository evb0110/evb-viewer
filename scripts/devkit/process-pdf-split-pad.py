#!/usr/bin/env python3
"""
Process a PDF in a CLI-first workflow:

1) Rasterize selected pages with pdftoppm at a chosen DPI.
2) Run the bundled page-processor on each raster page with split+deskew (no crop).
3) Compute the global max width/height among all produced output images.
4) Pad every output image to that max size with symmetric white padding.

Outputs are written under .devkit/tmp by default, along with stdout/stderr logs and
an NDJSON manifest for easy debugging/regressions.

This script is intentionally stdlib-only; all heavy lifting is done by the bundled
page-processor binary.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


RE_RANGE = re.compile(r"^\s*(\d+)\s*-\s*(\d+)\s*$")
RE_INT = re.compile(r"^\s*\d+\s*$")


def now_tag() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def safe_stem(path: Path) -> str:
    s = path.stem
    s = re.sub(r"[^a-zA-Z0-9._-]+", "_", s).strip("_")
    return s or "document"


def run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout_s: int = 300,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        timeout=timeout_s,
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


def extract_result_json(stdout_text: str) -> dict:
    for line in reversed([l for l in stdout_text.splitlines() if l.strip()]):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict) and obj.get("type") == "result":
            return obj
    raise RuntimeError("No {type:'result'} JSON line found in processor output")


@dataclass(frozen=True)
class ProcessedOutput:
    source_page: int
    input_image: Path
    outputs: list[Path]
    output_sizes: list[dict]
    was_facing_pages: bool


def render_page(
    *,
    pdftoppm: str,
    pdf: Path,
    page: int,
    dpi: int,
    out_dir: Path,
    timeout_s: int,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = out_dir / f"p{page:04d}_r{dpi}"
    out_path = base.with_suffix(".png")
    cmd = [
        pdftoppm,
        "-png",
        "-r",
        str(dpi),
        "-f",
        str(page),
        "-l",
        str(page),
        "-singlefile",
        str(pdf),
        str(base),
    ]
    run(cmd, timeout_s=timeout_s)
    if not out_path.exists():
        raise RuntimeError(f"pdftoppm did not produce expected output: {out_path}")
    return out_path


def process_image(
    *,
    processor: str,
    image: Path,
    out_dir: Path,
    operations: list[str],
    auto_detect: bool,
    force_split: bool,
    timeout_s: int,
) -> dict:
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
    # Speed up PNG saves while staying lossless.
    env.setdefault("PAGE_PROCESSOR_PNG_COMPRESSION", "1")
    # Debug overlay can be enabled from the shell if needed.

    proc = run(cmd, env=env, timeout_s=timeout_s)
    (out_dir / "stdout.log").write_text(proc.stdout, encoding="utf-8")
    (out_dir / "stderr.log").write_text(proc.stderr, encoding="utf-8")
    return extract_result_json(proc.stdout)


def pad_image(
    *,
    processor: str,
    image: Path,
    out_path: Path,
    width: int,
    height: int,
    timeout_s: int,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        processor,
        "pad",
        str(image),
        str(out_path),
        "--width",
        str(width),
        "--height",
        str(height),
    ]
    run(cmd, timeout_s=timeout_s)


def main() -> int:
    ap = argparse.ArgumentParser(description="Split by gutter + deskew, then pad all outputs to uniform size.")
    ap.add_argument("pdf", type=Path, help="Path to PDF")
    ap.add_argument("--pages", type=str, default="1-10", help="Pages to process (default: 1-10)")
    ap.add_argument("--dpi", type=int, default=300, help="Raster DPI for pdftoppm (default: 300)")
    ap.add_argument("--timeout", type=int, default=300, help="Per-command timeout in seconds (default: 300)")
    ap.add_argument(
        "--processor",
        type=str,
        default="resources/page-processing/darwin-arm64/bin/page-processor/page-processor",
        help="Path to page-processor binary",
    )
    ap.add_argument("--pdftoppm", type=str, default="pdftoppm", help="pdftoppm binary")
    ap.add_argument("--qpdf", type=str, default="qpdf", help="qpdf binary")
    ap.add_argument("--force-split", action="store_true", help="Force split on every page")
    ap.add_argument("--no-auto-detect", action="store_true", help="Disable facing-page auto-detect")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output root dir (default: .devkit/tmp/pdf-split-pad/<timestamp>_<pdf-stem>/)",
    )

    args = ap.parse_args()
    pdf = args.pdf.resolve()
    if not pdf.exists():
        ap.error(f"PDF not found: {pdf}")

    processor = Path(args.processor).resolve()
    if not processor.exists():
        ap.error(f"page-processor not found: {processor}")

    # Determine page count.
    try:
        npages_out = run([args.qpdf, "--show-npages", str(pdf)], timeout_s=args.timeout).stdout.strip()
        npages = int(npages_out)
    except Exception as e:
        ap.error(f"Failed to determine page count via qpdf: {e}")
        return 2

    pages = parse_pages(args.pages, npages)
    if not pages:
        ap.error("No pages selected")

    out_root = args.out or Path(".devkit/tmp/pdf-split-pad") / f"{now_tag()}_{safe_stem(pdf)}"
    out_root.mkdir(parents=True, exist_ok=True)

    render_dir = out_root / "render"
    runs_dir = out_root / "runs"
    padded_dir = out_root / "padded"
    manifest_path = out_root / "manifest.ndjson"

    operations = ["split", "deskew"]  # hard policy for this workflow
    auto_detect = not args.no_auto_detect

    processed: list[ProcessedOutput] = []
    max_w = 0
    max_h = 0

    with manifest_path.open("w", encoding="utf-8") as mf:
        mf.write(json.dumps({
            "type": "meta",
            "pdf": str(pdf),
            "npages": npages,
            "pages": pages,
            "dpi": int(args.dpi),
            "operations": operations,
            "force_split": bool(args.force_split),
            "auto_detect": bool(auto_detect),
            "processor": str(processor),
        }) + "\n")

        for page in pages:
            img = render_page(
                pdftoppm=args.pdftoppm,
                pdf=pdf,
                page=page,
                dpi=int(args.dpi),
                out_dir=render_dir,
                timeout_s=int(args.timeout),
            )

            run_dir = runs_dir / f"p{page:04d}"
            result = process_image(
                processor=str(processor),
                image=img,
                out_dir=run_dir,
                operations=operations,
                auto_detect=bool(auto_detect),
                force_split=bool(args.force_split),
                timeout_s=int(args.timeout),
            )

            output_paths = [Path(p) for p in (result.get("output_paths") or [])]
            output_sizes = list(result.get("output_sizes") or [])
            was_facing_pages = bool((result.get("detection") or {}).get("was_facing_pages", False))

            for s in output_sizes:
                try:
                    max_w = max(max_w, int(s.get("width") or 0))
                    max_h = max(max_h, int(s.get("height") or 0))
                except Exception:
                    pass

            processed.append(ProcessedOutput(
                source_page=int(page),
                input_image=img,
                outputs=output_paths,
                output_sizes=output_sizes,
                was_facing_pages=was_facing_pages,
            ))

            mf.write(json.dumps({
                "type": "processed",
                "page": int(page),
                "input_image": str(img),
                "run_dir": str(run_dir),
                "was_facing_pages": was_facing_pages,
                "output_paths": [str(p) for p in output_paths],
                "output_sizes": output_sizes,
            }) + "\n")
            mf.flush()

        if max_w <= 0 or max_h <= 0:
            raise RuntimeError("Failed to determine max output size from processor results")

        mf.write(json.dumps({
            "type": "pad_meta",
            "target_size": {"width": int(max_w), "height": int(max_h)},
        }) + "\n")
        mf.flush()

        # Pad everything to the global max.
        for item in processed:
            for out_path in item.outputs:
                padded_path = padded_dir / out_path.name
                pad_image(
                    processor=str(processor),
                    image=out_path,
                    out_path=padded_path,
                    width=int(max_w),
                    height=int(max_h),
                    timeout_s=int(args.timeout),
                )
                mf.write(json.dumps({
                    "type": "padded",
                    "source_page": int(item.source_page),
                    "input_image": str(item.input_image),
                    "input_output": str(out_path),
                    "padded_output": str(padded_path),
                    "target_size": {"width": int(max_w), "height": int(max_h)},
                }) + "\n")
                mf.flush()

    print(f"Artifacts: {out_root}")
    print(f"Manifest:  {manifest_path}")
    print(f"Target:    {max_w}x{max_h}")
    print(f"Padded:    {padded_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
