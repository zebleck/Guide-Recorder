#!/usr/bin/env python3
"""
Compress MP4 videos while keeping MP4 output for broad compatibility.

Examples:
  python scripts/compress_mp4.py --input render.mp4
  python scripts/compress_mp4.py --input render.mp4 --crf 28 --preset slow
  python scripts/compress_mp4.py --input ./renders --output ./mp4-small --width 1280 --fps 30
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List


VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compress one video (or a folder of videos) into MP4."
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Input video file path or directory containing videos.",
    )
    parser.add_argument(
        "--output",
        default="",
        help=(
            "Output MP4 path (for a single input file) or output directory "
            "(for input directories). Default: beside input with .small.mp4 suffix."
        ),
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
        "--fps",
        type=float,
        default=0.0,
        help="Output FPS. 0 keeps source FPS (default: 0).",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=0,
        help="Output width in pixels. 0 keeps original width (default: 0).",
    )
    parser.add_argument(
        "--crf",
        type=int,
        default=28,
        help="H.264 CRF quality (lower=better quality, higher=smaller file; default: 28).",
    )
    parser.add_argument(
        "--preset",
        default="medium",
        choices=["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"],
        help="H.264 preset (slower usually compresses better, default: medium).",
    )
    parser.add_argument(
        "--audio-bitrate",
        default="128k",
        help="AAC audio bitrate when audio exists (default: 128k).",
    )
    parser.add_argument(
        "--no-audio",
        action="store_true",
        help="Drop audio from output.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite output file(s) if they already exist.",
    )
    parser.add_argument(
        "--loop-fade",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Fade end of output into first frame for smooth loops (default: enabled).",
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
            p
            for p in input_path.iterdir()
            if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
        )
    return []


def build_output_path(input_video: Path, all_inputs_are_dir: bool, output_arg: str) -> Path:
    if not output_arg:
        return input_video.with_name(f"{input_video.stem}.small.mp4")

    output_path = Path(output_arg)
    if all_inputs_are_dir:
        output_path.mkdir(parents=True, exist_ok=True)
        return output_path / f"{input_video.stem}.mp4"

    if output_path.suffix.lower() == ".mp4":
        output_path.parent.mkdir(parents=True, exist_ok=True)
        return output_path

    output_path.mkdir(parents=True, exist_ok=True)
    return output_path / f"{input_video.stem}.mp4"


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


def build_video_filter(fps: float, width: int) -> str:
    filters: List[str] = []
    if fps and fps > 0:
        filters.append(f"fps={fps:.6f}")
    if width and width > 0:
        filters.append(f"scale={int(width)}:-2:flags=lanczos")
    return ",".join(filters)


def build_loop_fade_filter(base_filter: str, total_duration_sec: float, fade_sec: float) -> str:
    fade_dur = max(0.01, float(fade_sec))
    prefix = f"{base_filter}," if base_filter else ""
    if total_duration_sec <= fade_dur + 0.03:
        return base_filter
    fade_start = total_duration_sec - fade_dur
    expr = (
        f"if(gte(T\\,{fade_start:.6f})\\,"
        f"A*(1-((T-{fade_start:.6f})/{fade_dur:.6f}))+B*((T-{fade_start:.6f})/{fade_dur:.6f})\\,"
        "A)"
    )
    return (
        f"{prefix}split=2[main][first];"
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
    output_video: Path,
    start: float | None,
    duration: float | None,
    fps: float,
    width: int,
    crf: int,
    preset: str,
    audio_bitrate: str,
    no_audio: bool,
    overwrite: bool,
    loop_fade: bool,
    loop_fade_sec: float,
) -> None:
    if output_video.exists() and not overwrite:
        raise FileExistsError(f"Output exists (use --overwrite): {output_video}")

    output_video.parent.mkdir(parents=True, exist_ok=True)
    ffmode = "-y" if overwrite else "-n"
    trim_args = ffmpeg_time_args(start, duration)
    base_filter = build_video_filter(fps, width)
    input_duration = probe_video_duration_sec(input_video)
    out_duration = effective_duration_sec(input_duration, start, duration)
    vf = (
        build_loop_fade_filter(base_filter, out_duration, loop_fade_sec)
        if loop_fade
        else base_filter
    )
    safe_crf = str(max(0, min(51, int(crf))))

    cmd: List[str] = [
        ffmode,
        *trim_args,
        "-i",
        str(input_video),
        "-map",
        "0:v:0",
    ]
    if vf:
        cmd.extend(["-vf", vf])
    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            safe_crf,
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ]
    )

    if no_audio:
        cmd.append("-an")
    else:
        cmd.extend(["-map", "0:a?", "-c:a", "aac", "-b:a", audio_bitrate])

    cmd.append(str(output_video))
    run_ffmpeg(cmd)


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
        output_video = build_output_path(input_video, is_input_dir, args.output)
        try:
            convert_one(
                input_video=input_video,
                output_video=output_video,
                start=args.start,
                duration=args.duration,
                fps=args.fps,
                width=args.width,
                crf=args.crf,
                preset=args.preset,
                audio_bitrate=args.audio_bitrate,
                no_audio=args.no_audio,
                overwrite=args.overwrite,
                loop_fade=args.loop_fade,
                loop_fade_sec=args.loop_fade_sec,
            )
            print(f"OK: {input_video} -> {output_video}")
        except Exception as err:  # noqa: BLE001
            failures += 1
            print(f"FAIL: {input_video} -> {output_video}\n  {err}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
