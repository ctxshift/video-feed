# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "faster-whisper>=1.1",
#   "nvidia-cublas-cu12",
#   "nvidia-cudnn-cu12>=9",
# ]
# ///
"""Local speech recognition for `vid`, over a JSON contract.

Invoked as:  uv run --script whisper.py --audio FILE [options]

stdout: one JSON object -- the transcript. Nothing else ever goes to stdout.
stderr: newline-delimited JSON progress events, for the caller's UI.

uv resolves and caches the dependency set on first run, so this file needs no
install step and no virtualenv management.
"""

from __future__ import annotations

import argparse
import json
import sys


def emit(**event) -> None:
    """Progress event on stderr. Never stdout -- that carries the result."""
    print(json.dumps(event), file=sys.stderr, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--language", default=None)
    ap.add_argument("--hotwords", default=None)
    ap.add_argument("--beam-size", type=int, default=5)
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:  # pragma: no cover
        emit(type="error", message=f"faster-whisper unavailable: {e}")
        return 2

    emit(type="status", message=f"loading {args.model} on {args.device}")
    # int8_float16 roughly halves VRAM against float16 for no accuracy cost
    # worth measuring -- which matters when the card is also running other work.
    compute = "int8_float16" if args.device == "cuda" else "int8"
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=compute)
    except Exception as e:
        emit(type="error", message=f"could not load model: {e}")
        return 3

    emit(type="status", message="transcribing")
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        hotwords=args.hotwords or None,
        vad_filter=True,       # drop silence, so timestamps stay honest
        beam_size=args.beam_size,
        word_timestamps=False, # segment level is enough to anchor corrections
    )

    total = round(info.duration, 2)
    emit(type="meta", duration=total, language=info.language,
         language_confidence=round(info.language_probability, 3))

    out = []
    for seg in segments:  # generator: work happens as we iterate
        text = seg.text.strip()
        if text:
            out.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
        emit(type="progress", done=round(seg.end, 2), total=total)

    json.dump(
        {
            "engine": "whisper",
            "model": args.model,
            "language": info.language,
            "language_confidence": round(info.language_probability, 3),
            "duration_s": total,
            "segments": out,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
