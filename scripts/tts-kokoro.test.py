#!/usr/bin/env python3
"""tts-kokoro.py の trim の試験。npm run test:tts で回す (numpy・soundfile・ffmpeg が要る。Kokoro は要らない)。"""
import atexit, importlib.util, os, re, shutil, subprocess, sys, tempfile
sys.dont_write_bytecode = True
import numpy as np

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts-kokoro.py")
OUT = tempfile.mkdtemp(prefix="tts-kokoro-test-")
atexit.register(shutil.rmtree, OUT, True)
FAKE = os.path.join(OUT, "fake")
os.makedirs(os.path.join(FAKE, "kokoro"))
with open(os.path.join(FAKE, "kokoro", "__init__.py"), "w", encoding="utf-8") as f:
    f.write('''"""試験用の代役。作り物のかたまり (無音 + 音 + 無音) と語の時刻を返す。torch も本物の Kokoro も要らない。"""
import numpy as np

SR = 24000


class _Tok:
    def __init__(self, text, start_ts, end_ts):
        self.text, self.start_ts, self.end_ts = text, start_ts, end_ts


class _Result:
    def __init__(self, audio, tokens):
        self.audio, self.tokens = audio, tokens


def _tone(sec):
    return (0.1 * np.sin(2 * np.pi * 220 * np.arange(int(sec * SR)) / SR)).astype(np.float32)


def _sil(sec):
    return np.zeros(int(sec * SR), dtype=np.float32)


class KPipeline:
    def __init__(self, lang_code="a", **kw):
        pass

    def __call__(self, text, voice=None, speed=1.0, **kw):
        # かたまり1: 頭 0.45 無音 + 音 1.0 + 末尾 0.6 無音 (2.05 秒)。語 2つ + 句読点 + 時刻の無い語
        yield _Result(np.concatenate([_sil(0.45), _tone(1.0), _sil(0.6)]),
                      [_Tok("Alpha", 0.425, 0.9), _Tok(",", 0.9, 0.95), _Tok("beta", 0.95, 1.45), _Tok("x", None, None)])
        # 音の無い結果は飛ばされる
        yield _Result(None, [_Tok("skipped", 0.0, 0.1)])
        # かたまり2: 頭 0.40 無音 + 音 1.0 + 末尾 0.6 無音 (2.0 秒)
        yield _Result(np.concatenate([_sil(0.40), _tone(1.0), _sil(0.6)]),
                      [_Tok("Gamma", 0.38, 0.9), _Tok("delta", 0.9, 1.4), _Tok(".", 1.4, 1.45)])
''')
spec = importlib.util.spec_from_file_location("ttsk", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SR = 24000
tone = lambda sec: (0.1 * np.sin(2 * np.pi * 220 * np.arange(int(sec * SR)) / SR)).astype(np.float32)
sil = lambda sec: np.zeros(int(sec * SR), dtype=np.float32)
near = lambda a, b, tol=2e-4: abs(a - b) <= tol
fails = []


def check(name, fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        fails.append(name)
        print(f"NG  {name}: {type(e).__name__} {e}")
    else:
        print(f"OK  {name}")


def one_chunk():
    # 頭 0.45 + 音 2.0 + 末尾 0.6。最初の語は音の出だしより 0.03 秒早い
    aud = np.concatenate([sil(0.45), tone(2.0), sil(0.6)])
    parts, words, cum = m.trim_silence([aud], [(0.42, 1.0, "a"), (1.0, 2.45, "b")], [(0, 0.0)])
    assert near(cum, 2.70 - 0.39), cum                      # 残すのは [0.42-0.03, 2.45+0.25]
    assert near(len(parts[0]) / SR, cum)
    assert near(words[0][0], 0.03) and near(words[0][1], 0.61), words
    assert near(words[1][0], 0.61) and near(words[1][1], 2.06), words
    assert [w[2] for w in words] == ["a", "b"]


def onset_before_first_word():
    # 語の時刻が音の出だしより遅いときは、音の出だしの 0.03 秒前から残す
    aud = np.concatenate([sil(0.45), tone(2.0), sil(0.6)])
    parts, words, cum = m.trim_silence([aud], [(0.60, 1.0, "a")], [(0, 0.0)])
    assert near(words[0][0], 0.60 - 0.42), words
    assert near(cum, 2.70 - 0.42), cum


def two_chunks():
    a0 = np.concatenate([sil(0.45), tone(1.0), sil(0.6)])   # 2.05 秒
    a1 = np.concatenate([sil(0.40), tone(1.0), sil(0.6)])   # 2.00 秒
    w = [(0.42, 1.45, "a"), (2.05 + 0.40, 2.05 + 1.40, "b")]
    parts, words, cum = m.trim_silence([a0, a1], w, [(0, 0.0), (1, 2.05)])
    assert near(len(parts[0]) / SR, (1.45 + 0.35) - 0.39), len(parts[0]) / SR   # 境目は 音の終わり + 0.35
    assert near(len(parts[1]) / SR, (1.40 + 0.25) - 0.37), len(parts[1]) / SR   # 最後は 音の終わり + 0.25、頭は 0.03 残す
    assert near(words[0][0], 0.03) and near(words[0][1], 1.06), words
    assert near(words[1][0], len(parts[0]) / SR + 0.03), words               # 2つ目の語は切った1つ目の長さだけ後ろ
    assert near(words[1][1], len(parts[0]) / SR + 1.03), words
    assert near(cum, (len(parts[0]) + len(parts[1])) / SR)
    assert len(words) == 2


def join_gap_is_not_tail_keep():
    a0 = np.concatenate([sil(0.45), tone(1.0), sil(0.6)])
    parts, _, _ = m.trim_silence([a0, a0], [(0.42, 1.45, "a"), (2.47, 3.5, "b")], [(0, 0.0), (1, 2.05)])
    gap0 = len(parts[0]) / SR - (1.45 - 0.39)
    gap1 = len(parts[1]) / SR - (1.45 - 0.39)
    assert near(gap0, 0.35) and near(gap1, 0.25), (gap0, gap1)


def silent_chunk_untouched():
    a0 = np.concatenate([sil(0.45), tone(1.0), sil(0.6)])
    quiet = (10 ** (-60 / 20) * np.ones(int(1.0 * SR))).astype(np.float32)
    parts, words, cum = m.trim_silence([a0, quiet, a0], [(0.42, 1.45, "a"), (2.25, 2.55, "q"), (3.47, 4.5, "b")], [(0, 0.0), (1, 2.05), (2, 3.05)])
    assert len(parts[1]) == len(quiet)
    assert near(words[1][0], len(parts[0]) / SR + 0.2) and near(words[1][1], len(parts[0]) / SR + 0.5), words


def clamp_and_order():
    aud = np.concatenate([sil(0.45), tone(2.0), sil(0.6)])
    parts, words, cum = m.trim_silence([aud], [(0.42, 1.0, "a"), (2.9, 3.0, "late")], [(0, 0.0)])
    assert all(0 <= s <= e <= cum + 1e-9 for s, e, _ in words), words
    assert near(words[1][1], cum), words


def no_padding_nothing_cut():
    bare = tone(1.0)
    parts, words, cum = m.trim_silence([bare], [(0.0, 1.0, "a")], [(0, 0.0)])
    assert len(parts[0]) == len(bare) and near(words[0][0], 0.0) and near(words[0][1], 1.0)


def no_words_and_tiny():
    aud = np.concatenate([sil(0.45), tone(2.0), sil(0.6)])
    parts, words, cum = m.trim_silence([aud], [], [(0, 0.0)])
    assert near(cum, 2.70 - 0.42) and words == []
    tiny = sil(0.002)
    parts, words, cum = m.trim_silence([tiny], [], [(0, 0.0)])
    assert len(parts[0]) == len(tiny)


def threshold():
    # -45dB より大きい音だけを声とみなす。-50dB の雑音は無音、-40dB は声
    lo = (10 ** (-50 / 20) * np.ones(int(0.5 * SR))).astype(np.float32)
    hi = (10 ** (-40 / 20) * np.ones(int(0.5 * SR))).astype(np.float32)
    assert m.voiced_span(lo) is None
    span = m.voiced_span(np.concatenate([lo, hi, lo]))
    assert near(span[0], 0.5) and near(span[1], 1.0), span


def run(tag, extra):
    mp3, vtt = os.path.join(OUT, f"{tag}.mp3"), os.path.join(OUT, f"{tag}.vtt")
    txt = os.path.join(OUT, "text.txt")
    open(txt, "w").write("Alpha, beta. Gamma delta.")
    env = dict(os.environ, PYTHONPATH=FAKE, PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run([sys.executable, SCRIPT, "am_michael", "-5%", txt, mp3, vtt, *extra], capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr[-400:]
    cues = [(int(h) * 3600 + int(mi) * 60 + float(s), int(h2) * 3600 + int(m2) * 60 + float(s2), w)
            for h, mi, s, h2, m2, s2, w in re.findall(r"(\d+):(\d+):([\d.]+) --> (\d+):(\d+):([\d.]+)\n(.+)", open(vtt).read())]
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3], capture_output=True, text=True).stdout)
    return r.stdout, cues, dur


def e2e_no_arg():
    out, cues, dur = run("plain", [])
    assert "trim:" not in out, out
    assert [c[2] for c in cues] == ["Alpha", "beta", "Gamma", "delta"], cues
    want = [(0.425, 0.9), (0.95, 1.45), (2.05 + 0.38, 2.05 + 0.9), (2.05 + 0.9, 2.05 + 1.4)]
    assert all(near(c[0], w[0], 0.0011) and near(c[1], w[1], 0.0011) for c, w in zip(cues, want)), cues
    assert abs(dur - 4.05) < 0.08, dur


def e2e_other_arg_is_not_trim():
    out, cues, dur = run("other", ["0"])
    assert "trim:" not in out and abs(dur - 4.05) < 0.08, (out, dur)


def e2e_trim():
    out, cues, dur = run("trim", ["trim"])
    assert re.search(r"trim: 4\.05s -> 2\.7[01]s \(2 chunk\(s\)\)", out), out
    assert [c[2] for c in cues] == ["Alpha", "beta", "Gamma", "delta"], cues
    c0 = (1.45 + 0.35) - 0.395                      # かたまり1 の残り: [0.425-0.03, 1.45+0.35]
    want = [(0.03, 0.505), (0.555, 1.055), (c0 + 0.03, c0 + 0.55), (c0 + 0.55, c0 + 1.05)]
    assert all(near(c[0], w[0], 0.0011) and near(c[1], w[1], 0.0011) for c, w in zip(cues, want)), (cues, want)
    assert abs(dur - (c0 + (1.40 + 0.25) - 0.35)) < 0.08, dur


for name, fn in [("1かたまり", one_chunk), ("音の出だしが語より早い", onset_before_first_word), ("2かたまり", two_chunks),
                 ("境目 0.35・末尾 0.25", join_gap_is_not_tail_keep), ("声の無いかたまり", silent_chunk_untouched),
                 ("語の時刻を切った位置で止める", clamp_and_order), ("無音の無いかたまり", no_padding_nothing_cut),
                 ("語の無い・短いかたまり", no_words_and_tiny), ("-45dB の線", threshold),
                 ("端から端: 引数なし", e2e_no_arg), ("端から端: trim 以外の引数", e2e_other_arg_is_not_trim), ("端から端: trim", e2e_trim)]:
    check(name, fn)
print("FAILED: " + ", ".join(fails) if fails else "ALL OK")
sys.exit(1 if fails else 0)
