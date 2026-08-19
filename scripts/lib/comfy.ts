/**
 * ComfyUI HTTP API クライアント (RunPod 上の ComfyUI に投げる)。
 * ルートは ComfyUI 本体の server.py で実在を確認済み:
 *   POST /upload/image, POST /prompt, GET /history/{prompt_id}, GET /view, GET /system_stats
 *
 * ワークフローはリポジトリ内の JSON (ComfyUI の "Save (API Format)" で書き出したもの) を使い、
 * 差し込み位置は map ファイルで指定する。こうすればモデル固有のノード名に依存せず、
 * H3 でも Wan でも同じコードで動く。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export type WorkflowMap = {
  /** LoadImage 相当ノードの id。inputs.image に アップロード後のファイル名を入れる */
  imageNodeId?: string;
  /** プロンプト текст ノードの id。inputs.text にモーション指示を入れる */
  promptNodeId?: string;
  /** シードノードの id (任意)。inputs.seed / inputs.noise_seed に入れる */
  seedNodeId?: string;
  /** ノード id ではなくタイトル (_meta.title) で探す場合に使う */
  imageNodeTitle?: string;
  promptNodeTitle?: string;
  seedNodeTitle?: string;
};

type Node = { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } };
type Workflow = Record<string, Node>;

const VIDEO_EXT = /\.(mp4|webm|mov|gif)$/i;

export async function loadWorkflow(wfPath: string, mapPath: string): Promise<{ wf: Workflow; map: WorkflowMap }> {
  const wf = JSON.parse(await fs.readFile(wfPath, "utf-8")) as Workflow;
  const map = JSON.parse(await fs.readFile(mapPath, "utf-8")) as WorkflowMap;
  return { wf, map };
}

function findNodeId(wf: Workflow, id?: string, title?: string): string | undefined {
  if (id && wf[id]) return id;
  if (title) {
    const hit = Object.entries(wf).find(([, n]) => (n._meta?.title ?? "").trim().toLowerCase() === title.trim().toLowerCase());
    if (hit) return hit[0];
  }
  return undefined;
}

/** ワークフローに画像名・プロンプト・シードを差し込んだコピーを返す。 */
export function fillWorkflow(
  wf: Workflow, map: WorkflowMap,
  vals: { imageName: string; prompt: string; seed: number },
): Workflow {
  const out = JSON.parse(JSON.stringify(wf)) as Workflow;

  const imgId = findNodeId(out, map.imageNodeId, map.imageNodeTitle);
  if (!imgId) throw new Error("comfy: image node not found (imageNodeId/imageNodeTitle を map に設定してください)");
  out[imgId].inputs = { ...(out[imgId].inputs ?? {}), image: vals.imageName };

  const pId = findNodeId(out, map.promptNodeId, map.promptNodeTitle);
  if (!pId) throw new Error("comfy: prompt node not found (promptNodeId/promptNodeTitle を map に設定してください)");
  const pInputs = { ...(out[pId].inputs ?? {}) };
  // text / prompt / string のうち既存キーに入れる (ノード実装差を吸収)
  const textKey = ["text", "prompt", "string"].find(k => k in pInputs) ?? "text";
  pInputs[textKey] = vals.prompt;
  out[pId].inputs = pInputs;

  const sId = findNodeId(out, map.seedNodeId, map.seedNodeTitle);
  if (sId) {
    const sInputs = { ...(out[sId].inputs ?? {}) };
    const seedKey = ["seed", "noise_seed"].find(k => k in sInputs) ?? "seed";
    sInputs[seedKey] = vals.seed;
    out[sId].inputs = sInputs;
  }
  return out;
}

/** hero 画像を ComfyUI の input へアップロードし、サーバ側ファイル名を返す。 */
export async function uploadImage(base: string, filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const name = path.basename(filePath);
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(buf)], { type: "image/jpeg" }), name);
  form.append("overwrite", "true");
  form.append("type", "input");
  const res = await fetch(`${base}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`comfy upload HTTP ${res.status}`);
  const j = (await res.json()) as { name?: string; subfolder?: string };
  if (!j.name) throw new Error("comfy upload: no name in response");
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

export async function submitPrompt(base: string, workflow: Workflow): Promise<string> {
  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`comfy /prompt HTTP ${res.status}${text ? ` ${text.slice(0, 300)}` : ""}`);
  const j = JSON.parse(text) as { prompt_id?: string; error?: unknown };
  if (!j.prompt_id) throw new Error(`comfy /prompt: no prompt_id (${text.slice(0, 200)})`);
  return j.prompt_id;
}

type FileRef = { filename: string; subfolder?: string; type?: string };

/** history をポーリングし、動画の出力ファイル参照を返す。 */
export async function waitForVideo(base: string, promptId: string, timeoutMs: number): Promise<FileRef> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`comfy: job ${promptId} timed out after ${Math.round(timeoutMs / 60000)}min`);
    await new Promise(r => setTimeout(r, 10000));
    const res = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (!res || !res.ok) continue;
    const hist = (await res.json().catch(() => ({}))) as Record<string, {
      status?: { completed?: boolean; status_str?: string; messages?: unknown };
      outputs?: Record<string, Record<string, FileRef[]>>;
    }>;
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw new Error(`comfy: job failed (${JSON.stringify(entry.status.messages ?? "").slice(0, 300)})`);
    }
    const outputs = entry.outputs ?? {};
    const files: FileRef[] = [];
    for (const perNode of Object.values(outputs)) {
      for (const arr of Object.values(perNode)) {
        if (Array.isArray(arr)) for (const f of arr) if (f?.filename) files.push(f);
      }
    }
    const video = files.find(f => /\.mp4$/i.test(f.filename)) ?? files.find(f => VIDEO_EXT.test(f.filename));
    if (video) return video;
    if (entry.status?.completed && files.length === 0) throw new Error("comfy: job completed but produced no files");
  }
}

export async function downloadOutput(base: string, ref: FileRef): Promise<Buffer> {
  const q = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "output",
  });
  const res = await fetch(`${base}/view?${q}`, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`comfy /view HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
