#!/usr/bin/env python3
"""Kokoro-82M synthesis with native word-level timestamps (free, self-hosted).

Usage: python3 tts-kokoro.py <voice> <rate> <textfile> <out.mp3> <out.words.vtt>

Drop-in replacement for tts-words.py (edge-tts): same CLI + same outputs
(mp3 + per-word VTT), so tts-per-story.ts / buildGroupedVtt / caption sync are
unchanged. Kokoro's KPipeline returns per-token start_ts/end_ts natively, so no
forced alignment is needed. Model weights are Apache-2.0 (commercial OK).

Voice: American male am_* / female af_* (lang 'a'), British bm_*/bf_* (lang 'b').
Rate: edge-style "-5%" / "+0%" string, mapped to Kokoro speed (1.0 = normal).
espeak-ng must be installed (apt-get install espeak-ng) for misaki's fallback G2P
on out-of-dictionary proper nouns; ESPEAK_DATA_PATH / PHONEMIZER_ESPEAK_LIBRARY
may be set to point at a non-standard install.
"""
import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf


def ts(t: float) -> str:
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def rate_to_speed(rate: str) -> float:
    # "-5%" -> 0.95, "+0%" -> 1.0, "10%" -> 1.10
    r = rate.strip().rstrip("%")
    try:
        return max(0.5, min(2.0, 1.0 + float(r) / 100.0))
    except ValueError:
        return 1.0


def main() -> None:
    voice, rate, textfile, mp3, vtt = sys.argv[1:6]
    with open(textfile, encoding="utf-8") as f:
        text = f.read().strip()

    speed = rate_to_speed(rate)
    lang = "b" if voice.startswith(("bm_", "bf_")) else "a"

    from kokoro import KPipeline

    pipeline = KPipeline(lang_code=lang)

    audio_parts = []
    words = []  # (start, end, text)
    cum = 0.0  # cumulative audio seconds across chunks (defensive; usually 1 chunk)
    for result in pipeline(text, voice=voice, speed=speed):
        if result.audio is None:
            continue
        aud = result.audio.detach().numpy() if hasattr(result.audio, "detach") else np.asarray(result.audio)
        for tok in (result.tokens or []):
            if tok.start_ts is None or tok.end_ts is None:
                continue
            word = (tok.text or "").strip()
            if not any(c.isalnum() for c in word):
                continue  # skip pure punctuation/whitespace tokens
            words.append((cum + float(tok.start_ts), cum + float(tok.end_ts), word))
        audio_parts.append(aud)
        cum += len(aud) / 24000.0

    if not audio_parts:
        raise SystemExit("[tts-kokoro] no audio produced")

    audio = np.concatenate(audio_parts)

    # Encode to mp3 via ffmpeg (write wav temp -> mp3). ffmpeg is present in CI.
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    try:
        sf.write(wav_path, audio, 24000)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-codec:a", "libmp3lame", "-q:a", "2", mp3],
            check=True,
        )
    finally:
        os.unlink(wav_path)

    with open(vtt, "w", encoding="utf-8") as out:
        out.write("WEBVTT\n\n")
        for start, end, word in words:
            out.write(f"{ts(start)} --> {ts(end)}\n{word}\n\n")

    print(f"[tts-kokoro] {voice} speed={speed:.2f} -> {len(words)} word cues, {cum:.1f}s")


if __name__ == "__main__":
    main()
