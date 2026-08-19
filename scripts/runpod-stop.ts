/**
 * 非常停止スクリプト: RUNPOD_POD_ID のポッドを止めるだけ。
 * CI が途中で落ちてもポッドが起動し続けて課金され続けるのを防ぐため、
 * publish.yml の最後で `if: always()` から呼ぶ。手動実行も可:
 *   RUNPOD_API_KEY=... RUNPOD_POD_ID=... npx tsx scripts/runpod-stop.ts
 * 既に停止済み/未設定でも失敗させない (CI を赤くしない)。
 */
import { getPod, stopPod } from "./lib/runpod.js";

async function main() {
  const podId = process.env.RUNPOD_POD_ID?.trim();
  if (!podId) { console.log("[runpod-stop] RUNPOD_POD_ID 未設定 — 何もしません"); return; }
  if (!process.env.RUNPOD_API_KEY?.trim()) { console.log("[runpod-stop] RUNPOD_API_KEY 未設定 — 何もしません"); return; }
  try {
    const pod = await getPod(podId);
    if (pod.desiredStatus !== "RUNNING") {
      console.log(`[runpod-stop] pod ${podId} は既に ${pod.desiredStatus} — 何もしません`);
      return;
    }
    console.log(`[runpod-stop] pod ${podId} が RUNNING のため停止します (costPerHr=$${pod.costPerHr ?? "?"})`);
    await stopPod(podId);
  } catch (e) {
    console.warn(`[runpod-stop] 確認/停止に失敗: ${e instanceof Error ? e.message : e}`);
  }
}

main().catch(e => { console.warn(`[runpod-stop] ${e}`); });
