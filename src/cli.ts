import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
import {
  getCandidates,
  getEvents,
  getPath,
  getRunHeader,
  getScene,
  insertScene,
  listRuns,
  listScenes,
  openDatabase,
  saveRun,
} from "./db.js";
import {
  assertMirrorsInside,
  executeRun,
  validateBounds,
  validateMirrors,
  validateSettings,
} from "./sceneService.js";
import type { MirrorInput } from "./sceneService.js";
import type { LaunchInput, NumericSettings } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const dbPath = process.env.MIRROR_DB ?? join(projectRoot, "data", "mirrors.db");
const db = openDatabase(dbPath);

const args = process.argv.slice(2);
const command = args[0];

function fail(err: unknown): never {
  if (err instanceof AppError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
  } else {
    console.error("错误:", err);
  }
  process.exit(1);
}

function readJsonArg(flag: string): any {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) {
    throw new AppError("VALIDATION", `缺少参数 ${flag} <json>`);
  }
  try {
    return JSON.parse(process.argv[index + 1]!);
  } catch {
    throw new AppError("VALIDATION", `${flag} 不是合法 JSON`);
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number(n.toFixed(6)).toString();
}

function printReflections(runId: number): void {
  const header = getRunHeader(db, runId);
  const events = getEvents(db, runId);
  const path = getPath(db, runId);
  console.log(`运行 #${runId}  状态: ${header.status}`);
  console.log(
    "次数  镜面  入射点 (x, y)            法向 (nx, ny)        段距离      累计路程    入射角(°)",
  );
  console.log("-".repeat(98));
  if (events.length === 0) console.log("（无反射事件）");
  for (const e of events) {
    console.log(
      [
        String(e.index).padEnd(4),
        String(e.mirrorId).padEnd(4),
        `(${fmt(e.point.x)}, ${fmt(e.point.y)})`.padEnd(24),
        `(${fmt(e.normal.x)}, ${fmt(e.normal.y)})`.padEnd(20),
        fmt(e.segmentDistance).padEnd(11),
        fmt(e.cumulativeDistance).padEnd(11),
        fmt((e.angleOfIncidence * 180) / Math.PI),
      ].join(" "),
    );
  }
  console.log("-".repeat(98));
  console.log("路径点（按顺序）:");
  for (const p of path) {
    console.log(`  ${String(p.seq).padStart(2)}. [${p.kind}] (${fmt(p.x)}, ${fmt(p.y)})`);
  }
}

