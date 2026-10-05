import { join } from "node:path";
import {
  getCandidates,
  getEvents,
  getPath,
  getRunHeader,
  insertScene,
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

const dbPath = join(process.cwd(), "data", "demo.db");
const db = openDatabase(dbPath);
const settings = validateSettings(undefined);

function createDemo(name: string, mirrors: MirrorInput[]) {
  const bounds = validateBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, settings);
  const validMirrors = validateMirrors(mirrors, settings);
  assertMirrorsInside({ bounds, mirrors: validMirrors }, settings);
  return insertScene(db, { name, bounds, mirrors: validMirrors });
}

function run(sceneId: number, origin: { x: number; y: number }, direction: { x: number; y: number }, maxReflections?: number) {
  const scene = getSceneLite(sceneId);
  const result = executeRun(scene, { origin, direction, maxReflections }, settings);
  const runId = saveRun(db, {
    sceneId,
    origin: result.origin,
    direction: result.direction,
    reflectionBudget: maxReflections ?? settings.maxReflections,
    settings,
    result,
  });
  return { runId, result };
}

function getSceneLite(id: number) {
  const row = db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as {
    bounds: string;
    mirrors: string;
  };
  return {
    bounds: JSON.parse(row.bounds),
    mirrors: JSON.parse(row.mirrors),
  };
}

function heading(text: string): void {
  console.log("\n" + "=".repeat(72));
  console.log(text);
  console.log("=".repeat(72));
}

function summarize(label: string, r: ReturnType<typeof run>): void {
  console.log(`\n[${label}] 状态: ${r.result.status}`);
  for (const e of r.result.reflections) {
    console.log(
      `  反射 #${e.index} 镜面 ${e.mirrorId} 点=(${e.point.x.toFixed(3)}, ${e.point.y.toFixed(3)}) ` +
        `入射=(${e.incoming.x.toFixed(3)}, ${e.incoming.y.toFixed(3)}) ` +
        `反射=(${e.reflected.x.toFixed(3)}, ${e.reflected.y.toFixed(3)}) ` +
        `法向=(${e.normal.x.toFixed(3)}, ${e.normal.y.toFixed(3)}) 段距=${e.segmentDistance.toFixed(4)} 累计=${e.cumulativeDistance.toFixed(4)}`,
    );
  }
  if (r.result.exit) {
    console.log(
      `  离开: 边 ${r.result.exit.side} 点=(${r.result.exit.point.x.toFixed(3)}, ${r.result.exit.point.y.toFixed(3)}) 总路程=${r.result.exit.cumulativeDistance.toFixed(4)}`,
    );
  }
}

heading("演示 1：水平镜反转竖直分量");
// 水平镜面 y=5，x∈[1,9]；方向 (1,-1) 向下入射，反射后 y 分量反号。
const s1 = createDemo("水平镜", [{ a: { x: 1, y: 5 }, b: { x: 9, y: 5 } }]);
summarize("向下 45° 撞水平镜", run(s1.id, { x: 2, y: 7 }, { x: 1, y: -1 }));

heading("演示 2：竖直镜反转水平分量");
const s2 = createDemo("竖直镜", [{ a: { x: 5, y: 1 }, b: { x: 5, y: 9 } }]);
summarize("向右 45° 撞竖直镜", run(s2.id, { x: 2, y: 2 }, { x: 1, y: 1 }));

heading("演示 3：两面平行水平镜之间多次反射");
const s3 = createDemo("平行双镜", [
  { a: { x: 1, y: 3 }, b: { x: 9, y: 3 } },
  { a: { x: 1, y: 7 }, b: { x: 9, y: 7 } },
]);
summarize("斜射在两水平镜间反弹", run(s3.id, { x: 1.5, y: 4.5 }, { x: 1, y: 1 }));

heading("演示 4：穿过镜面延长线但未碰到线段（核对最近选择）");
// 短镜 y=5 仅 x∈[7,9]；射线沿 y=5 高度方向不同，这里构造斜线：
// 射线 x=2 起，方向 (1,1)，与短镜所在直线的交点在延长线上（x<7），必须排除。
const s4 = createDemo("延长线错过", [{ a: { x: 7, y: 5 }, b: { x: 9, y: 5 } }]);
const r4 = run(s4.id, { x: 2, y: 2 }, { x: 1, y: 1 });
summarize("交点仅在延长线上", r4);
console.log("  该面镜候选解释:");
for (const c of getCandidates(db, r4.runId)) {
  console.log(`    镜面 ${c.mirrorId}: ${c.status} — ${c.reason}`);
}

heading("演示 5：预算不足（长反射，预算 2）");
const r5 = run(s3.id, { x: 1.5, y: 4.5 }, { x: 1, y: 1 }, 2);
summarize("预算=2", r5);
if (r5.result.budgetPoint && r5.result.budgetDirection) {
  console.log(
    `  预算点=(${r5.result.budgetPoint.x.toFixed(3)}, ${r5.result.budgetPoint.y.toFixed(3)}) 方向=(${r5.result.budgetDirection.x.toFixed(3)}, ${r5.result.budgetDirection.y.toFixed(3)})，射线仍在场景内`,
  );
}

heading("持久化核对：重启后仍可查询（直接从数据库读取最近一次运行）");
const events = getEvents(db, r5.runId);
const path = getPath(db, r5.runId);
const header = getRunHeader(db, r5.runId);
console.log(`运行 #${r5.runId} 状态 ${header.status}，反射事件 ${events.length} 条，路径点 ${path.length} 个`);

console.log(`\n演示数据库: ${dbPath}`);
console.log("可执行: npm run cli -- candidates <runId> 查看每次相交候选与排除理由");
