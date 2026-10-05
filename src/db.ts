import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { notFoundError } from "./errors.js";
import type {
  Mirror,
  NumericSettings,
  ReflectionEvent,
  RunResult,
  Scene,
  Vec2,
} from "./types.js";

export interface SceneRow {
  id: number;
  version: number;
  parent_id: number | null;
  name: string;
  bounds: string;
  mirrors: string;
  created_at: string;
}

export interface RunRow {
  id: number;
  scene_id: number;
  origin: string;
  direction: string;
  reflection_budget: number;
  settings: string;
  status: string;
  ambiguity: string | null;
  created_at: string;
}

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL,
      parent_id INTEGER REFERENCES scenes(id),
      name TEXT NOT NULL,
      bounds TEXT NOT NULL,
      mirrors TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL REFERENCES scenes(id),
      origin TEXT NOT NULL,
      direction TEXT NOT NULL,
      reflection_budget INTEGER NOT NULL,
      settings TEXT NOT NULL,
      status TEXT NOT NULL,
      ambiguity TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS path_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      event_index INTEGER NOT NULL,
      mirror_id INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      event_index INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      mirror_id INTEGER NOT NULL,
      t REAL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_scene ON runs(scene_id);
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, event_index);
    CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id, event_index, seq);
    CREATE INDEX IF NOT EXISTS idx_path_run ON path_points(run_id, seq);
  `);
}

export interface SaveSceneInput {
  name: string;
  bounds: Scene["bounds"];
  mirrors: Mirror[];
  parentId?: number | null;
}

export function insertScene(db: DatabaseSync, input: SaveSceneInput): Scene {
  const version =
    input.parentId == null
      ? 1
      : (() => {
          const parent = db.prepare("SELECT version FROM scenes WHERE id = ?").get(input.parentId) as
            | { version: number }
            | undefined;
          if (!parent) throw notFoundError(`父场景版本 ${input.parentId} 不存在`);
          return parent.version + 1;
        })();
  const info = db
    .prepare(
      `INSERT INTO scenes (version, parent_id, name, bounds, mirrors)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      version,
      input.parentId ?? null,
      input.name,
      JSON.stringify(input.bounds),
      JSON.stringify(input.mirrors),
    );
  return getScene(db, Number(info.lastInsertRowid));
}

export function getScene(db: DatabaseSync, id: number): Scene {
  const row = db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as SceneRow | undefined;
  if (!row) throw notFoundError(`场景版本 ${id} 不存在`);
  return rowToScene(row);
}

export function listScenes(db: DatabaseSync): Array<{ id: number; version: number; name: string; parentId: number | null }> {
  const rows = db
    .prepare("SELECT id, version, parent_id, name FROM scenes ORDER BY id")
    .all() as Array<Pick<SceneRow, "id" | "version" | "name"> & { parent_id: number | null }>;
  return rows.map((r) => ({ id: r.id, version: r.version, name: r.name, parentId: r.parent_id }));
}

function rowToScene(row: SceneRow): Scene {
  return {
    id: row.id,
    version: row.version,
    parentVersionId: row.parent_id,
    name: row.name,
    bounds: JSON.parse(row.bounds) as Scene["bounds"],
    mirrors: JSON.parse(row.mirrors) as Mirror[],
    createdAt: row.created_at,
  };
}

export interface SaveRunInput {
  sceneId: number;
  origin: Vec2;
  direction: Vec2;
  reflectionBudget: number;
  settings: NumericSettings;
  result: RunResult;
}

