import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync, existsSync } from "node:fs";
import {
  PodStorage,
  D1Storage,
  PodPreparedStatement,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  POD_STORAGE_BRAND,
  isPodStorage,
  toPodStorage,
} from "../src/storage/index.js";
import { SqliteFileStorage } from "../src/storage/sqlite.js";
import * as EdgeStorage from "../src/storage/index.js";
import * as RootKernel from "../src/index.js";

describe("PodStorage Abstraction Suite", () => {
  const tempFiles: string[] = [];

  test("edge safety: default storage exports and root exports do not expose SqliteFileStorage or node:sqlite", () => {
    assert.equal("SqliteFileStorage" in EdgeStorage, false);
    assert.equal("SqliteFileStorage" in RootKernel, false);
  });
  afterEach(() => {
    for (const f of tempFiles) {
      if (existsSync(f)) {
        try {
          unlinkSync(f);
        } catch {
          // ignore cleanup error
        }
      }
    }
    tempFiles.length = 0;
  });

  describe("SqliteFileStorage", () => {
    test("binding, run, first, and all with meta.changes and types", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          count INTEGER,
          note TEXT,
          active INTEGER
        );
      `);

      // 1. Run insert with parameter binding
      const insertStmt = storage.prepare(
        "INSERT INTO items (id, count, note, active) VALUES (?, ?, ?, ?)"
      );
      const runRes = await insertStmt.bind("item-1", 42, "hello", true).run();
      assert.equal(runRes.success, true);
      assert.equal(runRes.meta.changes, 1);
      assert.equal(typeof runRes.meta.last_row_id, "number");

      // Insert second row with undefined mapping to null
      await insertStmt.bind("item-2", 100, undefined, false).run();

      // 2. First query
      interface ItemRow {
        id: string;
        count: number;
        note: string | null;
        active: number;
      }

      const row1 = await storage
        .prepare("SELECT * FROM items WHERE id = ?")
        .bind("item-1")
        .first<ItemRow>();
      assert.ok(row1);
      assert.equal(row1.id, "item-1");
      assert.equal(row1.count, 42);
      assert.equal(row1.note, "hello");
      assert.equal(row1.active, 1);

      // First query with colName
      const note2 = await storage
        .prepare("SELECT note FROM items WHERE id = ?")
        .bind("item-2")
        .first<string>("note");
      assert.equal(note2, null);

      // First query missing row
      const missing = await storage
        .prepare("SELECT * FROM items WHERE id = ?")
        .bind("non-existent")
        .first<ItemRow>();
      assert.equal(missing, null);

      // 3. All query
      const allRes = await storage
        .prepare("SELECT * FROM items ORDER BY count ASC")
        .all<ItemRow>();
      assert.equal(allRes.results.length, 2);
      assert.equal(allRes.results[0].id, "item-1");
      assert.equal(allRes.results[1].id, "item-2");

      // 4. Update with meta.changes
      const updateRes = await storage
        .prepare("UPDATE items SET count = count + 1 WHERE active = ?")
        .bind(1)
        .run();
      assert.equal(updateRes.meta.changes, 1);

      // Delete with meta.changes
      const delRes = await storage
        .prepare("DELETE FROM items WHERE id = ?")
        .bind("item-2")
        .run();
      assert.equal(delRes.meta.changes, 1);
    });

    test("statement reuse and immutability of bind()", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);");

      const baseStmt = storage.prepare("INSERT INTO kv (k, v) VALUES (?, ?)");
      const stmtA = baseStmt.bind("k1", "v1");
      const stmtB = baseStmt.bind("k2", "v2");

      // Execute both separately
      await stmtA.run();
      await stmtB.run();

      const all = await storage.prepare("SELECT * FROM kv ORDER BY k ASC").all<{ k: string; v: string }>();
      assert.equal(all.results.length, 2);
      assert.equal(all.results[0].k, "k1");
      assert.equal(all.results[0].v, "v1");
      assert.equal(all.results[1].k, "k2");
      assert.equal(all.results[1].v, "v2");
    });

    test("batch atomicity: rollback on failure", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec("CREATE TABLE unique_items (id TEXT PRIMARY KEY, val TEXT);");

      const insertStmt = storage.prepare("INSERT INTO unique_items (id, val) VALUES (?, ?)");
      const batchStmts = [
        insertStmt.bind("a", "alpha"),
        insertStmt.bind("b", "beta"),
        insertStmt.bind("a", "duplicate-key-error"), // Will throw UNIQUE constraint
      ];

      await assert.rejects(async () => {
        await storage.batch(batchStmts);
      }, /UNIQUE constraint/);

      // Batch atomicity check: NEITHER "a" nor "b" should have been persisted
      const rows = await storage.prepare("SELECT * FROM unique_items").all();
      assert.equal(rows.results.length, 0, "All statements in failed batch must be rolled back");
    });

    test("batch execution: ordering and result shapes", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec("CREATE TABLE logs (msg TEXT);");

      const insertStmt = storage.prepare("INSERT INTO logs (msg) VALUES (?)");
      const batchStmts = [
        insertStmt.bind("first"),
        insertStmt.bind("second"),
        insertStmt.bind("third"),
      ];

      const batchResults = await storage.batch(batchStmts);
      assert.equal(batchResults.length, 3);
      for (const res of batchResults) {
        assert.equal(res.meta?.changes, 1);
      }

      const rows = await storage.prepare("SELECT msg FROM logs").all<{ msg: string }>();
      assert.deepEqual(
        rows.results.map((r) => r.msg),
        ["first", "second", "third"]
      );
    });

    test("batch execution with row-producing statements (leading comments, CTEs, RETURNING, PRAGMA) and writes", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          balance INTEGER NOT NULL
        );
      `);

      const batchStmts = [
        // 0. Ordinary write (non-row-producing)
        storage.prepare("INSERT INTO accounts (id, balance) VALUES (?, ?)").bind("acc-1", 100),
        // 1. Write with RETURNING (row-producing)
        storage.prepare("INSERT INTO accounts (id, balance) VALUES (?, ?) RETURNING id, balance").bind("acc-2", 250),
        // 2. Leading-comment SELECT (row-producing)
        storage.prepare("-- Fetch all accounts ordered by balance\nSELECT id, balance FROM accounts ORDER BY balance ASC"),
        // 3. CTE SELECT (row-producing)
        storage.prepare("WITH summary AS (SELECT COUNT(*) AS total, SUM(balance) AS total_balance FROM accounts) SELECT total, total_balance FROM summary"),
        // 4. Row-producing PRAGMA
        storage.prepare("PRAGMA table_info(accounts)"),
      ];

      const batchResults = await storage.batch(batchStmts);
      assert.equal(batchResults.length, 5, "Batch must produce 5 ordered results");

      // 0. Ordinary write
      assert.equal(batchResults[0].results.length, 0);
      assert.equal(batchResults[0].meta?.changes, 1);
      assert.equal(typeof batchResults[0].meta?.last_row_id, "number");

      // 1. RETURNING write
      interface AccRow { id: string; balance: number }
      assert.equal(batchResults[1].results.length, 1);
      assert.deepEqual({ ...batchResults[1].results[0] }, { id: "acc-2", balance: 250 });
      assert.equal(batchResults[1].meta?.changes, 1);
      assert.equal(typeof batchResults[1].meta?.last_row_id, "number");

      // 2. Leading-comment SELECT
      assert.equal(batchResults[2].results.length, 2);
      assert.deepEqual(
        batchResults[2].results.map((r) => ({ ...(r as object) })),
        [
          { id: "acc-1", balance: 100 },
          { id: "acc-2", balance: 250 },
        ]
      );
      assert.equal(batchResults[2].meta?.changes, 0);

      // 3. CTE SELECT
      assert.equal(batchResults[3].results.length, 1);
      assert.deepEqual({ ...batchResults[3].results[0] }, { total: 2, total_balance: 350 });
      assert.equal(batchResults[3].meta?.changes, 0);

      // 4. PRAGMA table_info
      assert.equal(batchResults[4].results.length, 2);
      assert.equal(batchResults[4].meta?.changes, 0);
    });

    test("runtime guard: missing statement metadata throws unsupported-runtime error and does not drop rows", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec("CREATE TABLE items (id TEXT);");
      const origPrepare = (storage as any).db.prepare.bind((storage as any).db);
      (storage as any).db.prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        // Wrapper omitting columns() metadata as on Node < 22.16.0
        return {
          all: (...args: any[]) => stmt.all(...args),
          get: (...args: any[]) => stmt.get(...args),
          run: (...args: any[]) => stmt.run(...args),
        };
      };

      try {
        await assert.rejects(async () => {
          await storage.batch([storage.prepare("SELECT * FROM items")]);
        }, /SqliteFileStorage requires Node\.js >= 22\.16\.0/);
      } finally {
        (storage as any).db.prepare = origPrepare;
      }
    });

    test("batch execution: INSERT RETURNING, UPDATE RETURNING, DELETE RETURNING, pure SELECT, row IDs, and rollback", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec(`
        CREATE TABLE bank_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          balance INTEGER NOT NULL
        );
      `);

      // 1. Single-statement execution & metadata: INSERT RETURNING, UPDATE RETURNING, DELETE RETURNING, pure SELECT
      const batch1 = await storage.batch([
        // 0: INSERT RETURNING (mutation, changes=1, last_row_id=1)
        storage.prepare("INSERT INTO bank_accounts (name, balance) VALUES (?, ?) RETURNING id, name, balance").bind("alice", 100),
        // 1: INSERT RETURNING (mutation, changes=1, last_row_id=2)
        storage.prepare("INSERT INTO bank_accounts (name, balance) VALUES (?, ?) RETURNING id, name, balance").bind("bob", 200),
        // 2: UPDATE RETURNING (mutation, changes=1, no stale last_row_id)
        storage.prepare("UPDATE bank_accounts SET balance = balance + 50 WHERE name = ? RETURNING id, name, balance").bind("alice"),
        // 3: Pure SELECT after prior mutations (query, changes=0, no last_row_id)
        storage.prepare("SELECT * FROM bank_accounts ORDER BY id ASC"),
        // 4: DELETE RETURNING (mutation, changes=1, no stale last_row_id)
        storage.prepare("DELETE FROM bank_accounts WHERE name = ? RETURNING id, name, balance").bind("bob"),
        // 5: Pure SELECT after DELETE (query, changes=0)
        storage.prepare("SELECT COUNT(*) AS active_count FROM bank_accounts"),
      ]);

      assert.equal(batch1.length, 6);

      // Stmt 0: INSERT RETURNING
      assert.equal(batch1[0].results.length, 1);
      assert.deepEqual({ ...batch1[0].results[0] }, { id: 1, name: "alice", balance: 100 });
      assert.equal(batch1[0].meta?.changes, 1);
      assert.equal(batch1[0].meta?.last_row_id, 1);

      // Stmt 1: INSERT RETURNING
      assert.equal(batch1[1].results.length, 1);
      assert.deepEqual({ ...batch1[1].results[0] }, { id: 2, name: "bob", balance: 200 });
      assert.equal(batch1[1].meta?.changes, 1);
      assert.equal(batch1[1].meta?.last_row_id, 2);

      // Stmt 2: UPDATE RETURNING
      assert.equal(batch1[2].results.length, 1);
      assert.deepEqual({ ...batch1[2].results[0] }, { id: 1, name: "alice", balance: 150 });
      assert.equal(batch1[2].meta?.changes, 1);
      assert.equal(typeof batch1[2].meta?.last_row_id, "number");

      // Stmt 3: Pure SELECT after prior mutations
      assert.equal(batch1[3].results.length, 2);
      assert.equal(batch1[3].meta?.changes, 0, "Pure SELECT after mutations must report changes=0");
      assert.equal(batch1[3].meta?.last_row_id, undefined);

      // Stmt 4: DELETE RETURNING
      assert.equal(batch1[4].results.length, 1);
      assert.deepEqual({ ...batch1[4].results[0] }, { id: 2, name: "bob", balance: 200 });
      assert.equal(batch1[4].meta?.changes, 1);
      assert.equal(typeof batch1[4].meta?.last_row_id, "number");

      // Stmt 5: Pure SELECT after DELETE
      assert.equal(batch1[5].results.length, 1);
      assert.deepEqual({ ...batch1[5].results[0] }, { active_count: 1 });
      assert.equal(batch1[5].meta?.changes, 0, "Pure SELECT after DELETE must report changes=0");

      // 2. Rollback after a RETURNING mutation fails later in batch
      await assert.rejects(async () => {
        await storage.batch([
          // Stmt 0: valid INSERT RETURNING
          storage.prepare("INSERT INTO bank_accounts (name, balance) VALUES (?, ?) RETURNING id, name").bind("charlie", 300),
          // Stmt 1: duplicate name causes UNIQUE constraint error
          storage.prepare("INSERT INTO bank_accounts (name, balance) VALUES (?, ?)").bind("alice", 400),
        ]);
      }, /UNIQUE constraint/);

      // Ensure charlie was rolled back and alice balance remained 150
      const afterRollback = await storage.prepare("SELECT * FROM bank_accounts WHERE name = ?").bind("charlie").all();
      assert.equal(afterRollback.results.length, 0, "INSERT RETURNING statement must be rolled back on later batch failure");

      const aliceCheck = await storage.prepare("SELECT balance FROM bank_accounts WHERE name = ?").bind("alice").first<{ balance: number }>();
      assert.equal(aliceCheck?.balance, 150);
    });

    test("D1 parity: comment/CTE INSERT RETURNING, explicit IDs 0 and -1, audit triggers, pure SELECT, and rollback", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec(`
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          balance INTEGER NOT NULL
        );
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER,
          action TEXT NOT NULL
        );
        CREATE TRIGGER trg_accounts_ins AFTER INSERT ON accounts
        BEGIN
          INSERT INTO audit_log (account_id, action) VALUES (NEW.id, 'insert');
        END;
        CREATE TRIGGER trg_accounts_upd AFTER UPDATE ON accounts
        BEGIN
          INSERT INTO audit_log (account_id, action) VALUES (NEW.id, 'update');
        END;
        CREATE TRIGGER trg_accounts_del AFTER DELETE ON accounts
        BEGIN
          INSERT INTO audit_log (account_id, action) VALUES (OLD.id, 'delete');
        END;
      `);

      // 1. Comment/CTE-led INSERT RETURNING with explicit ID 0 and trigger
      const res0 = await storage.prepare(
        "/* comment */ WITH ins AS (SELECT 0 AS id, 'zero' AS name, 100 AS balance) INSERT INTO accounts SELECT * FROM ins RETURNING *"
      ).all<{ id: number; name: string; balance: number }>();

      assert.equal(res0.results.length, 1);
      assert.deepEqual({ ...res0.results[0] }, { id: 0, name: "zero", balance: 100 });
      // Total changes = 1 (accounts) + 1 (trigger audit_log) = 2
      assert.equal(res0.meta?.changes, 2, "meta.changes must include trigger writes via total_changes delta");
      assert.equal(res0.meta?.last_row_id, 0, "explicit ID 0 must be reported in last_row_id");

      // 2. Explicit ID -1 with trigger
      const resNeg1 = await storage.prepare(
        "INSERT INTO accounts (id, name, balance) VALUES (-1, 'neg_one', 200) RETURNING *"
      ).all<{ id: number; name: string; balance: number }>();

      assert.equal(resNeg1.results.length, 1);
      assert.deepEqual({ ...resNeg1.results[0] }, { id: -1, name: "neg_one", balance: 200 });
      assert.equal(resNeg1.meta?.changes, 2, "meta.changes must include trigger writes via total_changes delta");
      assert.equal(resNeg1.meta?.last_row_id, -1, "explicit negative ID -1 must be reported in last_row_id");

      // 3. UPDATE RETURNING with trigger
      const resUpd = await storage.prepare(
        "UPDATE accounts SET balance = balance + 50 WHERE id = 0 RETURNING *"
      ).all<{ id: number; name: string; balance: number }>();

      assert.equal(resUpd.results.length, 1);
      assert.deepEqual({ ...resUpd.results[0] }, { id: 0, name: "zero", balance: 150 });
      assert.equal(resUpd.meta?.changes, 2, "meta.changes must include update + trigger write");
      assert.equal(typeof resUpd.meta?.last_row_id, "number");

      // 4. Pure SELECT after mutations: must remain changes: 0 and NO last_row_id
      const resSel = await storage.prepare("SELECT * FROM accounts WHERE id = 0").all<{ id: number }>();
      assert.equal(resSel.results.length, 1);
      assert.equal(resSel.meta?.changes, 0, "Pure SELECT after mutations must report changes=0");
      assert.equal(resSel.meta?.last_row_id, undefined, "Pure SELECT must not report stale last_row_id");

      // 5. DELETE RETURNING with trigger
      const resDel = await storage.prepare(
        "DELETE FROM accounts WHERE id = -1 RETURNING *"
      ).all<{ id: number }>();
      assert.equal(resDel.results.length, 1);
      assert.equal(resDel.meta?.changes, 2, "meta.changes must include delete + trigger write");
      assert.equal(typeof resDel.meta?.last_row_id, "number");

      // Verify audit log rows in DB match total trigger writes
      const auditRows = await storage.prepare("SELECT * FROM audit_log ORDER BY id ASC").all();
      assert.equal(auditRows.results.length, 4, "4 trigger writes must have occurred across 4 mutations");

      // 6. Rollback after trigger-backed RETURNING failure in batch
      await assert.rejects(async () => {
        await storage.batch([
          storage.prepare("INSERT INTO accounts (id, name, balance) VALUES (42, 'forty_two', 500) RETURNING *"),
          storage.prepare("INSERT INTO accounts (id, name, balance) VALUES (99, 'zero', 900)"), // duplicate name causes UNIQUE error
        ]);
      }, /UNIQUE constraint/);

      // Verify forty_two and its trigger audit log were rolled back
      const rolledBackAccount = await storage.prepare("SELECT * FROM accounts WHERE id = 42").all();
      assert.equal(rolledBackAccount.results.length, 0, "Account 42 must be rolled back");
      const rolledBackAudit = await storage.prepare("SELECT * FROM audit_log WHERE account_id = 42").all();
      assert.equal(rolledBackAudit.results.length, 0, "Audit row for account 42 must be rolled back");
    });

    test("D1 parity: non-RETURNING mutations with audit triggers via .run() and batch(), zero-change/SELECT has changes=0 and no stale last_row_id", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          points INTEGER NOT NULL
        );
        CREATE TABLE user_audits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL
        );
        CREATE TRIGGER trg_users_ins AFTER INSERT ON users
        BEGIN
          INSERT INTO user_audits (user_id, action) VALUES (NEW.id, 'ins');
        END;
        CREATE TRIGGER trg_users_upd AFTER UPDATE ON users
        BEGIN
          INSERT INTO user_audits (user_id, action) VALUES (NEW.id, 'upd');
        END;
        CREATE TRIGGER trg_users_del AFTER DELETE ON users
        BEGIN
          INSERT INTO user_audits (user_id, action) VALUES (OLD.id, 'del');
        END;
      `);

      // 1. Direct .run() ordinary INSERT (non-RETURNING)
      // Total changes = 1 (users) + 1 (trigger user_audits) = 2
      const insRes = await storage
        .prepare("INSERT INTO users (id, username, points) VALUES (?, ?, ?)")
        .bind(10, "u10", 100)
        .run();
      assert.equal(insRes.meta.changes, 2, ".run() changes must include trigger writes");
      assert.equal(insRes.meta.last_row_id, 10, ".run() last_row_id must reflect inserted row ID");

      // 2. Direct .run() ordinary UPDATE (non-RETURNING)
      const updRes = await storage
        .prepare("UPDATE users SET points = points + 25 WHERE id = ?")
        .bind(10)
        .run();
      assert.equal(updRes.meta.changes, 2, ".run() update changes must include trigger write");

      // 3. Direct .run() zero-change path (no rows matched)
      const zeroUpdRes = await storage
        .prepare("UPDATE users SET points = 999 WHERE id = ?")
        .bind(9999)
        .run();
      assert.equal(zeroUpdRes.meta.changes, 0, "Zero-match .run() must report changes=0");
      assert.equal(zeroUpdRes.meta.last_row_id, undefined, "Zero-match .run() must not expose stale last_row_id");

      // 4. Direct .run() on SELECT (query misuse path)
      const selRunRes = await storage
        .prepare("SELECT * FROM users WHERE id = ?")
        .bind(10)
        .run();
      assert.equal(selRunRes.meta.changes, 0, "SELECT .run() must report changes=0");
      assert.equal(selRunRes.meta.last_row_id, undefined, "SELECT .run() must not expose stale last_row_id");

      // 5. Direct .run() ordinary DELETE (non-RETURNING)
      const delRes = await storage
        .prepare("DELETE FROM users WHERE id = ?")
        .bind(10)
        .run();
      assert.equal(delRes.meta.changes, 2, ".run() delete changes must include trigger write");

      // 6. Non-RETURNING mutations with triggers in batch()
      const batchRes = await storage.batch([
        // 0: non-RETURNING INSERT with trigger (changes: 2, last_row_id: 20)
        storage.prepare("INSERT INTO users (id, username, points) VALUES (?, ?, ?)").bind(20, "u20", 200),
        // 1: non-RETURNING UPDATE with trigger (changes: 2)
        storage.prepare("UPDATE users SET points = points + 50 WHERE id = ?").bind(20),
        // 2: non-RETURNING zero-match UPDATE (changes: 0, no stale last_row_id)
        storage.prepare("UPDATE users SET points = 0 WHERE id = ?").bind(9999),
        // 3: non-RETURNING DELETE with trigger (changes: 2)
        storage.prepare("DELETE FROM users WHERE id = ?").bind(20),
      ]);

      assert.equal(batchRes.length, 4);

      // Stmt 0: batch INSERT
      assert.equal(batchRes[0].results.length, 0);
      assert.equal(batchRes[0].meta?.changes, 2, "batch INSERT changes must include trigger writes");
      assert.equal(batchRes[0].meta?.last_row_id, 20);

      // Stmt 1: batch UPDATE
      assert.equal(batchRes[1].results.length, 0);
      assert.equal(batchRes[1].meta?.changes, 2, "batch UPDATE changes must include trigger writes");

      // Stmt 2: batch zero-match UPDATE
      assert.equal(batchRes[2].results.length, 0);
      assert.equal(batchRes[2].meta?.changes, 0, "batch zero-match must have changes=0");
      assert.equal(batchRes[2].meta?.last_row_id, undefined, "batch zero-match must not have stale last_row_id");

      // Stmt 3: batch DELETE
      assert.equal(batchRes[3].results.length, 0);
      assert.equal(batchRes[3].meta?.changes, 2, "batch DELETE changes must include trigger writes");

      // Total audit rows verified in DB (3 from direct .run() + 3 from batch() = 6)
      const totalAudits = await storage.prepare("SELECT COUNT(*) AS total FROM user_audits").first<{ total: number }>();
      assert.equal(totalAudits?.total, 6);
    });

    test("persistence across reopen with local file", async () => {
      const dbPath = join(tmpdir(), `pod_storage_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);
      tempFiles.push(dbPath);

      // Open initial storage instance and populate schema & data
      const storage1 = new SqliteFileStorage(dbPath);
      storage1.exec(`
        CREATE TABLE config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      await storage1
        .prepare("INSERT INTO config (key, value) VALUES (?, ?)")
        .bind("cluster_name", "alpha-pod-fleet")
        .run();

      await storage1
        .prepare("INSERT INTO config (key, value) VALUES (?, ?)")
        .bind("epoch", "2026-11-05")
        .run();

      storage1.close();

      // Reopen with fresh storage instance on the same file
      const storage2 = new SqliteFileStorage(dbPath);

      const cluster = await storage2
        .prepare("SELECT value FROM config WHERE key = ?")
        .bind("cluster_name")
        .first<{ value: string }>();

      assert.ok(cluster);
      assert.equal(cluster.value, "alpha-pod-fleet");

      const rows = await storage2
        .prepare("SELECT * FROM config ORDER BY key ASC")
        .all<{ key: string; value: string }>();

      assert.equal(rows.results.length, 2);
      assert.equal(rows.results[0].key, "cluster_name");
      assert.equal(rows.results[1].key, "epoch");
      assert.equal(rows.results[1].value, "2026-11-05");

      storage2.close();
    });
    test("ArrayBuffer and ArrayBufferView binding stores real SQLite BLOB bytes", async () => {
      const storage = new SqliteFileStorage(":memory:");
      storage.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);");

      const rawBytes1 = [0xca, 0xfe, 0xba, 0xbe];
      const arrayBuffer = new Uint8Array(rawBytes1).buffer;
      await storage.prepare("INSERT INTO blobs (id, payload) VALUES (?, ?)")
        .bind(1, arrayBuffer)
        .run();

      const rawBytes2 = [0xde, 0xad, 0xbe, 0xef];
      const uint8View = new Uint8Array(rawBytes2);
      await storage.prepare("INSERT INTO blobs (id, payload) VALUES (?, ?)")
        .bind(2, uint8View)
        .run();

      // Query back row 1 (inserted as ArrayBuffer)
      const r1 = await storage.prepare("SELECT payload FROM blobs WHERE id = ?").bind(1).first<{ payload: Uint8Array }>();
      assert.ok(r1);
      assert.ok(r1.payload instanceof Uint8Array, "ArrayBuffer must be stored and retrieved as Uint8Array BLOB");
      assert.deepEqual(Array.from(r1.payload), rawBytes1);
      assert.notEqual(String(r1.payload), "[object ArrayBuffer]");

      // Query back row 2 (inserted as Uint8Array)
      const r2 = await storage.prepare("SELECT payload FROM blobs WHERE id = ?").bind(2).first<{ payload: Uint8Array }>();
      assert.ok(r2);
      assert.ok(r2.payload instanceof Uint8Array, "ArrayBufferView must be stored and retrieved as Uint8Array BLOB");
      assert.deepEqual(Array.from(r2.payload), rawBytes2);

      // Query all
      const allRows = await storage.prepare("SELECT id, payload FROM blobs ORDER BY id ASC").all<{ id: number; payload: Uint8Array }>();
      assert.equal(allRows.results.length, 2);
      assert.deepEqual(Array.from(allRows.results[0].payload), rawBytes1);
      assert.deepEqual(Array.from(allRows.results[1].payload), rawBytes2);
    });
  });

  describe("D1Storage", () => {
    test("delegates prepare, bind, run, all, first, batch to underlying D1", async () => {
      const mockStatements: D1PreparedStatementLike[] = [];
      const mockD1: D1DatabaseLike = {
        prepare(sql: string): D1PreparedStatementLike {
          const makeStmt = (args: unknown[] = []): D1PreparedStatementLike => ({
            bind(...newArgs: unknown[]) {
              return makeStmt(newArgs);
            },
            async all<T>() {
              return { results: [{ id: args[0], val: "mocked" }] as T[], meta: { changes: 0 } };
            },
            async first<T>(col?: string) {
              const row: Record<string, unknown> = { id: args[0], val: "mocked" };
              return (col ? row[col] : row) as T;
            },
            async run<T>() {
              return { success: true, meta: { changes: 1, last_row_id: 123 } } as D1ResultLike<T>;
            },
          });
          return makeStmt();
        },
        async batch<T>(stmts: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
          mockStatements.push(...stmts);
          return stmts.map((_, idx) => ({
            results: [{ index: idx }] as T[],
            meta: { changes: 1 },
            success: true,
          }));
        },
      };

      const storage = new D1Storage(mockD1);

      // 1. prepare + bind + run
      const runRes = await storage.prepare("INSERT INTO test VALUES (?)").bind("foo").run();
      assert.equal(runRes.meta.changes, 1);
      assert.equal(runRes.meta.last_row_id, 123);

      // 2. prepare + bind + first
      const firstRes = await storage.prepare("SELECT * FROM test WHERE id = ?").bind("bar").first<{ id: string; val: string }>();
      assert.deepEqual(firstRes, { id: "bar", val: "mocked" });

      // 3. prepare + bind + first(colName)
      const colVal = await storage.prepare("SELECT * FROM test WHERE id = ?").bind("baz").first<string>("val");
      assert.equal(colVal, "mocked");

      // 4. prepare + bind + all
      const allRes = await storage.prepare("SELECT * FROM test WHERE id = ?").bind("qux").all<{ id: string; val: string }>();
      assert.deepEqual(allRes.results, [{ id: "qux", val: "mocked" }]);

      // 5. batch
      const s1 = storage.prepare("INSERT INTO test VALUES (?)").bind("b1");
      const s2 = storage.prepare("INSERT INTO test VALUES (?)").bind("b2");
      const batchRes = await storage.batch([s1, s2]);
      assert.equal(batchRes.length, 2);
      assert.deepEqual(batchRes[0].results, [{ index: 0 }]);
      assert.deepEqual(batchRes[1].results, [{ index: 1 }]);
    });

    test("bubbles errors from underlying D1 without hiding them", async () => {
      const mockD1: D1DatabaseLike = {
        prepare(): D1PreparedStatementLike {
          const stmt: D1PreparedStatementLike = {
            bind() {
              return stmt;
            },
            async run() {
              throw new Error("D1 connection lost");
            },
            async all() {
              throw new Error("D1 query timeout");
            },
            async first() {
              throw new Error("D1 internal error");
            },
          };
          return stmt;
        },
        async batch() {
          throw new Error("D1 batch failed");
        },
      };

      const storage = new D1Storage(mockD1);

      await assert.rejects(async () => {
        await storage.prepare("SELECT 1").run();
      }, /D1 connection lost/);

      await assert.rejects(async () => {
        await storage.prepare("SELECT 1").all();
      }, /D1 query timeout/);

      await assert.rejects(async () => {
        await storage.prepare("SELECT 1").first();
      }, /D1 internal error/);

      await assert.rejects(async () => {
        await storage.batch([storage.prepare("SELECT 1")]);
      }, /D1 batch failed/);
    });
    test("delegates native D1Result without avoidable copying when shape conforms", async () => {
      const nativeQueryResult = {
        results: [{ id: "res-1" }],
        meta: { changes: 0, duration: 1.2 },
        success: true,
      };
      const nativeBatchResults = [
        { results: [{ id: "b-1" }], meta: { changes: 1 }, success: true },
        { results: [{ id: "b-2" }], meta: { changes: 1 }, success: true },
      ];

      const mockD1: D1DatabaseLike = {
        prepare(): D1PreparedStatementLike {
          const stmt: D1PreparedStatementLike = {
            bind() { return stmt; },
            async all() { return nativeQueryResult as any; },
            async first() { return nativeQueryResult.results[0]; },
            async run() { return { success: true, meta: { changes: 5, last_row_id: 99 } }; },
          };
          return stmt;
        },
        async batch() {
          return nativeBatchResults as any;
        },
      };

      const storage = new D1Storage(mockD1);
      const resAll = await storage.prepare("SELECT 1").all();
      // Exact reference preserved (zero copy)
      assert.equal(resAll, nativeQueryResult);

      const resBatch = await storage.batch([storage.prepare("SELECT 1"), storage.prepare("SELECT 2")]);
      // Exact batch array reference preserved (zero copy)
      assert.equal(resBatch, nativeBatchResults);

      const runRes = await storage.prepare("INSERT INTO test VALUES (1)").run();
      assert.equal(runRes.meta.changes, 5);
      assert.equal(runRes.meta.last_row_id, 99);
    });
  });

  describe("toPodStorage composition contract", () => {
    test("returns existing D1Storage or SqliteFileStorage unchanged", () => {
      const mockD1: D1DatabaseLike = {
        prepare: () => ({} as any),
        batch: () => Promise.resolve([]),
      };
      const d1Storage = new D1Storage(mockD1);
      assert.equal(isPodStorage(d1Storage), true);
      assert.equal(toPodStorage(d1Storage), d1Storage);

      const sqliteStorage = new SqliteFileStorage(":memory:");
      assert.equal(isPodStorage(sqliteStorage), true);
      assert.equal(toPodStorage(sqliteStorage), sqliteStorage);
    });

    test("accepts minimal branded PodStorage without wrapping as D1", () => {
      let preparedQuery = "";
      const minimalBranded: PodStorage = {
        [POD_STORAGE_BRAND]: true,
        prepare(query: string) {
          preparedQuery = query;
          return {
            bind() { return this; },
            all: async () => ({ results: [] }),
            first: async () => null,
            run: async () => ({ meta: { changes: 0 } }),
          };
        },
        batch: async () => [],
      };

      assert.equal(isPodStorage(minimalBranded), true);
      const result = toPodStorage(minimalBranded);
      // Crucial: not wrapped in D1Storage!
      assert.equal(result, minimalBranded);
      assert.equal(result instanceof D1Storage, false);
      result.prepare("SELECT * FROM custom_minimal");
      assert.equal(preparedQuery, "SELECT * FROM custom_minimal");
    });

    test("unbranded object is not a valid PodStorage (compile-time and runtime proof)", () => {
      // Compile-time type assertion: unbranded object cannot satisfy PodStorage
      type AssertAssignable<T extends PodStorage> = true;
      // @ts-expect-error Property '[POD_STORAGE_BRAND]' is missing in unbranded object
      type _UnbrandedFailsTypeCheck = AssertAssignable<{
        prepare(q: string): any;
        batch(s: any[]): any;
      }>;

      const unbrandedStorage = {
        prepare: () => ({
          bind: () => ({} as any),
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } }),
        }),
        batch: async () => [],
      };

      assert.equal(isPodStorage(unbrandedStorage), false);
      const result = toPodStorage(unbrandedStorage as any);
      assert.ok(result instanceof D1Storage, "Unbranded storage must be treated as D1-compatible and wrapped in D1Storage");
      assert.equal(isPodStorage(result), true);
    });

    test("wraps unbranded D1DatabaseLike in D1Storage", () => {
      const rawD1: D1DatabaseLike = {
        prepare: () => ({} as any),
        batch: () => Promise.resolve([]),
      };

      assert.equal(isPodStorage(rawD1), false);
      const wrapped = toPodStorage(rawD1);
      assert.ok(wrapped instanceof D1Storage);
      assert.equal(isPodStorage(wrapped), true);
    });
  });
});
