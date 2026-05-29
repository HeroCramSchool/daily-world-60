import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeApiPort } from "../../application/ports/ClaudeApiPort.js";

const DEFAULT_MODEL = "claude-opus-4-7";

export class ClaudeApiClient implements ClaudeApiPort {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    this.client = new Anthropic({
      apiKey: options?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.model = options?.model ?? DEFAULT_MODEL;
  }

  async generateJson<T>(input: {
    system: string;
    prompt: string;
    jsonSchemaName: string;
    maxTokens?: number;
  }): Promise<T> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: input.maxTokens ?? 2000,
      system: input.system,
      messages: [
        {
          role: "user",
          content: input.prompt + "\n\nIMPORTANT: Reply with ONLY raw JSON. No markdown fences, no commentary.",
        },
      ],
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => (b as { text: string }).text)
      .join("");

    return this.parseJson<T>(text, input.jsonSchemaName);
  }

  private parseJson<T>(raw: string, schemaName: string): T {
    // ```json ... ``` フェンスを剥がす保険
    const trimmed = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch (e) {
      throw new Error(
        `Failed to parse JSON for schema "${schemaName}": ${e instanceof Error ? e.message : e}\nRaw: ${raw.slice(0, 500)}`,
      );
    }
  }
}