/** 一次运行在单个事务内原子保存；重启后可完整查询方向与路程。 */
export function saveRun(db: DatabaseSync, input: SaveRunInput): number {
  const { result } = input;
  db.exec("BEGIN IMMEDIATE");
  try {
    const runId = saveWithinTransaction();
    db.exec("COMMIT");
    return runId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function saveWithinTransaction(): never {
  throw new Error("placeholder");
}

function saveRunImpl(db: DatabaseSync, input: SaveRunInput): number {
  const { result } = input;
  const save = (): number => {
    const runInfo = db
      .prepare(
        `INSERT INTO runs (scene_id, origin, direction, reflection_budget, settings, status, ambiguity)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sceneId,
        JSON.stringify(input.origin),
        JSON.stringify(input.direction),
        input.reflectionBudget,
        JSON.stringify(input.settings),
        result.status,
        result.ambiguity ? JSON.stringify(result.ambiguity) : null,
      );
    const runId = Number(runInfo.lastInsertRowid);

    const pts: Array<{ seq: number; kind: string; p: Vec2 }> = [];
    pts.push({ seq: 0, kind: "origin", p: input.origin });
    result.reflections.forEach((e) => pts.push({ seq: e.index, kind: "reflection", p: e.point }));
    if (result.exit) pts.push({ seq: pts.length, kind: "exit", p: result.exit.point });
    else if (result.status === "budget_reached" && result.budgetPoint) {
      pts.push({ seq: pts.length, kind: "budget", p: result.budgetPoint });
    }
    const insertPoint = db.prepare(
      "INSERT INTO path_points (run_id, seq, kind, x, y) VALUES (?, ?, ?, ?, ?)",
    );
    pts.forEach((p) => insertPoint.run(runId, p.seq, p.kind, p.p.x, p.p.y));

    const insertEvent = db.prepare(
      `INSERT INTO events (run_id, event_index, mirror_id, payload) VALUES (?, ?, ?, ?)`,
    );
    const insertCandidate = db.prepare(
      `INSERT INTO candidates (run_id, event_index, seq, mirror_id, t, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    result.reflections.forEach((event: ReflectionEvent) => {
      insertEvent.run(runId, event.index, event.mirrorId, JSON.stringify(event));
      event.candidates.forEach((c, seq) => {
        insertCandidate.run(runId, event.index, seq, c.mirrorId, c.t, c.status, c.reason);
      });
    });
    return runId;
  };
  return save();
}

export function getRunHeader(db: DatabaseSync, runId: number): RunRow {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!row) throw notFoundError(`运行记录 ${runId} 不存在`);
  return row;
}

export function listRuns(db: DatabaseSync, sceneId?: number): Array<{ id: number; sceneId: number; status: string; createdAt: string }> {
  const rows =
    sceneId === undefined
      ? (db.prepare("SELECT id, scene_id, status, created_at FROM runs ORDER BY id").all() as Array<{
          id: number;
          scene_id: number;
          status: string;
          created_at: string;
        }>)
      : (db
          .prepare("SELECT id, scene_id, status, created_at FROM runs WHERE scene_id = ? ORDER BY id")
          .all(sceneId) as Array<{ id: number; scene_id: number; status: string; created_at: string }>);
  return rows.map((r) => ({ id: r.id, sceneId: r.scene_id, status: r.status, createdAt: r.created_at }));
}

export function getEvents(db: DatabaseSync, runId: number): ReflectionEvent[] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE run_id = ? ORDER BY event_index")
    .all(runId) as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as ReflectionEvent);
}

export interface CandidateRow {
  eventIndex: number;
  seq: number;
  mirrorId: number;
  t: number | null;
  status: string;
  reason: string;
}

export function getCandidates(db: DatabaseSync, runId: number, eventIndex?: number): CandidateRow[] {
  const rows =
    eventIndex === undefined
      ? (db
          .prepare(
            "SELECT event_index, seq, mirror_id, t, status, reason FROM candidates WHERE run_id = ? ORDER BY event_index, seq",
          )
          .all(runId) as Array<Record<string, unknown>>)
      : (db
          .prepare(
            "SELECT event_index, seq, mirror_id, t, status, reason FROM candidates WHERE run_id = ? AND event_index = ? ORDER BY seq",
          )
          .all(runId, eventIndex) as Array<Record<string, unknown>>);
  return rows.map((r) => ({
    eventIndex: r.event_index as number,
    seq: r.seq as number,
    mirrorId: r.mirror_id as number,
    t: (r.t as number | null) ?? null,
    status: r.status as string,
    reason: r.reason as string,
  }));
}

export interface PathPointRow {
  seq: number;
  kind: string;
  x: number;
  y: number;
}

export function getPath(db: DatabaseSync, runId: number): PathPointRow[] {
  const rows = db
    .prepare("SELECT seq, kind, x, y FROM path_points WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ seq: number; kind: string; x: number; y: number }>;
  return rows.map((r) => ({ seq: r.seq, kind: r.kind, x: r.x, y: r.y }));
}
