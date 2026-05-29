export interface Video {
  readonly filePath: string;
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly format: "mp4";
}
