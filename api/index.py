"""
ClipForge — FastAPI Backend (Vercel Serverless + Local Dev)
Handles URL validation, video download via yt-dlp, slicing via ffmpeg,
and file delivery with automatic cleanup.

On Vercel: uses /tmp for temp files, static-ffmpeg for the ffmpeg binary.
Locally:   uses ./temp for temp files, system ffmpeg, and serves static files.
"""

import os
import re
import uuid
import subprocess
import shutil
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, HTMLResponse
import yt_dlp


# ---------------------------------------------------------------------------
# Environment detection
# ---------------------------------------------------------------------------

IS_VERCEL = bool(os.environ.get("VERCEL"))

if IS_VERCEL:
    TEMP_DIR = Path("/tmp/clipforge")
else:
    TEMP_DIR = Path(__file__).resolve().parent.parent / "temp"

TEMP_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# FFmpeg resolution
# ---------------------------------------------------------------------------

def _get_ffmpeg() -> str:
    """Return the path to an ffmpeg executable."""
    # 1. System ffmpeg (local dev / servers with ffmpeg installed)
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    # 2. static-ffmpeg package (Vercel serverless)
    try:
        import static_ffmpeg
        static_ffmpeg.add_paths()
        if shutil.which("ffmpeg"):
            return "ffmpeg"
    except ImportError:
        pass
    raise RuntimeError(
        "FFmpeg not found. Install it on your system or add 'static-ffmpeg' to requirements.txt."
    )


FFMPEG_BIN = _get_ffmpeg()


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="ClipForge")

# Local development: serve static files and the SPA index
if not IS_VERCEL:
    from fastapi.staticfiles import StaticFiles

    PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"
    STATIC_DIR = PUBLIC_DIR / "static"

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/", response_class=HTMLResponse)
    async def index():
        return (PUBLIC_DIR / "index.html").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

YOUTUBE_RE = re.compile(
    r"^(https?://)?(www\.)?"
    r"(youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)"
    r"[A-Za-z0-9_\-]{11}"
)


def _is_valid_youtube_url(url: str) -> bool:
    return bool(YOUTUBE_RE.match(url.strip()))


def _parse_timestamp(ts: str | None, max_seconds: float | None = None) -> float | None:
    """Convert a timestamp string to seconds. Accepts raw seconds or HH:MM:SS / MM:SS."""
    if ts is None or ts.strip() == "":
        return None
    ts = ts.strip()

    # Raw seconds (int or float)
    try:
        val = float(ts)
        if val < 0:
            raise ValueError
        if max_seconds is not None and val > max_seconds:
            raise ValueError
        return val
    except ValueError:
        pass

    # HH:MM:SS or MM:SS
    parts = ts.split(":")
    try:
        if len(parts) == 3:
            h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
            val = h * 3600 + m * 60 + s
        elif len(parts) == 2:
            m, s = int(parts[0]), float(parts[1])
            val = m * 60 + s
        else:
            raise ValueError("Invalid timestamp format")
        if val < 0:
            raise ValueError
        if max_seconds is not None and val > max_seconds:
            raise ValueError
        return val
    except (ValueError, IndexError):
        raise HTTPException(status_code=400, detail=f"Invalid timestamp: {ts}")


def _cleanup(*paths: Path):
    """Remove files/dirs after response is sent."""
    for p in paths:
        try:
            if p.is_file():
                p.unlink(missing_ok=True)
            elif p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
        except Exception:
            pass


def _seconds_to_ts(s: float) -> str:
    """Convert seconds to HH:MM:SS.mmm for ffmpeg."""
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:06.3f}"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/api/validate")
async def validate_url(request: Request):
    """Validate a YouTube URL and return video metadata."""
    body = await request.json()
    url = body.get("url", "").strip()

    if not url or not _is_valid_youtube_url(url):
        raise HTTPException(status_code=400, detail="Invalid YouTube URL")

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not fetch video info: {e}")

    return {
        "title": info.get("title", "Unknown"),
        "duration": info.get("duration", 0),
        "thumbnail": info.get("thumbnail", ""),
        "channel": info.get("channel", info.get("uploader", "Unknown")),
    }


@app.post("/api/download")
async def download_video(request: Request, background_tasks: BackgroundTasks):
    """Download (and optionally slice) a YouTube video, return the .mp4 file."""
    body = await request.json()
    url = body.get("url", "").strip()
    start_raw = body.get("start")
    end_raw = body.get("end")

    if not url or not _is_valid_youtube_url(url):
        raise HTTPException(status_code=400, detail="Invalid YouTube URL")

    # --- 1. Probe duration for timestamp validation ---
    ydl_opts_probe = {"quiet": True, "no_warnings": True, "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts_probe) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not fetch video info: {e}")

    duration = info.get("duration", 0)
    title = re.sub(r'[<>:"/\\|?*]', '_', info.get("title", "video"))

    start_sec = _parse_timestamp(start_raw, duration)
    end_sec = _parse_timestamp(end_raw, duration)

    if start_sec is not None and end_sec is not None and start_sec >= end_sec:
        raise HTTPException(status_code=400, detail="Start time must be before end time")

    # --- 2. Download via yt-dlp ---
    job_id = uuid.uuid4().hex
    base_path = TEMP_DIR / f"{job_id}.mp4"

    ydl_opts_dl = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "outtmpl": str(base_path),
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts_dl) as ydl:
            ydl.download([url])
    except Exception as e:
        _cleanup(base_path)
        raise HTTPException(status_code=500, detail=f"Download failed: {e}")

    if not base_path.exists():
        raise HTTPException(status_code=500, detail="Download produced no output file")

    # --- 3. Slice with ffmpeg (if timestamps provided) ---
    needs_slice = start_sec is not None or end_sec is not None
    output_path = base_path

    if needs_slice:
        sliced_path = TEMP_DIR / f"{job_id}_sliced.mp4"
        cmd = [FFMPEG_BIN, "-y"]

        if start_sec is not None:
            cmd += ["-ss", _seconds_to_ts(start_sec)]

        cmd += ["-i", str(base_path)]

        if end_sec is not None:
            if start_sec is not None:
                # Duration relative to start
                cmd += ["-t", _seconds_to_ts(end_sec - start_sec)]
            else:
                cmd += ["-to", _seconds_to_ts(end_sec)]

        cmd += ["-c", "copy", "-movflags", "+faststart", str(sliced_path)]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=120
            )
            if result.returncode != 0:
                _cleanup(base_path, sliced_path)
                raise HTTPException(
                    status_code=500,
                    detail=f"FFmpeg slicing failed: {result.stderr[:500]}",
                )
        except subprocess.TimeoutExpired:
            _cleanup(base_path, sliced_path)
            raise HTTPException(status_code=500, detail="FFmpeg slicing timed out")

        output_path = sliced_path
        # Schedule base file cleanup immediately; sliced file cleaned after response
        background_tasks.add_task(_cleanup, base_path)

    # --- 4. Serve file & schedule cleanup ---
    download_name = f"{title}.mp4"
    background_tasks.add_task(_cleanup, output_path)

    return FileResponse(
        path=str(output_path),
        media_type="video/mp4",
        filename=download_name,
        background=background_tasks,
    )
