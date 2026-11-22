import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import worker, { type Env } from "./worker.js";

export interface LocalRuntimeOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  env?: Partial<Env>;
}

export interface RunningLocalPod {
  url: string;
  port: number;
  dbPath: string;
  db: SqliteFileStorage;
  server: Server;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Starts the actual local Node HTTP server backed by SqliteFileStorage (PodStorage)
 * and delegates every request through the exact same `worker.fetch()` entrypoint.
 */
export async function startLocalMeasurementPod(options: LocalRuntimeOptions = {}): Promise<RunningLocalPod> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  let dbPath = options.dbPath;
  if (!dbPath) {
    const dir = join(tmpdir(), `measurement_pod_${Date.now()}`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    dbPath = join(dir, "measurement.sqlite");
  } else {
    const parent = dirname(dbPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  }

  const db = new SqliteFileStorage(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // Ignore on platforms where chmod is unsupported
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, "..", "schema.sql");
  db.exec(readFileSync(schemaPath, "utf8"));

  const runtimeEnv: Env = {
    DB: db,
    POD_ID: process.env.POD_ID || "measurement-pod",
    POD_NAME: process.env.POD_NAME || "Measurement Pod",
    POD_ROLE: process.env.POD_ROLE || "measurement",
    POD_LOB: process.env.POD_LOB || "measurement-evidence",
    FACTORY_HUB_TOKEN: process.env.FACTORY_HUB_TOKEN,
    SCOPED_CALLER_GRANTS: process.env.SCOPED_CALLER_GRANTS,
    ...options.env,
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      const fullUrl = `http://${host}:${boundPort}${req.url || "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) headers.set(k, v.join(", "));
        else headers.set(k, v);
      }

      const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
      const bodyBuf = hasBody ? await readBody(req) : undefined;
      const webReq = new Request(fullUrl, {
        method: req.method || "GET",
        headers,
        body: bodyBuf && bodyBuf.length > 0 ? new Uint8Array(bodyBuf) : undefined,
      });

      const webRes = await worker.fetch(webReq, runtimeEnv);
      res.statusCode = webRes.status;
      webRes.headers.forEach((value, key) => res.setHeader(key, value));
      const respBuf = Buffer.from(await webRes.arrayBuffer());
      res.end(respBuf);
    } catch (err: any) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err?.message || "Local runtime error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };

  return { url, port: actualPort, dbPath, db, server, close };
}

// CLI entrypoint when executed directly (`tsx src/main.ts serve`)
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  const port = Number.parseInt(process.env.PORT || "8791", 10) || 8791;
  const dbPath = process.env.MEASUREMENT_DB_PATH || undefined;
  startLocalMeasurementPod({ host: "127.0.0.1", port, dbPath })
    .then((pod) => {
      console.log(`measurement-pod listening on ${pod.url} (db=${pod.dbPath})`);
      const shutdown = async () => {
        await pod.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("Failed to start measurement-pod:", err);
      process.exit(1);
    });
}
