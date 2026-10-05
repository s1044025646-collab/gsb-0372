import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
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
import type { LaunchInput, NumericSettings } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

export interface AppContext {
  db: ReturnType<typeof openDatabase>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError("VALIDATION", "请求体不是合法 JSON");
  }
}

const errorStatus: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GEOMETRY: 422,
  BUDGET: 422,
  INTERNAL: 500,
};

function createApp(ctx: AppContext) {
  const { db } = ctx;

  const handleSceneCreate = (body: any) => {
    const settings = validateSettings(body?.settings);
    const bounds = validateBounds(
      body?.bounds ?? { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      settings,
    );
    const mirrors = validateMirrors(body?.mirrors ?? [], settings);
    const draft = { bounds, mirrors };
    assertMirrorsInside(draft, settings);
    const scene = insertScene(db, {
      name: typeof body?.name === "string" && body.name.length > 0 ? body.name : "未命名场景",
      bounds,
      mirrors,
      parentId: body?.parentId ?? null,
    });
    return { status: 201, body: scene };
  };

  const handleRunCreate = (sceneId: number, body: any) => {
    const scene = getScene(db, sceneId);
    const settings = validateSettings(body?.settings);
    const launch: LaunchInput = {
      origin: body?.origin,
      direction: body?.direction,
      maxReflections: body?.maxReflections,
    };
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
    return { status: 201, body: { runId, ...serializeResult(result) } };
  };

  const serializeResult = (result: ReturnType<typeof executeRun>) => ({
    status: result.status,
    origin: result.origin,
    direction: result.direction,
    reflections: result.reflections,
    exit: result.exit,
    budgetPoint: result.budgetPoint,
    budgetDirection: result.budgetDirection,
    ambiguity: result.ambiguity,
    settings: result.settings,
  });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && path === "/health") {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && path === "/scenes") {
        send(res, 200, { scenes: listScenes(db) });
        return;
      }
      if (req.method === "POST" && path === "/scenes") {
        const out = handleSceneCreate(await readJson(req));
        send(res, out.status, out.body);
        return;
      }

      const sceneMatch = /^\/scenes\/(\d+)$/.exec(path);
      if (req.method === "GET" && sceneMatch) {
        send(res, 200, getScene(db, Number(sceneMatch[1])));
        return;
      }
      const validateMatch = /^\/scenes\/(\d+)\/validate$/.exec(path);
      if (req.method === "GET" && validateMatch) {
        const scene = getScene(db, Number(validateMatch[1]));
        send(res, 200, {
          valid: true,
          mirrorCount: scene.mirrors.length,
          bounds: scene.bounds,
          mirrors: scene.mirrors,
        });
        return;
      }
      const runsMatch = /^\/scenes\/(\d+)\/runs$/.exec(path);
      if (req.method === "GET" && runsMatch) {
        const sceneId = Number(runsMatch[1]);
        getScene(db, sceneId);
        send(res, 200, { runs: listRuns(db, sceneId) });
        return;
      }
      if (req.method === "POST" && runsMatch) {
        const out = handleRunCreate(Number(runsMatch[1]), await readJson(req));
        send(res, out.status, out.body);
        return;
      }

      const runMatch = /^\/runs\/(\d+)$/.exec(path);
      if (req.method === "GET" && runMatch) {
        const runId = Number(runMatch[1]);
        const header = getRunHeader(db, runId);
        const events = getEvents(db, runId);
        send(res, 200, {
          id: header.id,
          sceneId: header.scene_id,
          status: header.status,
          origin: JSON.parse(header.origin),
          direction: JSON.parse(header.direction),
          reflectionBudget: header.reflection_budget,
          settings: JSON.parse(header.settings) as NumericSettings,
          ambiguity: header.ambiguity ? JSON.parse(header.ambiguity) : null,
          reflections: events,
          createdAt: header.created_at,
        });
        return;
      }
      const pathMatch = /^\/runs\/(\d+)\/path$/.exec(path);
      if (req.method === "GET" && pathMatch) {
        const runId = Number(pathMatch[1]);
        getRunHeader(db, runId);
        send(res, 200, { runId, points: getPath(db, runId) });
        return;
      }
      const candidatesMatch = /^\/runs\/(\d+)\/candidates$/.exec(path);
      if (req.method === "GET" && candidatesMatch) {
        const runId = Number(candidatesMatch[1]);
        getRunHeader(db, runId);
        const eventIndex = url.searchParams.get("event");
        send(res, 200, {
          runId,
          candidates: getCandidates(
            db,
            runId,
            eventIndex === null ? undefined : Number(eventIndex),
          ),
        });
        return;
      }
      const exportMatch = /^\/runs\/(\d+)\/export$/.exec(path);
      if (req.method === "GET" && exportMatch) {
        const runId = Number(exportMatch[1]);
        const header = getRunHeader(db, runId);
        const scene = getScene(db, header.scene_id);
        send(res, 200, {
          format: "coordinates-v1",
          coordinateSystem:
            "二维直角坐标，x 向右、y 向上为数学正方向；角度为弧度，方向与镜面法线夹角取 [0, π/2]",
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
        });
        return;
      }
      if (req.method === "GET" && path === "/runs") {
        send(res, 200, { runs: listRuns(db) });
        return;
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由：${req.method} ${path}` } });
    } catch (err) {
      if (err instanceof AppError) {
        send(res, errorStatus[err.code] ?? 500, {
          error: { code: err.code, message: err.message, details: err.details ?? null },
        });
        return;
      }
      send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
    }
  };
}

/** 请求系统分配空闲端口（port=0），再关闭并复用该端口。 */
export function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
    srv.on("error", reject);
  });
}

export async function startServer(options: {
  port?: number;
  dbPath?: string;
}): Promise<{ server: Server; port: number; dbPath: string }> {
  const dbPath = options.dbPath ?? join(projectRoot, "data", "mirrors.db");
  const db = openDatabase(dbPath);
  const port = options.port ?? (await findFreePort());
  const server = createServer(createApp({ db }));
  await new Promise<void>((resolveStart) => server.listen(port, "127.0.0.1", resolveStart));
  return { server, port, dbPath };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const requested = process.env.PORT;
  const portArgIndex = process.argv.indexOf("--port");
  const port =
    portArgIndex >= 0 && process.argv[portArgIndex + 1]
      ? Number(process.argv[portArgIndex + 1])
      : requested
        ? Number(requested)
        : undefined;
  startServer({ port }).then(({ port: actual, dbPath }) => {
    console.log(`平面镜反射后端已启动: http://127.0.0.1:${actual}`);
    console.log(`数据目录数据库: ${dbPath}`);
  });
}
