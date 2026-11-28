import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SqliteFileStorage } from "@futr-work/pod-kernel/storage/sqlite";
import { ensureAccountsSchemaReady } from "./service.js";
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

export async function startLocalAccountsPod(options: LocalRuntimeOptions = {}): Promise<RunningLocalPod> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  let dbPath = options.dbPath;
  if (!dbPath) {
    const dir = join(tmpdir(), `accounts_pod_${Date.now()}`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    dbPath = join(dir, "accounts.sqlite");
  } else {
    const parent = dirname(dbPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  }

  const db = new SqliteFileStorage(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // ignore on platforms without chmod
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, "..", "schema.sql");
  db.exec(readFileSync(schemaPath, "utf8"));
  await ensureAccountsSchemaReady(db);

  const runtimeEnv: Env = {
    DB: db,
    POD_ID: process.env.POD_ID || "accounts-pod",
    POD_NAME: process.env.POD_NAME || "Accounts Pod",
    POD_ROLE: process.env.POD_ROLE || "accounts",
    POD_LOB: process.env.POD_LOB || "identity-access-registry",
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
      res.end(Buffer.from(await webRes.arrayBuffer()));
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Local runtime error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;
  return {
    url,
    port: actualPort,
    dbPath,
    db,
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  const port = Number.parseInt(process.env.PORT || "8792", 10) || 8792;
  const dbPath = process.env.ACCOUNTS_DB_PATH || undefined;
  startLocalAccountsPod({ host: "127.0.0.1", port, dbPath })
    .then((pod) => {
      console.log(`accounts-pod listening on ${pod.url} (db=${pod.dbPath})`);
      const shutdown = async () => {
        await pod.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("Failed to start accounts-pod:", err);
      process.exit(1);
    });
}
