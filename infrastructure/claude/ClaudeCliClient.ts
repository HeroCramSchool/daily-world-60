import { spawn } from "node:child_process";
import type { ClaudeApiPort } from "../../application/ports/ClaudeApiPort.js";

/**
 * `claude -p` CLI 経由で LLM を呼ぶ実装。
 *
 * メリット:
 * - API キー不要（Claude Pro サブスクの OAuth で動作）
 * - Anthropic Routine からも同じ仕組みで呼べる
 *
 * 注意:
 * - `claude` CLI が PATH にある必要あり
 * - --print（非対話）モードで動く
 */
export class ClaudeCliClient implements ClaudeApiPort {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly cwd: string | undefined;

  constructor(options?: { binary?: string; timeoutMs?: number; cwd?: string }) {
    this.binary = options?.binary ?? "claude";
    this.timeoutMs = options?.timeoutMs ?? 300_000; // 5 min
    this.cwd = options?.cwd;
  }

  async generateJson<T>(input: {
    system: string;
    prompt: string;
    jsonSchemaName: string;
    maxTokens?: number;
  }): Promise<T> {
    const userPrompt =
      input.prompt +
      "\n\nIMPORTANT: Reply with ONLY raw JSON, no markdown fences, no commentary, no preamble.";

    const args = [
      "-p", userPrompt,
      "--append-system-prompt", input.system,
      "--output-format", "text",
    ];

    const stdout = await this.runCmd(this.binary, args);
    return this.parseJson<T>(stdout, input.jsonSchemaName);
  }

  private runCmd(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: this.cwd,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`claude CLI timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.stdout.on("data", d => (stdout += d.toString()));
      proc.stderr.on("data", d => (stderr += d.toString()));
      proc.on("error", err => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", code => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 500)}`));
      });
    });
  }

  private parseJson<T>(raw: string, schemaName: string): T {
    let s = raw.trim();
    // ```json ``` フェンス除去
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    // 先頭の説明文を切り捨てて { から始める保険
    const firstBrace = s.indexOf("{");
    const firstBracket = s.indexOf("[");
    const start =
      firstBrace === -1
        ? firstBracket
        : firstBracket === -1
          ? firstBrace
          : Math.min(firstBrace, firstBracket);
    if (start > 0) s = s.slice(start);
    try {
      return JSON.parse(s) as T;
    } catch (e) {
      throw new Error(
        `Failed to parse JSON for "${schemaName}": ${e instanceof Error ? e.message : e}\nRaw (head): ${raw.slice(0, 400)}`,
      );
    }
  }
}
