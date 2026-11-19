export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SETUP_TOKEN?: string;
  SESSION_SECRET: string;
  DOWNLOAD_LOG_RETENTION_DAYS?: string;
}
