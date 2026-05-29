import type { Platform } from "./Platform.js";

export interface PublishingResult {
  readonly platform: Platform;
  readonly ok: boolean;
  readonly url?: string;
  readonly id?: string;
  readonly error?: string;
  readonly draft?: boolean; // 下書き保存のみの場合
}
