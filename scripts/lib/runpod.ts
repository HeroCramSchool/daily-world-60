/**
 * RunPod ポッドのライフサイクル制御 (AI動画をセルフホストGPUで生成するため)。
 * API は REST v1 (https://rest.runpod.io/v1・Bearer 認証) を使用。実仕様は OpenAPI で確認済み:
 *   POST /pods/{id}/start, POST /pods/{id}/stop, GET /pods/{id}
 *   GET のレスポンス: { id, desiredStatus: RUNNING|EXITED|TERMINATED, publicIp, portMappings, costPerHr }
 * ComfyUI への到達は RunPod の HTTP プロキシ https://{podId}-{port}.proxy.runpod.net を第一経路、
 * publicIp:portMappings を第二経路にする (docs 記載の公式パターン)。
 *
 * 重要: 課金は起動中ずっと発生するため、呼び出し側は必ず finally で stopPod() すること。
 */

const API = "https://rest.runpod.io/v1";

export type PodInfo = {
  id: string;
  desiredStatus?: string;
  publicIp?: string | null;
  portMappings?: Record<string, number> | null;
  costPerHr?: number;
};

function key(): string {
  const k = process.env.RUNPOD_API_KEY?.trim();
  if (!k) throw new Error("RUNPOD_API_KEY is not set");
  return k;
}

async function rp(method: "GET" | "POST" | "DELETE", path: string, timeoutMs = 30000): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`runpod ${method} ${path} HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function getPod(podId: string): Promise<PodInfo> {
  return (await rp("GET", `/pods/${podId}`)) as PodInfo;
}

export async function startPod(podId: string): Promise<void> {
  await rp("POST", `/pods/${podId}/start`, 60000);
}

/** 停止。課金を止める最重要処理なので、失敗しても投げずに結果を返す (呼び出し側の finally を壊さない)。 */
export async function stopPod(podId: string): Promise<boolean> {
  try {
    await rp("POST", `/pods/${podId}/stop`, 60000);
    return true;
  } catch (e) {
    console.error(`[runpod] STOP FAILED for ${podId} (${e instanceof Error ? e.message : e}) — 課金が続く可能性あり。手動で停止してください`);
    return false;
  }
}

/** ComfyUI の候補 URL (プロキシ優先)。 */
export function comfyUrls(pod: PodInfo, port: number): string[] {
  const urls = [`https://${pod.id}-${port}.proxy.runpod.net`];
  const mapped = pod.portMappings?.[String(port)];
  if (pod.publicIp && mapped) urls.push(`http://${pod.publicIp}:${mapped}`);
  return urls;
}

/**
 * ポッドを起動し ComfyUI が応答するまで待つ。戻り値は使える base URL。
 * 「RUNNING 表示でも中のサービスは未起動」という公式注意書きに従い、
 * ステータスではなく /system_stats の応答で ready を判定する。
 */
export async function startPodAndWaitComfy(podId: string, port: number, timeoutMs: number): Promise<{ base: string; pod: PodInfo }> {
  const deadline = Date.now() + timeoutMs;
  const before = await getPod(podId);
  if (before.desiredStatus !== "RUNNING") {
    console.log(`[runpod] starting pod ${podId} (status=${before.desiredStatus})`);
    await startPod(podId);
  } else {
    console.log(`[runpod] pod ${podId} already RUNNING`);
  }
  let lastErr = "";
  for (;;) {
    if (Date.now() > deadline) throw new Error(`runpod: ComfyUI not ready within ${Math.round(timeoutMs / 1000)}s (${lastErr})`);
    await sleep(10000);
    let pod: PodInfo;
    try {
      pod = await getPod(podId);
    } catch (e) {
      lastErr = String(e); continue;
    }
    if (pod.desiredStatus === "TERMINATED") throw new Error("runpod: pod is TERMINATED");
    for (const base of comfyUrls(pod, port)) {
      try {
        const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          console.log(`[runpod] ComfyUI ready at ${base} (costPerHr=$${pod.costPerHr ?? "?"})`);
          return { base, pod };
        }
        lastErr = `${base} HTTP ${res.status}`;
      } catch (e) {
        lastErr = `${base} ${e instanceof Error ? e.message : e}`;
      }
    }
  }
}
