/**
 * 演示：
 * 1. 水平镜反转竖直分量
 * 2. 竖直镜反转水平分量
 * 3. 两面平行镜之间多次反射
 * 4. 射线穿过镜面延长线但未碰到线段，核对最近镜面选择
 */
import { simulate } from "./engine.ts";
import { printEventTable } from "./cli.ts";
import { DEFAULT_SETTINGS, type Scene } from "./types.ts";

const boundary = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

function show(title: string, scene: Scene, origin: [number, number], dir: [number, number]): void {
  console.log(`\n=== ${title} ===`);
  const r = simulate(scene, { x: origin[0], y: origin[1] }, { x: dir[0], y: dir[1] }, DEFAULT_SETTINGS);
  console.log(`status=${r.status} total=${r.totalDistance.toFixed(9)}`);
  printEventTable(r.events);
  if (r.exit) console.log(`exit at (${r.exit.point.x}, ${r.exit.point.y})`);
  if (r.ambiguity) console.log(`说明: ${r.ambiguity}`);
}

// 1. 水平镜 y=3：竖直分量反转
show("水平镜：dy 反转", { boundary, mirrors: [{ id: 1, a: { x: 2, y: 3 }, b: { x: 8, y: 3 } }] }, [5, 8], [1, -2]);

// 2. 竖直镜 x=7：水平分量反转
show("竖直镜：dx 反转", { boundary, mirrors: [{ id: 1, a: { x: 7, y: 2 }, b: { x: 7, y: 8 } }] }, [2, 5], [3, 1]);

// 3. 两面平行镜之间多次反射
show(
  "平行镜多次反射",
  {
    boundary,
    mirrors: [
      { id: 1, a: { x: 1, y: 2 }, b: { x: 9, y: 2 } },
      { id: 2, a: { x: 1, y: 8 }, b: { x: 9, y: 8 } },
    ],
  },
  [5, 5],
  [1, -4],
);

// 4. 延长线相交但线段未命中：射线 y=5 水平向左，
//    镜面 1 的延长线（x=4 竖直线）被穿过但线段在 y∈[6,8] 不命中；
//    最近有效命中是镜面 2（x=3, y∈[4,6]）。
show(
  "延长线不算命中，核对最近镜面",
  {
    boundary,
    mirrors: [
      { id: 1, a: { x: 4, y: 6 }, b: { x: 4, y: 8 } }, // 延长线相交，线段不命中
      { id: 2, a: { x: 3, y: 4 }, b: { x: 3, y: 6 } }, // 最近有效命中
    ],
  },
  [5, 5],
  [-1, 0],
);
