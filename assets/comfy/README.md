# セルフホストGPUで hero モーションを作る (RunPod + ComfyUI)

fal の従量課金 (Kling 3.0 = 月約$38) を GPU 時間だけ (月$4-7 見込み) に置き換える経路。
**MiniMax H3 がオープンウェイトで公開されたため成立する**（商用可・年商$20M未満・米/EU/英/韓は対象外）。

## 仕組み

`fetch-broll.ts` が `MOTION_BACKEND=runpod` のとき、1回の実行で:

1. `RUNPOD_POD_ID` のポッドを **start**（REST v1 `POST /pods/{id}/start`）
2. ComfyUI が `https://{podId}-8188.proxy.runpod.net/system_stats` に応答するまで待つ
   （公式注意: 「RUNNING 表示でも中のサービスは未起動」なのでステータスでは判定しない）
3. hero 画像を `POST /upload/image` → ワークフローに差し込み `POST /prompt`
4. `GET /history/{id}` をポーリング → 出力 mp4 を `GET /view` で取得
5. 3本ぶん直列で回してから **必ず stop**（`finally` + CI 側 `if: always()` の二重）

失敗しても **fal → 静止画** と段階的に降格するので、本数ゼロにはなりません。

## オーナー側の準備（一度だけ）

1. **RunPod アカウント** → API キー発行 → GitHub Secrets に `RUNPOD_API_KEY`
2. **ネットワークボリューム**を作成（45GB 目安。H3 の重みが約42.5GB。$0.07/GB/月 ≈ $3.15/月）
3. そのボリュームを付けた **Pod を1つ作成**（GPU: RTX 4090 / Community 可、image: ComfyUI 入りのもの、
   ポート `8188/http` を公開）。ボリューム内に ComfyUI と H3 の重みを入れておく
   - 重み: HuggingFace `Comfy-Org/MiniMax-H3`（ComfyUI 用リパック版）
   - VRAM は 24GB が安心。12GB でもオフロードで動く報告あり（RAM は多めに）
4. Pod の ID を GitHub Secrets に `RUNPOD_POD_ID`
5. ComfyUI で H3 の image-to-video ワークフローを組み、**動くことを手で確認**してから
   `Workflow > Export (API Format)` で書き出し、このディレクトリに
   **`motion-workflow.json`** として置く（`git add` 必須。CI から読みます）
6. ワークフロー内の3ノードに**タイトルを付ける**（右クリック → Title）:
   - 画像入力ノード（LoadImage 等） → `MOTION_INPUT_IMAGE`
   - プロンプト入力ノード → `MOTION_PROMPT`
   - シードを持つノード（KSampler 等・任意） → `MOTION_SEED`
   タイトルの代わりにノード ID を使う場合は `motion-workflow.map.json` を
   `{"imageNodeId":"12","promptNodeId":"6","seedNodeId":"3"}` の形に書き換える
7. GitHub の **Variables** に `MOTION_BACKEND=runpod` を設定（Secrets ではなく Variables）
   - 戻したいときは `fal` にするだけ。`off` で動画化を止められる

## 動作確認

```bash
# 手動 preview（投稿なし）で通す
gh workflow run publish.yml -f mode=preview -f script_source_file=content/dw60-ukraine-2026-06-19.json
```

ログで見るべき行:

- `[runpod] ComfyUI ready at https://...proxy.runpod.net (costPerHr=$...)`
- `[runpod] {code}: hero motion clip generated (self-hosted, N.NMB)`
- `[runpod] pod stopped after N.Nmin of GPU time` ← **これが出ないと課金が続きます**

## 課金の安全網

- `fetch-broll` は `finally` で必ず stop
- CI 最終ステップ `Stop RunPod GPU pod (safety net)` が `if: always()` で再度 stop
- 手動の非常停止: `RUNPOD_API_KEY=... RUNPOD_POD_ID=... npx tsx scripts/runpod-stop.ts`
- タイムアウト: ポッド起動待ち 10分 / 1本の生成 15分（`RUNPOD_BOOT_TIMEOUT_MS` / `COMFY_JOB_TIMEOUT_MS`）

## 未検証の前提（実際に動かすまで確定しない）

- H3 の ComfyUI ワークフローが 5秒・9:16 で安定して出力できるか（**手で1回確認してから export**）
- 480p で出た場合の見た目（動画では「480p→アップスケール」運用が紹介されている）
- ポッド起動〜モデルロードの実時間（課金はここも含む）
