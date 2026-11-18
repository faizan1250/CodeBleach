export interface PublishFailure {
  file: string;
  line: number;
  reason: string;
}

export interface PublishResult {
  published: number;
  skipped: number;
  failures: PublishFailure[];
}
