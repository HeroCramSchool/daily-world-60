#!/usr/bin/env python3
"""edge-tts synthesis with word-level timestamps (karaoke captions).

Usage: python3 tts-words.py <voice> <rate> <textfile> <out.mp3> <out.words.vtt>

The v7 edge-tts CLI dropped --words-in-cue, so we stream via the Python API and
capture WordBoundary events (offsets in 100ns ticks) into a per-word VTT.
"""
import asyncio
import sys

import edge_tts


def ts(t: float) -> str:
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


async def main() -> None:
    voice, rate, textfile, mp3, vtt = sys.argv[1:6]
    with open(textfile, encoding="utf-8") as f:
        text = f.read()
    com = edge_tts.Communicate(text, voice, rate=rate, pitch="+0Hz", boundary="WordBoundary")
    words = []
    with open(mp3, "wb") as out:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                out.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append(chunk)
    with open(vtt, "w", encoding="utf-8") as out:
        out.write("WEBVTT\n\n")
        for w in words:
            start = w["offset"] / 1e7
            end = (w["offset"] + w["duration"]) / 1e7
            out.write(f"{ts(start)} --> {ts(end)}\n{w['text']}\n\n")
    print(f"[tts-words] {len(words)} word cues")


asyncio.run(main())
