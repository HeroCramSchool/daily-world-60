#!/usr/bin/env python3
"""Kokoro-82M synthesis with native word-level timestamps (free, self-hosted).

Usage: python3 tts-kokoro.py <voice> <rate> <textfile> <out.mp3> <out.words.vtt> [trim]

Drop-in replacement for tts-words.py (edge-tts): same CLI + same outputs
(mp3 + per-word VTT), so tts-per-story.ts / buildGroupedVtt / caption sync are
unchanged. Kokoro's KPipeline returns per-token start_ts/end_ts natively, so no
forced alignment is needed. Model weights are Apache-2.0 (commercial OK).

trim (optional 6th arg): cut the silence Kokoro pads every chunk with (about
0.45 s before the voice, 0.6 s after) and shift the word times by what was cut.
Without it the output is unchanged.

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


LEAD_KEEP = 0.03  # kept before the first sound of a chunk
# kept after the last sound of the narration. The release of a final p/t/k/d can come up to 0.2 s
# after the last 5 ms above -45 dB (60 test sentences: 0.12 s cut sound above -60 dB in 9, 0.25 s in none)
TAIL_KEEP = 0.25
JOIN_GAP = 0.35  # pause left where two chunks meet (Kokoro leaves 0.38-0.57 s between sentences inside a chunk)


def voiced_span(aud):
    # first/last second where the 5 ms RMS is above -45 dB; None when nothing is
    w = int(0.005 * 24000)
    n = len(aud) // w
    if n == 0:
        return None
    rms = np.sqrt(np.mean(aud[: n * w].reshape(n, w) ** 2, axis=1))
    idx = np.where(20 * np.log10(rms + 1e-12) > -45.0)[0]
    if len(idx) == 0:
        return None
    return idx[0] * w / 24000.0, (idx[-1] + 1) * w / 24000.0


def trim_silence(parts, words, marks):
    # marks[i] = (index of the chunk's first word, chunk start in the untrimmed audio)
    out_parts, out_words = [], []
    cum = 0.0
    for i, aud in enumerate(parts):
        w0, t0 = marks[i]
        w1 = marks[i + 1][0] if i + 1 < len(parts) else len(words)
        total = len(aud) / 24000.0
        a, b = 0.0, total
        span = voiced_span(aud)
        if span:
            first = words[w0][0] - t0 if w1 > w0 else span[0]
            a = max(0.0, min(span[0], first) - LEAD_KEEP)
            b = min(total, span[1] + (TAIL_KEEP if i == len(parts) - 1 else JOIN_GAP))
        for start, end, word in words[w0:w1]:
            s = min(max(start - t0 - a, 0.0), b - a)
            e = min(max(end - t0 - a, s), b - a)
            out_words.append((cum + s, cum + e, word))
        kept = aud[int(a * 24000) : int(b * 24000)]
        out_parts.append(kept)
        cum += len(kept) / 24000.0
    return out_parts, out_words, cum


def main() -> None:
    voice, rate, textfile, mp3, vtt = sys.argv[1:6]
    trim = sys.argv[6:7] == ["trim"]
    with open(textfile, encoding="utf-8") as f:
        text = f.read().strip()

    speed = rate_to_speed(rate)
    lang = "b" if voice.startswith(("bm_", "bf_")) else "a"

    from kokoro import KPipeline

    pipeline = KPipeline(lang_code=lang)

    audio_parts = []
    words = []  # (start, end, text)
    marks = []
    cum = 0.0  # cumulative audio seconds across chunks (defensive; usually 1 chunk)
    for result in pipeline(text, voice=voice, speed=speed):
        if result.audio is None:
            continue
        aud = result.audio.detach().numpy() if hasattr(result.audio, "detach") else np.asarray(result.audio)
        marks.append((len(words), cum))
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

    if trim:
        untrimmed = cum
        audio_parts, words, cum = trim_silence(audio_parts, words, marks)
        print(f"[tts-kokoro] trim: {untrimmed:.2f}s -> {cum:.2f}s ({len(audio_parts)} chunk(s))")

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
