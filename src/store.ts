import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ApiError, ERR } from "./errors.ts";
import type { RunResult, Scene, Settings, Vec2 } from "./types.ts";

/**
 * SQLite 持久层。
 * - 场景不可变：每次保存生成新版本 id，旧路径永远引用旧坐标。
 * - 一次运行在事务中原子写入（run + events + explanations）。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS rays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene_id INTEGER NOT NULL REFERENCES scenes(id),
        origin_x REAL NOT NULL, origin_y REAL NOT NULL,
        dir_x REAL NOT NULL, dir_y REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ray_id INTEGER NOT NULL REFERENCES rays(id),
        settings_json TEXT NOT NULL,
        status TEXT NOT NULL,
        total_distance REAL NOT NULL,
        ambiguity TEXT,
        exit_json TEXT,
        explanations_truncated INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS explanations (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        explanation_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  saveScene(scene: Scene): number {
    const r = this.db
      .prepare("INSERT INTO scenes (scene_json) VALUES (?)")
      .run(JSON.stringify(scene));
    return Number(r.lastInsertRowid);
  }

  getScene(id: number): Scene {
    const row = this.db.prepare("SELECT scene_json FROM scenes WHERE id = ?").get(id) as
      | { scene_json: string }
      | undefined;
    if (!row) throw new ApiError(ERR.NOT_FOUND, `场景 ${id} 不存在`, 404);
    return JSON.parse(row.scene_json) as Scene;
  }

  saveRay(sceneId: number, origin: Vec2, dir: Vec2): number {
    this.getScene(sceneId); // 确保场景存在
    const r = this.db
      .prepare("INSERT INTO rays (scene_id, origin_x, origin_y, dir_x, dir_y) VALUES (?,?,?,?,?)")
      .run(sceneId, origin.x, origin.y, dir.x, dir.y);
    return Number(r.lastInsertRowid);
  }

  getRay(id: number): { sceneId: number; origin: Vec2; dir: Vec2 } {
    const row = this.db
      .prepare("SELECT scene_id, origin_x, origin_y, dir_x, dir_y FROM rays WHERE id = ?")
      .get(id) as
      | { scene_id: number; origin_x: number; origin_y: number; dir_x: number; dir_y: number }
      | undefined;
    if (!row) throw new ApiError(ERR.NOT_FOUND, `射线 ${id} 不存在`, 404);
    return {
      sceneId: row.scene_id,
      origin: { x: row.origin_x, y: row.origin_y },
      dir: { x: row.dir_x, y: row.dir_y },
    };
  }

  /** 原子保存一次运行 */
  saveRun(rayId: number, settings: Settings, result: RunResult): number {
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare(
          `INSERT INTO runs (ray_id, settings_json, status, total_distance, ambiguity, exit_json, explanations_truncated)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          rayId,
          JSON.stringify(settings),
          result.status,
          result.totalDistance,
          result.ambiguity ?? null,
          result.exit ? JSON.stringify(result.exit) : null,
          result.explanationsTruncated ? 1 : 0,
        );
      const runId = Number(r.lastInsertRowid);
      const evStmt = this.db.prepare("INSERT INTO events (run_id, seq, event_json) VALUES (?,?,?)");
      for (const e of result.events) evStmt.run(runId, e.seq, JSON.stringify(e));
      const exStmt = this.db.prepare("INSERT INTO explanations (run_id, seq, explanation_json) VALUES (?,?,?)");
      for (const x of result.explanations) exStmt.run(runId, x.seq, JSON.stringify(x));
      this.db.exec("COMMIT");
      return runId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getRun(id: number): {
    rayId: number;
    settings: Settings;
    status: string;
    totalDistance: number;
    ambiguity: string | null;
    exit: unknown;
    explanationsTruncated: boolean;
  } {
    const row = this.db
      .prepare(
        `SELECT ray_id, settings_json, status, total_distance, ambiguity, exit_json, explanations_truncated
         FROM runs WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(ERR.NOT_FOUND, `运行 ${id} 不存在`, 404);
    return {
      rayId: row.ray_id as number,
      settings: JSON.parse(row.settings_json as string) as Settings,
      status: row.status as string,
      totalDistance: row.total_distance as number,
      ambiguity: (row.ambiguity as string) ?? null,
      exit: row.exit_json ? JSON.parse(row.exit_json as string) : null,
      explanationsTruncated: (row.explanations_truncated as number) === 1,
    };
  }

  getEvents(runId: number): unknown[] {
    this.getRun(runId);
    const rows = this.db
      .prepare("SELECT event_json FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ event_json: string }>;
    return rows.map((r) => JSON.parse(r.event_json));
  }

  getExplanation(runId: number, seq: number): unknown {
    this.getRun(runId);
    const row = this.db
      .prepare("SELECT explanation_json FROM explanations WHERE run_id = ? AND seq = ?")
      .get(runId, seq) as { explanation_json: string } | undefined;
    if (!row) throw new ApiError(ERR.NOT_FOUND, `运行 ${runId} 第 ${seq} 步无解释记录`, 404);
    return JSON.parse(row.explanation_json);
  }
}
