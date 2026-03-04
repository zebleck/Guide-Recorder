#!/usr/bin/env python3
"""
Convert rendered videos to GIF using ffmpeg with palette generation.

Examples:
  python scripts/convert_renders_to_gif.py --input render.mp4
  python scripts/convert_renders_to_gif.py --input render.mp4 --fps 20 --width 960
  python scripts/convert_renders_to_gif.py --input ./renders --output ./gifs --fps 18
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List


VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert one render (or a folder of renders) into GIF files."
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Input video file path or directory containing render videos.",
    )
    parser.add_argument(
        "--output",
        default="",
        help=(
            "Output GIF path (for a single input file) or output directory "
            "(for input directories). Default: beside input."
        ),
    )
    parser.add_argument(
        "--fps",
        type=float,
        default=15.0,
        help="Output GIF FPS (default: 15).",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=0,
        help="Output width in pixels. 0 keeps original width (default: 0).",
    )
    parser.add_argument(
        "--start",
        type=float,
        default=None,
        help="Start time in seconds (optional).",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Duration in seconds from start (optional).",
    )
    parser.add_argument(
        "--loop",
        type=int,
        default=0,
        help="GIF loop count for ffmpeg -loop_output (0 = infinite, default: 0).",
    )
    parser.add_argument(
        "--dither",
        default="sierra2_4a",
        choices=["none", "bayer", "floyd_steinberg", "sierra2", "sierra2_4a"],
        help="Palette dithering algorithm (default: sierra2_4a).",
    )
    parser.add_argument(
        "--stats-mode",
        default="full",
        choices=["full", "diff"],
        help="palettegen stats mode (default: full).",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite output GIF(s) if they already exist.",
    )
    parser.add_argument(
        "--loop-fade",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Fade end of GIF into first frame for smoother looping (default: enabled).",
    )
    parser.add_argument(
        "--loop-fade-sec",
        type=float,
        default=0.24,
        help="Duration of end-to-start fade in seconds (default: 0.24).",
    )
    return parser.parse_args()


def ensure_ffmpeg_available() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH.")


def discover_inputs(input_path: Path) -> List[Path]:
    if input_path.is_file():
        return [input_path]
    if input_path.is_dir():
        return sorted(
            p for p in input_path.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
        )
    return []


def build_output_path(
    input_video: Path,
    all_inputs_are_dir: bool,
    output_arg: str,
) -> Path:
    if not output_arg:
        return input_video.with_suffix(".gif")

    output_path = Path(output_arg)

    if all_inputs_are_dir:
        output_path.mkdir(parents=True, exist_ok=True)
        return output_path / f"{input_video.stem}.gif"

    # Single input file.
    if output_path.suffix.lower() == ".gif":
        output_path.parent.mkdir(parents=True, exist_ok=True)
        return output_path

    output_path.mkdir(parents=True, exist_ok=True)
    return output_path / f"{input_video.stem}.gif"


def ffmpeg_time_args(start: float | None, duration: float | None) -> List[str]:
    args: List[str] = []
    if start is not None and start >= 0:
        args.extend(["-ss", f"{start:.6f}"])
    if duration is not None and duration > 0:
        args.extend(["-t", f"{duration:.6f}"])
    return args


def probe_video_duration_sec(input_video: Path) -> float:
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(input_video),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffprobe duration probe failed")
    value = float((proc.stdout or "").strip())
    if value <= 0:
        raise RuntimeError("ffprobe returned non-positive duration")
    return value


def effective_duration_sec(
    input_duration_sec: float,
    start: float | None,
    duration: float | None,
) -> float:
    s = max(0.0, float(start or 0.0))
    if duration is not None and duration > 0:
        return max(0.0, min(float(duration), max(0.0, input_duration_sec - s)))
    return max(0.0, input_duration_sec - s)


def build_scale_fps_filter(fps: float, width: int) -> str:
    fps_text = f"{max(1.0, fps):.6f}"
    if width and width > 0:
        return f"fps={fps_text},scale={int(width)}:-1:flags=lanczos"
    return f"fps={fps_text}"


def build_loop_fade_filter(
    base_filter: str,
    total_duration_sec: float,
    fade_sec: float,
) -> str:
    fade_dur = max(0.01, float(fade_sec))
    if total_duration_sec <= fade_dur + 0.03:
        return base_filter
    fade_start = total_duration_sec - fade_dur
    expr = (
        f"if(gte(T\\,{fade_start:.6f})\\,"
        f"A*(1-((T-{fade_start:.6f})/{fade_dur:.6f}))+B*((T-{fade_start:.6f})/{fade_dur:.6f})\\,"
        "A)"
    )
    return (
        f"{base_filter},split=2[main][first];"
        "[first]trim=start_frame=0:end_frame=1,loop=loop=-1:size=1:start=0,"
        "setpts=N/FRAME_RATE/TB[firstloop];"
        f"[main][firstloop]blend=all_expr='{expr}':shortest=1,"
        f"trim=duration={total_duration_sec:.6f}"
    )


def run_ffmpeg(args: Iterable[str]) -> None:
    cmd = ["ffmpeg", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        msg = proc.stderr.strip() or proc.stdout.strip() or "Unknown ffmpeg error."
        raise RuntimeError(msg)


def convert_one(
    input_video: Path,
    output_gif: Path,
    fps: float,
    width: int,
    start: float | None,
    duration: float | None,
    loop: int,
    dither: str,
    stats_mode: str,
    overwrite: bool,
    loop_fade: bool,
    loop_fade_sec: float,
) -> None:
    if output_gif.exists() and not overwrite:
        raise FileExistsError(f"Output exists (use --overwrite): {output_gif}")

    output_gif.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gif-palette-") as tmp:
        palette_path = Path(tmp) / "palette.png"
        ffmode = "-y" if overwrite else "-n"
        trim_args = ffmpeg_time_args(start, duration)
        input_duration = probe_video_duration_sec(input_video)
        out_duration = effective_duration_sec(input_duration, start, duration)
        base_filter = build_scale_fps_filter(fps, width)
        video_filter = (
            build_loop_fade_filter(base_filter, out_duration, loop_fade_sec)
            if loop_fade
            else base_filter
        )
        # Keep palette generation fast and bounded; apply loop-fade only in pass 2.
        palette_filter = base_filter

        # Pass 1: generate palette.
        run_ffmpeg(
            [
                ffmode,
                *trim_args,
                "-i",
                str(input_video),
                "-vf",
                f"{palette_filter},palettegen=stats_mode={stats_mode}",
                str(palette_path),
            ]
        )

        # Pass 2: render gif with palette.
        run_ffmpeg(
            [
                ffmode,
                *trim_args,
                "-i",
                str(input_video),
                "-i",
                str(palette_path),
                "-lavfi",
                f"{video_filter}[x];[x][1:v]paletteuse=dither={dither}",
                "-loop",
                str(max(0, loop)),
                str(output_gif),
            ]
        )


def main() -> int:
    args = parse_args()

    try:
        ensure_ffmpeg_available()
    except RuntimeError as err:
        print(f"Error: {err}", file=sys.stderr)
        return 2

    input_path = Path(args.input).expanduser().resolve()
    inputs = discover_inputs(input_path)
    if not inputs:
        print("Error: No input videos found.", file=sys.stderr)
        return 2

    is_input_dir = input_path.is_dir()
    failures = 0

    for input_video in inputs:
        output_gif = build_output_path(input_video, is_input_dir, args.output)
        try:
            convert_one(
                input_video=input_video,
                output_gif=output_gif,
                fps=args.fps,
                width=args.width,
                start=args.start,
                duration=args.duration,
                loop=args.loop,
                dither=args.dither,
                stats_mode=args.stats_mode,
                overwrite=args.overwrite,
                loop_fade=args.loop_fade,
                loop_fade_sec=args.loop_fade_sec,
            )
            print(f"OK: {input_video} -> {output_gif}")
        except Exception as err:  # noqa: BLE001
            failures += 1
            print(f"FAIL: {input_video} -> {output_gif}\n  {err}", file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
