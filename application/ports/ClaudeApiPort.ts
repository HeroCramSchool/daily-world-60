/**
 * Claude（または別のLLM）への抽象アクセス。
 * domain は LLM の存在を知らない。usecase が ClaudeApiPort 経由で呼ぶ。
 */
export interface ClaudeApiPort {
  /**
   * 構造化出力（JSON）を返す呼び出し。
   * - prompt: ユーザーメッセージ
   * - system: システムプロンプト
   * - jsonSchemaName: JSON出力モードのスキーマ名（ロギング用）
   */
  generateJson<T>(input: {
    system: string;
    prompt: string;
    jsonSchemaName: string;
    maxTokens?: number;
  }): Promise<T>;
}
