export interface Audio {
  readonly filePath: string;
  readonly durationSeconds: number;
  readonly format: "mp3" | "wav";
}
