import {
  PodStorage,
  PodPreparedStatement,
  PodQueryResult,
  PodRunResult,
  D1DatabaseLike,
  D1PreparedStatementLike,
  POD_STORAGE_BRAND,
} from "./types.js";

export class D1PreparedStatementWrapper implements PodPreparedStatement {
  constructor(public readonly raw: D1PreparedStatementLike) {}

  bind(...params: unknown[]): PodPreparedStatement {
    return new D1PreparedStatementWrapper(this.raw.bind(...params));
  }

  async all<T = Record<string, unknown>>(): Promise<PodQueryResult<T>> {
    const res = await this.raw.all<T>();
    if (res && Array.isArray(res.results)) {
      return res as PodQueryResult<T>;
    }
    return {
      results: res?.results || [],
      meta: res?.meta,
      success: res?.success,
    };
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = colName ? await this.raw.first<T>(colName) : await this.raw.first<T>();
    return row ?? null;
  }

  async run(): Promise<PodRunResult> {
    const res = await this.raw.run();
    if (res?.meta && typeof res.meta.changes === "number") {
      return res as PodRunResult;
    }
    return {
      success: res?.success,
      meta: {
        changes: res?.meta?.changes ?? 0,
        last_row_id: res?.meta?.last_row_id,
        duration: res?.meta?.duration,
        ...res?.meta,
      },
    };
  }
}

export class D1Storage implements PodStorage {
  public readonly [POD_STORAGE_BRAND] = true as const;

  constructor(private readonly d1: D1DatabaseLike) {}

  get raw(): D1DatabaseLike {
    return this.d1;
  }

  prepare(query: string): PodPreparedStatement {
    return new D1PreparedStatementWrapper(this.d1.prepare(query));
  }

  async batch<T = unknown>(statements: PodPreparedStatement[]): Promise<PodQueryResult<T>[]> {
    const rawStmts = statements.map((s) => {
      if (s instanceof D1PreparedStatementWrapper) {
        return s.raw;
      }
      if (s && typeof s === "object" && "raw" in s) {
        const rawCandidate = s.raw;
        if (rawCandidate && typeof rawCandidate === "object" && "bind" in rawCandidate) {
          return rawCandidate as D1PreparedStatementLike;
        }
      }
      return s as unknown as D1PreparedStatementLike;
    });

    const results = await this.d1.batch<T>(rawStmts);
    if (Array.isArray(results) && results.every((r) => r && Array.isArray(r.results))) {
      return results as unknown as PodQueryResult<T>[];
    }
    return results.map((r) => ({
      results: r?.results || [],
      meta: r?.meta,
      success: r?.success,
    }));
  }

  async exec(sql: string): Promise<void> {
    if (this.d1.exec) {
      await this.d1.exec(sql);
    } else {
      await this.prepare(sql).run();
    }
  }
}
