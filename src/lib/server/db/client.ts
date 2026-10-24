import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { seed } from "./seed";

export type Db = BetterSQLite3Database<typeof schema>;

const globalForDb = globalThis as unknown as { __tradelabDb?: { db: Db; sqlite: Database.Database } };

/** Open (and migrate) a database. `:memory:` is used by tests. */
export function openDb(file: string): { db: Db; sqlite: Database.Database } {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  seed(db);
  return { db, sqlite };
}

let migratedThisModule = false;

export function getDb(): Db {
  if (!globalForDb.__tradelabDb) {
    globalForDb.__tradelabDb = openDb(process.env.DATABASE_PATH || "./data/tradelab.db");
    migratedThisModule = true;
  } else if (!migratedThisModule) {
    // The connection survives dev hot-reloads; apply any migrations added since (idempotent).
    migrate(globalForDb.__tradelabDb.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    seed(globalForDb.__tradelabDb.db);
    migratedThisModule = true;
  }
  return globalForDb.__tradelabDb.db;
}
