import { readFileSync } from "node:fs";
import { ApiError } from "./errors.ts";
import { simulate } from "./engine.ts";
import { Store } from "./store.ts";
import { parseScene, parseVec2, validateRay } from "./validate.ts";
import { DEFAULT_SETTINGS, type ReflectionEvent } from "./types.ts";
import { startServer } from "./api.ts";

const DB_PATH = process.env.MIRROR_DB ?? "data/mirror.db";
const store = new Store(DB_PATH);
const settings = DEFAULT_SETTINGS;

const fmt = (n: number) => (Object.is(n, -0) ? "0" : String(Number(n.toFixed(9))));
const v = (p: { x: number; y: number }) => `(${fmt(p.x)}, ${fmt(p.y)})`;

/** 以反射事件表展示一次运行 */
export function printEventTable(events: ReflectionEvent[]): void {
  console.log("seq | mirror | hit                | normal          | dir_in          | dir_out         | dist      | cumulative");
  console.log("-".repeat(118));
  for (const e of events) {
    console.log(
      `${String(e.seq).padEnd(3)} | ${String(e.mirrorId).padEnd(6)} | ${v(e.hit).padEnd(18)} | ${v(e.normal).padEnd(15)} | ${v(e.dirIn).padEnd(15)} | ${v(e.dirOut).padEnd(15)} | ${fmt(e.distance).padEnd(9)} | ${fmt(e.cumulative)}`,
    );
  }
}

function readJson(arg: string): unknown {
  return JSON.parse(arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "scene-create": {
      const scene = parseScene(readJson(args[0]), settings);
      console.log(JSON.stringify({ sceneId: store.saveScene(scene) }));
      break;
    }
    case "scene-validate": {
      const scene = parseScene(readJson(args[0]), settings);
      console.log(JSON.stringify({ ok: true, mirrorCount: scene.mirrors.length }));
      break;
    }
    case "ray-create": {
      const [sceneId, ox, oy, dx, dy] = args.map(Number);
      const scene = store.getScene(sceneId);
      const origin = { x: ox, y: oy };
      const dir = { x: dx, y: dy };
      validateRay(origin, dir, scene, settings);
      console.log(JSON.stringify({ rayId: store.saveRay(sceneId, origin, dir) }));
      break;
    }
    case "run": {
      const rayId = Number(args[0]);
      const maxRef = args[1] !== undefined ? Number(args[1]) : undefined;
      const ray = store.getRay(rayId);
      const scene = store.getScene(ray.sceneId);
      validateRay(ray.origin, ray.dir, scene, settings);
      const result = simulate(scene, ray.origin, ray.dir, settings, maxRef);
      const runId = store.saveRun(rayId, settings, result);
      console.log(`runId=${runId} status=${result.status} total=${fmt(result.totalDistance)}`);
      if (result.ambiguity) console.log(`说明: ${result.ambiguity}`);
      printEventTable(result.events);
      if (result.exit) console.log(`exit at ${v(result.exit.point)} dir ${v(result.exit.dir)}`);
      break;
    }
    case "path": {
      printEventTable(store.getEvents(Number(args[0])) as ReflectionEvent[]);
      break;
    }
    case "explain": {
      console.log(JSON.stringify(store.getExplanation(Number(args[0]), Number(args[1])), null, 2));
      break;
    }
    case "export": {
      const events = store.getEvents(Number(args[0])) as ReflectionEvent[];
      console.log("seq,from_x,from_y,to_x,to_y");
      for (const e of events) console.log(`${e.seq},${e.origin.x},${e.origin.y},${e.hit.x},${e.hit.y}`);
      break;
    }
    case "serve": {
      const { port } = await startServer(args[0] ? Number(args[0]) : undefined);
      console.log(`port=${port}`);
      break;
    }
    default:
      console.log(`用法: node src/cli.ts <命令>
  scene-create <json|@file>          保存场景（不可变，返回新 id）
  scene-validate <json|@file>        仅校验场景
  ray-create <sceneId> <ox> <oy> <dx> <dy>
  run <rayId> [maxReflections]       运行并以事件表展示
  path <runId>                       查看路径事件表
  explain <runId> <seq>              查看某步候选与排除理由
  export <runId>                     导出坐标 CSV
  serve [port]                       启动 API（默认自动选空闲端口）`);
  }
  store.close();
}

// 仅作为入口直接运行时执行（被 demo 等模块导入时不执行）
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((err) => {
    if (err instanceof ApiError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      process.exit(2);
    }
    throw err;
  });
}
