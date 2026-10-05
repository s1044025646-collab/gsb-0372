import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { ApiError, ERR } from "./errors.ts";
import { simulate } from "./engine.ts";
import { Store } from "./store.ts";
import { parseScene, parseVec2, validateRay } from "./validate.ts";
import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

const DATA_DIR = process.env.MIRROR_DATA_DIR ?? "data";
const DB_PATH = process.env.MIRROR_DB ?? `${DATA_DIR}/mirror.db`;

function loadSettings(): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (existsSync("settings.json")) {
    try {
      Object.assign(s, JSON.parse(readFileSync("settings.json", "utf8")));
    } catch {
      // 忽略损坏配置，使用默认值
    }
  }
  for (const k of ["eps", "coordLimit", "maxMirrors", "maxReflections", "maxExplanations"] as const) {
    const env = process.env[`MIRROR_${k.toUpperCase()}`];
    if (env !== undefined && Number.isFinite(Number(env))) (s as Record<string, number>)[k] = Number(env);
  }
  return s;
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(ERR.BAD_REQUEST, "请求体不是合法 JSON");
  }
}

export function createApp(store: Store, settings: Settings): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req) : null;

      // POST /scenes 保存场景（不可变，返回新版本 id）
      if (method === "POST" && parts[0] === "scenes" && parts.length === 1) {
        const scene = parseScene(body, settings);
        return send(201, { sceneId: store.saveScene(scene), scene });
      }
      // POST /scenes/validate 仅校验不保存
      if (method === "POST" && parts[0] === "scenes" && parts[1] === "validate") {
        const scene = parseScene(body, settings);
        return send(200, { ok: true, mirrorCount: scene.mirrors.length });
      }
      // GET /scenes/:id
      if (method === "GET" && parts[0] === "scenes" && parts.length === 2) {
        return send(200, { scene: store.getScene(Number(parts[1])) });
      }
      // POST /rays 建立射线 {sceneId, origin, direction}
      if (method === "POST" && parts[0] === "rays" && parts.length === 1) {
        const o = body as Record<string, unknown>;
        const sceneId = Number(o.sceneId);
        if (!Number.isInteger(sceneId)) throw new ApiError(ERR.BAD_REQUEST, "sceneId 必须是整数");
        const scene = store.getScene(sceneId);
        const origin = parseVec2(o.origin, "origin");
        const direction = parseVec2(o.direction, "direction");
        validateRay(origin, direction, scene, settings);
        return send(201, { rayId: store.saveRay(sceneId, origin, direction) });
      }
      // POST /rays/:id/run {maxReflections?}
      if (method === "POST" && parts[0] === "rays" && parts[2] === "run") {
        const ray = store.getRay(Number(parts[1]));
        const scene = store.getScene(ray.sceneId);
        validateRay(ray.origin, ray.dir, scene, settings);
        const o = (body ?? {}) as Record<string, unknown>;
        let maxRef: number | undefined;
        if (o.maxReflections !== undefined) {
          maxRef = Number(o.maxReflections);
          if (!Number.isInteger(maxRef) || maxRef < 0 || maxRef > settings.maxReflections) {
            throw new ApiError(ERR.LIMIT_EXCEEDED, `maxReflections 须为 0..${settings.maxReflections} 的整数`);
          }
        }
        const result = simulate(scene, ray.origin, ray.dir, settings, maxRef);
        const runId = store.saveRun(Number(parts[1]), settings, result);
        return send(201, { runId, result });
      }
      // GET /runs/:id 概要；GET /runs/:id/path 事件表；GET /runs/:id/export 坐标
      if (method === "GET" && parts[0] === "runs" && parts.length >= 2) {
        const runId = Number(parts[1]);
        const run = store.getRun(runId);
        if (parts.length === 2) return send(200, { run });
        if (parts[2] === "path") return send(200, { events: store.getEvents(runId) });
        if (parts[2] === "explain" && parts.length === 4) {
          return send(200, { explanation: store.getExplanation(runId, Number(parts[3])) });
        }
        if (parts[2] === "export") {
          const events = store.getEvents(runId) as Array<{
            seq: number; origin: { x: number; y: number }; hit: { x: number; y: number };
          }>;
          const lines = ["seq,from_x,from_y,to_x,to_y"];
          for (const e of events) lines.push(`${e.seq},${e.origin.x},${e.origin.y},${e.hit.x},${e.hit.y}`);
          const exit = run.exit as { point: { x: number; y: number } } | null;
          if (exit) lines.push(`exit,${events.at(-1)?.hit.x ?? ""},${events.at(-1)?.hit.y ?? ""},${exit.point.x},${exit.point.y}`);
          res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
          return res.end(lines.join("\n"));
        }
      }
      throw new ApiError(ERR.NOT_FOUND, `路由不存在: ${method} ${url.pathname}`, 404);
    } catch (err) {
      if (err instanceof ApiError) return send(err.httpStatus, { error: { code: err.code, message: err.message } });
      send(500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}

/** 选择空闲端口：优先 PORT 环境变量，否则让系统分配 0 */
export function startServer(port?: number): Promise<{ server: Server; port: number }> {
  const store = new Store(DB_PATH);
  const settings = loadSettings();
  const server = createApp(store, settings);
  server.on("close", () => store.close());
  const preferred = port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
  return new Promise((resolve) => {
    server.listen(preferred, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : preferred;
      console.log(`API 服务已启动: http://127.0.0.1:${p}  (数据库: ${DB_PATH})`);
      resolve({ server, port: p });
    });
  });
}

// 直接运行时启动服务
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  void startServer();
}