function cmdSceneCreate(): void {
  const body = readJsonArg("--mirrors") ;
  const mirrors: MirrorInput[] = Array.isArray(body) ? body : body.mirrors;
  const bounds = body.bounds ?? { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const settings = validateSettings(body.settings);
  const validBounds = validateBounds(bounds, settings);
  const validMirrors = validateMirrors(mirrors, settings);
  assertMirrorsInside({ bounds: validBounds, mirrors: validMirrors }, settings);
  const scene = insertScene(db, {
    name: body.name ?? "CLI 场景",
    bounds: validBounds,
    mirrors: validMirrors,
    parentId: body.parentId ?? null,
  });
  console.log(`已保存不可变场景版本 #${scene.id}（version ${scene.version}）`);
  console.log(JSON.stringify({ id: scene.id, version: scene.version, bounds: scene.bounds, mirrorCount: scene.mirrors.length }, null, 2));
}

function cmdRun(): void {
  const sceneId = Number(args[1]);
  if (!Number.isInteger(sceneId)) throw new AppError("VALIDATION", "用法: cli run <sceneId> --launch '<json>'");
  const scene = getScene(db, sceneId);
  const launch: LaunchInput = readJsonArg("--launch");
  const overrideSettings: Partial<NumericSettings> | undefined = process.argv.includes("--settings")
    ? readJsonArg("--settings")
    : undefined;
  const settings = validateSettings(overrideSettings);
  const result = executeRun(scene, launch, settings);
  const runId = saveRun(db, {
    sceneId,
    origin: result.origin,
    direction: result.direction,
    reflectionBudget:
      typeof launch.maxReflections === "number"
        ? Math.min(launch.maxReflections, settings.maxReflections)
        : settings.maxReflections,
    settings,
    result,
  });
  printReflections(runId);
  if (result.ambiguity) console.log(`几何歧义 [${result.ambiguity.kind}]: ${result.ambiguity.detail}`);
  if (result.exit) {
    console.log(
      `离开边界: 边 ${result.exit.side}，点 (${fmt(result.exit.point.x)}, ${fmt(result.exit.point.y)})，总路程 ${fmt(result.exit.cumulativeDistance)}`,
    );
  }
  if (result.status === "budget_reached") {
    console.log("预算用尽：射线仍在场景内，不代表已离开。可用 budgetPoint/budgetDirection 继续。");
  }
}

function cmdCandidates(): void {
  const runId = Number(args[1]);
  if (!Number.isInteger(runId)) throw new AppError("VALIDATION", "用法: cli candidates <runId> [eventIndex]");
  getRunHeader(db, runId);
  const eventIndex = args[2] !== undefined ? Number(args[2]) : undefined;
  const rows = getCandidates(db, runId, eventIndex);
  console.log("反射序号  镜面  t（射线参数）   状态                排除/入选理由");
  console.log("-".repeat(90));
  for (const r of rows) {
    console.log(
      [
        String(r.eventIndex).padEnd(8),
        String(r.mirrorId).padEnd(4),
        (r.t === null ? "—" : fmt(r.t)).padEnd(16),
        r.status.padEnd(19),
        r.reason,
      ].join(" "),
    );
  }
}

function cmdExport(): void {
  const runId = Number(args[1]);
  if (!Number.isInteger(runId)) throw new AppError("VALIDATION", "用法: cli export <runId>");
  const header = getRunHeader(db, runId);
  const scene = getScene(db, header.scene_id);
  console.log(
    JSON.stringify(
      {
        format: "coordinates-v1",
        coordinateSystem:
          "二维直角坐标；角度为弧度，入射角取方向与法线夹角 [0, π/2]；路程为欧氏长度累加（含反射微偏移）。",
        scene,
        run: {
          id: header.id,
          status: header.status,
          origin: JSON.parse(header.origin),
          direction: JSON.parse(header.direction),
          settings: JSON.parse(header.settings),
          events: getEvents(db, runId),
          path: getPath(db, runId),
        },
      },
      null,
      2,
    ),
  );
}

try {
  switch (command) {
    case "scene-list": {
      for (const s of listScenes(db)) {
        console.log(`#${s.id} v${s.version} ${s.name}${s.parentId === null ? "" : ` (基于 #${s.parentId})`}`);
      }
      break;
    }
    case "scene-get": {
      const id = Number(args[1]);
      console.log(JSON.stringify(getScene(db, id), null, 2));
      break;
    }
    case "scene-create":
      cmdSceneCreate();
      break;
    case "run-list": {
      const sceneId = args[1] !== undefined ? Number(args[1]) : undefined;
      for (const r of listRuns(db, sceneId)) {
        console.log(`运行 #${r.id} 场景 #${r.sceneId} 状态 ${r.status} ${r.createdAt}`);
      }
      break;
    }
    case "run":
      cmdRun();
      break;
    case "run-show": {
      const id = Number(args[1]);
      printReflections(id);
      break;
    }
    case "candidates":
      cmdCandidates();
      break;
    case "export":
      cmdExport();
      break;
    default:
      console.log(`二维平面镜反射 CLI（数据库: ${dbPath}）

用法:
  npm run cli -- scene-list
  npm run cli -- scene-create --mirrors '<json>'
  npm run cli -- scene-get <sceneId>
  npm run cli -- run-list [sceneId]
  npm run cli -- run <sceneId> --launch '{"origin":{...},"direction":{...},"maxReflections":20}'
  npm run cli -- run-show <runId>
  npm run cli -- candidates <runId> [eventIndex]
  npm run cli -- export <runId>

--mirrors JSON 可为 [{"a":{"x":..,"y":..},"b":{...}}] 或包含 mirrors/bounds/name/parentId/settings 的对象。`);
  }
} catch (err) {
  fail(err);
}
