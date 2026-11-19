import type { PermissionSet } from "@t3p/api";

import { createFsRead, type FsReadRequest, type FsReadResult } from "./fs-read.js";
import { createLogTail, type LogTailRequest, type LogTailResult } from "./log-tail.js";
import { expandHome, type PathPlatform } from "./path-guard.js";
import { createSpawn, type SpawnRequest, type SpawnResult } from "./spawn.js";
import { createSpawnSession, type SpawnSession, type SpawnSessionRequest } from "./spawn-session.js";
import { createSqliteQuery, type QueryLauncher, type SqliteQueryRequest, type SqliteQueryResult } from "./sqlite.js";

/** What a plugin may call. A service is present only when its permission is in the effective set. */
export interface NativeServices {
  fsRead?: (request: FsReadRequest) => FsReadResult;
  sqliteQuery?: (request: SqliteQueryRequest) => Promise<SqliteQueryResult>;
  logTail?: (request: LogTailRequest) => LogTailResult;
  spawn?: (request: SpawnRequest) => Promise<SpawnResult>;
  /** Main-side only: one long-lived allowlisted process (`-File <granted .ps1>` only). */
  spawnSession?: (request: SpawnSessionRequest) => SpawnSession;
}

export interface NativeDeps {
  platform: PathPlatform;
  /** Expands `~` in scopes (T3P_HOME or the OS home). */
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Starts a sqlite query process. Without it sqlite.read is unavailable (fail closed). */
  sqliteLaunch?: QueryLauncher;
}

/** Builds the frozen service object for one plugin's EFFECTIVE (declared AND granted) permissions. */
export function createNativeServices(perms: PermissionSet, deps: NativeDeps): Readonly<NativeServices> {
  const policy = { platform: deps.platform, home: deps.home };
  const roots = (scope: { roots: string[] } | undefined): string[] => (scope?.roots ?? []).map((r) => expandHome(r, policy));
  const services: NativeServices = {};
  if (perms["fs.read"]?.roots.length) services.fsRead = createFsRead({ ...policy, roots: roots(perms["fs.read"]) });
  if (perms["sqlite.read"]?.roots.length && deps.sqliteLaunch) services.sqliteQuery = createSqliteQuery({ ...policy, roots: roots(perms["sqlite.read"]), launch: deps.sqliteLaunch });
  if (perms["log.tail"]?.roots.length) services.logTail = createLogTail({ ...policy, roots: roots(perms["log.tail"]) });
  if (perms.spawn?.allow.length) {
    const spawnOptions = { ...policy, allow: perms.spawn.allow.map((p) => expandHome(p, policy)), env: deps.env };
    services.spawn = createSpawn(spawnOptions);
    services.spawnSession = createSpawnSession(spawnOptions);
  }
  return Object.freeze(services);
}

export type { FsReadRequest, FsReadResult, LogTailRequest, LogTailResult, SpawnRequest, SpawnResult, SqliteQueryRequest, SqliteQueryResult };
