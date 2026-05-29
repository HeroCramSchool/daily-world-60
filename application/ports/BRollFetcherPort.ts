export interface BRollClip {
  readonly filePath: string;
  readonly durationSeconds: number;
  readonly query: string;
}

export interface BRollFetcherPort {
  fetch(input: {
    query: string;
    minDurationSeconds: number;
    outputPath: string;
  }): Promise<BRollClip>;
}
