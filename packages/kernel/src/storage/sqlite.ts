import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import {
  PodStorage,
  PodPreparedStatement,
  PodQueryResult,
  PodRunResult,
  POD_STORAGE_BRAND,
} from "./types.js";

export interface SqliteStorageOptions {
  wal?: boolean;
  schema?: string;
}

function toSqlInputValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return value as SQLInputValue;
  }
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return value as SQLInputValue;
  }
  return String(value);
}

interface StatementWithColumns {
  columns?: () => unknown[];
}

function isRowProducingStatement(stmt: object): boolean {
  if (!("columns" in stmt) || typeof (stmt as StatementWithColumns).columns !== "function") {
    throw new Error(
      "SqliteFileStorage requires Node.js >= 22.16.0 with StatementSync.prototype.columns metadata support; " +
      "earlier runtimes lack row-producing statement metadata"
    );
  }
  const cols = (stmt as StatementWithColumns).columns!();
  return Array.isArray(cols) && cols.length > 0;
}


interface ConnectionMutationMeta {
  changes: number;
  last_row_id?: number;
  [key: string]: unknown;
}

function readConnectionTotalChanges(db: DatabaseSync): number {
  const row = db.prepare("SELECT total_changes() AS tc").get() as { tc?: number } | undefined;
  return Number(row?.tc ?? 0);
}

function readConnectionMutationMeta(db: DatabaseSync, diff: number): ConnectionMutationMeta {
  if (diff <= 0) {
    return { changes: 0 };
  }
  const row = db.prepare("SELECT last_insert_rowid() AS lid").get() as
    | { lid?: number | bigint }
    | undefined;
  return {
    changes: diff,
    last_row_id: Number(row?.lid ?? 0),
  };
}


export class SqlitePreparedStatement implements PodPreparedStatement {
  public readonly params: readonly SQLInputValue[];

  constructor(
    private readonly db: DatabaseSync,
    public readonly sql: string,
    params: readonly unknown[] = [],
  ) {
    this.params = params.map(toSqlInputValue);
  }

  bind(...params: unknown[]): PodPreparedStatement {
    return new SqlitePreparedStatement(this.db, this.sql, params);
  }

  async all<T = Record<string, unknown>>(): Promise<PodQueryResult<T>> {
    const stmt = this.db.prepare(this.sql);
    const tcBefore = readConnectionTotalChanges(this.db);
    const rows = stmt.all(...this.params) as unknown as T[];
    const tcAfter = readConnectionTotalChanges(this.db);
    const meta = readConnectionMutationMeta(this.db, tcAfter - tcBefore);
    return {
      results: rows,
      meta,
    };
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) {
      const colValue = row[colName];
      return (colValue as T) ?? null;
    }
    return row as unknown as T;
  }

  async run(): Promise<PodRunResult> {
    const stmt = this.db.prepare(this.sql);
    const tcBefore = readConnectionTotalChanges(this.db);
    stmt.run(...this.params);
    const tcAfter = readConnectionTotalChanges(this.db);
    const meta = readConnectionMutationMeta(this.db, tcAfter - tcBefore);
    return {
      success: true,
      meta,
    };
  }
}

/**
 * Persistent local-file SQLite storage adapter backed by Node.js built-in `node:sqlite`.
 * Requires Node.js >= 22.16.0+ (where node:sqlite exposes StatementSync.prototype.columns) or Node.js active LTS / current.
 * Node-only scope: this adapter uses Node's native DatabaseSync module and is isolated from
 * Cloudflare Workers edge bundles. It does not imply Bun compatibility.
 */
export class SqliteFileStorage implements PodStorage {
  public readonly [POD_STORAGE_BRAND] = true as const;
  private readonly db: DatabaseSync;
  constructor(pathOrDb: string | DatabaseSync, options?: SqliteStorageOptions) {
    if (typeof pathOrDb === "string") {
      if (pathOrDb !== ":memory:") {
        const dir = dirname(pathOrDb);
        mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(pathOrDb);
      if (options?.wal !== false && pathOrDb !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
      }
    } else {
      this.db = pathOrDb;
    }

    if (options?.schema) {
      this.db.exec(options.schema);
    }
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  prepare(query: string): PodPreparedStatement {
    return new SqlitePreparedStatement(this.db, query);
  }

  async batch<T = unknown>(statements: PodPreparedStatement[]): Promise<PodQueryResult<T>[]> {
    this.db.exec("BEGIN");
    try {
      const results: PodQueryResult<T>[] = [];
      for (const stmt of statements) {
        if (!stmt || typeof stmt !== "object") {
          throw new Error("SqliteFileStorage.batch() received an invalid statement");
        }
        let sql: string | undefined;
        let params: readonly SQLInputValue[] = [];

        if (stmt instanceof SqlitePreparedStatement) {
          sql = stmt.sql;
          params = stmt.params;
        } else if ("sql" in stmt && typeof stmt.sql === "string") {
          sql = stmt.sql;
          if ("params" in stmt && Array.isArray(stmt.params)) {
            params = stmt.params.map(toSqlInputValue);
          }
        }

        if (!sql) {
          throw new Error("SqliteFileStorage.batch() statement must provide a SQL query string");
        }

        const rawStmt = this.db.prepare(sql);
        const isRowProducing = isRowProducingStatement(rawStmt);
        if (isRowProducing) {
          const tcBefore = readConnectionTotalChanges(this.db);
          const rows = rawStmt.all(...params) as unknown as T[];
          const tcAfter = readConnectionTotalChanges(this.db);
          const meta = readConnectionMutationMeta(this.db, tcAfter - tcBefore);
          results.push({
            results: rows,
            meta,
          });
        } else {
          const tcBefore = readConnectionTotalChanges(this.db);
          rawStmt.run(...params);
          const tcAfter = readConnectionTotalChanges(this.db);
          const meta = readConnectionMutationMeta(this.db, tcAfter - tcBefore);
          results.push({
            results: [],
            meta,
          });
        }
      }
      this.db.exec("COMMIT");
      return results;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // preserve original error
      }
      throw err;
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
