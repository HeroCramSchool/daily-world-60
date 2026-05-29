export interface Thumbnail {
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
  readonly format: "png" | "jpg";
}
