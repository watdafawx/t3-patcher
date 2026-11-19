"use strict";
// t3p sqlite.read query process. Runs ONE read-only query and exits.
//
// It runs in its own process (Electron utilityProcess, or child_process.fork
// in tests) and not in a worker thread: a query that spins inside SQLite's C
// code (an aggregate over a huge recursive CTE) never returns to JS, so
// worker.terminate() cannot stop it. Killing a process always works.
//
// Copied to <home>/.t3-patcher/runtime/sqlite-worker.cjs by the build.
const port = process.parentPort;

function reply(message) {
  if (port) port.postMessage(message);
  else if (process.send) process.send(message);
}

const MAX_CELL_BYTES = 256 * 1024; // per text cell; longer values are cut and flagged
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // aggregate payload sent to main; the router caps again at 32 MiB

function run(job) {
  const started = Date.now();
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(job.path, { readOnly: true, timeout: 1000, allowExtension: false });
    db.exec("PRAGMA query_only=1");
    const stmt = db.prepare(job.sql);
    stmt.setReadBigInts(false);
    const columns = stmt.columns().map((c) => c.name);
    if (typeof stmt.setReturnArrays === "function") stmt.setReturnArrays(true);
    const rows = [];
    let truncated = false;
    let total = 0;
    for (const row of stmt.iterate(...job.params)) {
      if (rows.length >= job.maxRows) {
        truncated = true;
        break;
      }
      const values = Array.isArray(row) ? row : columns.map((c) => row[c]);
      const out = values.map((v) => {
        if (v instanceof Uint8Array) {
          const b64 = Buffer.from(v.subarray(0, 65536)).toString("base64");
          total += b64.length;
          return { $bytes: b64, length: v.length };
        }
        if (typeof v === "bigint") {
          total += 20;
          return String(v);
        }
        if (typeof v === "string") {
          if (v.length > MAX_CELL_BYTES) {
            total += MAX_CELL_BYTES;
            return { $text: v.slice(0, MAX_CELL_BYTES), length: v.length, truncated: true };
          }
          total += v.length;
          return v;
        }
        total += 16;
        return v;
      });
      if (total > MAX_TOTAL_BYTES) {
        truncated = true;
        break;
      }
      rows.push(out);
    }
    reply({ ok: true, columns, rows, truncated, ms: Date.now() - started });
  } catch (e) {
    reply({ ok: false, error: String((e && e.message) || e) });
  } finally {
    try {
      if (db) db.close();
    } catch {
      // closing a read-only handle cannot lose data
    }
  }
}

function onJob(job) {
  run(job);
  // Let the reply flush, then exit; the parent kills us anyway after a reply.
  setTimeout(() => process.exit(0), 50);
}

if (port) port.once("message", (event) => onJob(event.data));
else process.once("message", onJob);
