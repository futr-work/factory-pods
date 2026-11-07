export type SqlParam =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | Uint8Array
  | ArrayBuffer;

export interface PodQueryResultMeta {
  changes?: number;
  last_row_id?: number;
  duration?: number;
  [key: string]: unknown;
}

export interface PodQueryResult<T = Record<string, unknown>> {
  results: T[];
  meta?: PodQueryResultMeta;
  success?: boolean;
}

export interface PodRunResult {
  success?: boolean;
  meta: {
    changes?: number;
    last_row_id?: number;
    duration?: number;
    [key: string]: unknown;
  };
}

export interface PodPreparedStatement {
  bind(...params: unknown[]): PodPreparedStatement;
  all<T = Record<string, unknown>>(): Promise<PodQueryResult<T>>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run(): Promise<PodRunResult>;
}
export const POD_STORAGE_BRAND = Symbol.for("@futr-work/pod-kernel/pod-storage");

export interface PodStorage {
  readonly [POD_STORAGE_BRAND]: true;
  prepare(query: string): PodPreparedStatement;
  batch<T = unknown>(statements: PodPreparedStatement[]): Promise<PodQueryResult<T>[]>;
  exec?(sql: string): Promise<void> | void;
  close?(): Promise<void> | void;
}

/** Minimal shape matching Cloudflare D1Database for zero-overhead structural compatibility */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
  exec?(query: string): Promise<D1ExecResultLike>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1ResultLike<T>>;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
}

export interface D1ResultLike<T = unknown> {
  results?: T[];
  success?: boolean;
  meta?: {
    changes?: number;
    last_row_id?: number;
    duration?: number;
    [key: string]: unknown;
  };
  error?: string;
}

export interface D1ExecResultLike {
  count: number;
  duration: number;
}
