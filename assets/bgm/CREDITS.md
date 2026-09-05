# BGM プール — 帰属表示（必須）

すべて **Kevin MacLeod (incompetech.com)** / **CC BY 4.0**。
`pickBgm` がこのフォルダから動画ごとにローテーションする。

## 選定基準：ニュース番組の下敷き

「喋りの下に敷く」用途がカタログの説明文に**明記されている**曲だけを採る。
ドラマ性・ホラー・コメディ寄りは外す（前に出て台詞を邪魔するため）。
テンポは 101〜135 BPM に散らして、同系統でも単調にならないようにしている。

## 尺の上限（検証済み）

1分を**超える** Short に有効な著作権申立てが付くと、種類を問わず（manual claim 含む）
**全世界でブロック**される。1分以下の Short にこの制限は無い。
出典: https://support.google.com/youtube/answer/15424877 （2026-09-01 取得・原文 "Any Short that
is over one minute in duration with an active copyright claim of any type, including manual claims,
will be blocked globally on YouTube."）

→ `remotion/render-shorts.mjs` は書き出し後の**実尺**を 57 秒でチェックして落とす。

## 🔴 帰属表示は必須（CC BY 4.0 の義務。加えてクレーム回避にもなる）

Incompetech は自分の楽曲を **Content ID に登録している**（第三者による虚偽クレームを防ぐため）。
公式ページの記述: クレームが来る原因は「帰属表示の入れ忘れ、または動画内に焼き込んで
自動で読み取れない形になっていること」。
出典: https://incompetech.com/music/royalty-free/youtube-contentid.html （2026-09-01 取得）

→ **概要欄のテキストに** 下記を入れること。動画内への焼き込みだけでは不可。

## 各トラックの帰属文（そのまま概要欄へ）

### Voice Over Under.mp3
- 00:03:17 / BPM 135 / Synths, Percussion / ISRC USUAN1600001
- 採用理由: This is a piece of music classified as "GNDN". Goes Nowhere. Does Nothing. It sort of sits there and just repeats mild variants. There isn't even an ending.  Yet, this was all on p

```
Voice Over Under Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```
- 取得元: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Voice%20Over%20Under.mp3

### Tech Live.mp3
- 00:03:48 / BPM 124 / Synths, Percussion / ISRC USUAN1700030
- 採用理由: Interview-Mania! This piece does nothing and goes nowhere. Perfect for an energetic backdrop to your review or interview segments!

```
Tech Live Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```
- 取得元: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Tech%20Live.mp3

### Rising Tide.mp3
- 00:04:37 / BPM 106 / Synths, Percussion / ISRC USUAN1900010
- 採用理由: Let's be fair, if your interview segment was already energetic, you  don't need something like this to fix it. Most people suck at interviews. It isn't their fault. Talking in an e

```
Rising Tide Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```
- 取得元: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Rising%20Tide.mp3

### Special Spotlight.mp3
- 00:03:12 / BPM 126 / Synths, Percussion / ISRC USUAN1600067
- 採用理由: So you're producing an interview segment! Problem is most people suck at being interviewed. Like... almost everyone. What do you do? You could send the non-media professional to an

```
Special Spotlight Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```
- 取得元: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Special%20Spotlight.mp3

### Consequence.mp3
- 00:05:02 / BPM 101 / - / ISRC USUAN1100283
- 採用理由: Moderately paced driving composition featuring xylophone and cowbell. No, I'm not kidding.

```
Consequence Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0
https://creativecommons.org/licenses/by/4.0/
```
- 取得元: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Consequence.mp3

## 外した曲（2026-09-02）

Enigma / Unanswered Questions / I Can Feel it Coming / Invariance / Industrial Cinematic。
Driving・Suspenseful ではあるがスリラー寄りで、ニュースの下敷きとしては前に出すぎた。
同じ URL パターンで再取得できる。

## 既存トラック

- `assets/news-bed.mp3` = "Investigations"。カタログ上の説明は "Sort of a loafing comedic piece"
  （feel: Humorous・1:34）でトーンが合わない。このプールに曲がある限り使われない。
- `assets/news-bed-longform.mp3` = "Lightless Dawn"。長尺用。こちらも帰属表示が必要。
