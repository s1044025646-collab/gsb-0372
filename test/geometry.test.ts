import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import { dot, executeRunHelpers } from "./helpers.js";
import { DEFAULT_SETTINGS } from "../src/types.js";

// executeRun 经 helpers 暴露，避免重复装配。
void executeRunHelpers;

const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const eps = DEFAULT_SETTINGS.epsilon;

test("水平镜反转竖直分量，水平分量保持", () => {
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 1, y: 5 }, b: { x: 9, y: 5 } }] };
  const result = executeRunHelpers(scene, { origin: { x: 2, y: 7 }, direction: { x: 1, y: -1 } });
  assert.equal(result.status, "exited");
  assert.equal(result.reflections.length, 1);
  const e = result.reflections[0]!;
  assert.ok(Math.abs(e.reflected.x - e.incoming.x) < 1e-12, "切向分量应保持");
  assert.ok(Math.abs(e.reflected.y - -e.incoming.y) < 1e-12, "法向分量应变号");
  assert.ok(Math.abs(e.point.x - 4) < 1e-9);
  assert.ok(Math.abs(e.point.y - 5) < 1e-9);
  // 段距离：方向 (1,-1)/√2，Δ=(2,-2)，t=2√2
  assert.ok(Math.abs(e.segmentDistance - 2 * Math.SQRT2) < 1e-9);
});

test("竖直镜反转水平分量", () => {
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 5, y: 1 }, b: { x: 5, y: 9 } }] };
  const result = executeRunHelpers(scene, { origin: { x: 2, y: 2 }, direction: { x: 1, y: 1 } });
  const e = result.reflections[0]!;
  assert.ok(Math.abs(e.reflected.x - -e.incoming.x) < 1e-12);
  assert.ok(Math.abs(e.reflected.y - e.incoming.y) < 1e-12);
});

test("法向取另一侧得到相同反射方向", () => {
  const m1 = [{ id: 0, a: { x: 1, y: 5 }, b: { x: 9, y: 5 } }];
  const m2 = [{ id: 0, a: { x: 9, y: 5 }, b: { x: 1, y: 5 } }];
  const launch = { origin: { x: 2, y: 7 }, direction: { x: 1, y: -1 } };
  const r1 = executeRunHelpers({ bounds, mirrors: m1 }, launch);
  const r2 = executeRunHelpers({ bounds, mirrors: m2 }, launch);
  assert.deepEqual(
    r1.reflections[0]!.reflected,
    r2.reflections[0]!.reflected,
  );
});

test("方向缩放后路径相同（归一化不变）", () => {
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 1, y: 5 }, b: { x: 9, y: 5 } }] };
  const r1 = executeRunHelpers(scene, { origin: { x: 2, y: 7 }, direction: { x: 3, y: -3 } });
  const r2 = executeRunHelpers(scene, { origin: { x: 2, y: 7 }, direction: { x: 1, y: -1 } });
  assert.equal(r1.reflections.length, r2.reflections.length);
  for (let i = 0; i < r1.reflections.length; i += 1) {
    assert.ok(Math.abs(r1.reflections[i]!.point.x - r2.reflections[i]!.point.x) < 1e-12);
    assert.ok(Math.abs(r1.reflections[i]!.cumulativeDistance - r2.reflections[i]!.cumulativeDistance) < 1e-9);
  }
});

test("场景平移不变性（整体平移后路径相应平移）", () => {
  const scene = {
    bounds: { minX: -5, minY: -5, maxX: 5, maxY: 5 },
    mirrors: [{ id: 0, a: { x: -4, y: 0 }, b: { x: 4, y: 0 } }],
  };
  const result = executeRunHelpers(scene, { origin: { x: -3, y: 2 }, direction: { x: 1, y: -1 } });
  const e = result.reflections[0]!;
  // 原始 (2,7)->(4,5)，平移 (-5,-5) 后为 (-3,2)->(-1,0)
  assert.ok(Math.abs(e.point.x - -1) < 1e-9);
  assert.ok(Math.abs(e.point.y - 0) < 1e-9);
});

test("平行错过：与镜面平行不相交则跳过直到边界", () => {
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 2, y: 5 }, b: { x: 8, y: 5 } }] };
  const result = executeRunHelpers(scene, { origin: { x: 1, y: 3 }, direction: { x: 1, y: 0 } });
  assert.equal(result.status, "exited");
  assert.equal(result.reflections.length, 0);
  assert.equal(result.exit!.side, "right");
});

test("延长线相交不在线段范围内：排除该镜面", () => {
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 7, y: 5 }, b: { x: 9, y: 5 } }] };
  const result = executeRunHelpers(scene, { origin: { x: 2, y: 2 }, direction: { x: 1, y: 1 } });
  assert.equal(result.reflections.length, 0);
  assert.equal(result.status, "exited");
  const candidate = result.reflections.length > 0 ? null : null;
  void candidate;
});

test("最近镜面选择：近镜优先，不能静默选数组第一面", () => {
  const scene = {
    bounds,
    mirrors: [
      { id: 0, a: { x: 1, y: 8 }, b: { x: 9, y: 8 } }, // 远
      { id: 1, a: { x: 1, y: 4 }, b: { x: 9, y: 4 } }, // 近
    ],
  };
  const result = executeRunHelpers(scene, { origin: { x: 2, y: 2 }, direction: { x: 0, y: 1 } });
  assert.equal(result.reflections[0]!.mirrorId, 1);
});

test("命中端点报告几何歧义并停止", () => {
  // 射线从 (2,5) 水平向右，直指镜面端点 (7,5)。
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 7, y: 5 }, b: { x: 9, y: 6 } }] };
  const result = executeRunHelpers(scene, { origin: { x: 2, y: 5 }, direction: { x: 1, y: 0 } });
  assert.equal(result.status, "geometric_ambiguity");
  assert.equal(result.ambiguity!.kind, "endpoint");
});

test("两面镜子同时同点命中报告歧义", () => {
  // 两面镜在 (5,5) 内部交叉，射线从 (5,1) 向上同时命中交点。
  const scene = {
    bounds,
    mirrors: [
      { id: 0, a: { x: 2, y: 5 }, b: { x: 8, y: 5 } },
      { id: 1, a: { x: 5, y: 2 }, b: { x: 5, y: 8 } },
    ],
  };
  const result = executeRunHelpers(scene, { origin: { x: 5, y: 1 }, direction: { x: 0, y: 1 } });
  assert.equal(result.status, "geometric_ambiguity");
  assert.equal(result.ambiguity!.kind, "simultaneous");
});

test("重合线（射线与镜面共线）报告歧义", () => {
  // 起点在线段范围外、但在镜面所在直线上，沿直线射向镜面：共线歧义。
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 4, y: 5 }, b: { x: 8, y: 5 } }] };
  const result = executeRunHelpers(scene, { origin: { x: 2, y: 5 }, direction: { x: 1, y: 0 } });
  assert.equal(result.status, "geometric_ambiguity");
  assert.equal(result.ambiguity!.kind, "collinear");
});

test("起点位于镜面上在运行前拒绝", () => {
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 1, y: 5 }, b: { x: 9, y: 5 } }] };
  assert.throws(
    () => executeRunHelpers(scene, { origin: { x: 4, y: 5 }, direction: { x: 1, y: 0 } }),
    (err: unknown) => err instanceof AppError && err.code === "VALIDATION",
  );
});

test("预算不足：状态 budget_reached 且仍报告当前位置/方向", () => {
  const scene = {
    bounds,
    mirrors: [
      { id: 0, a: { x: 1, y: 3 }, b: { x: 9, y: 3 } },
      { id: 1, a: { x: 1, y: 7 }, b: { x: 9, y: 7 } },
    ],
  };
  const result = executeRunHelpers(
    scene,
    { origin: { x: 1.5, y: 4.5 }, direction: { x: 1, y: 1 }, maxReflections: 1 },
  );
  assert.equal(result.status, "budget_reached");
  assert.equal(result.reflections.length, 1);
  assert.ok(result.budgetPoint);
  assert.ok(result.budgetDirection);
  assert.ok(Math.abs(dot(result.budgetDirection!, result.budgetDirection!) - 1) < 1e-12);
});

test("反射后不会零距离重复碰撞，且每段长度非负、方向单位化", () => {
  const scene = {
    bounds,
    mirrors: [
      { id: 0, a: { x: 1, y: 3 }, b: { x: 9, y: 3 } },
      { id: 1, a: { x: 1, y: 7 }, b: { x: 9, y: 7 } },
    ],
  };
  const result = executeRunHelpers(scene, { origin: { x: 1.5, y: 4.5 }, direction: { x: 1, y: 1 } });
  for (const e of result.reflections) {
    assert.ok(e.segmentDistance >= 0);
    assert.ok(Math.abs(dot(e.reflected, e.reflected) - 1) < 1e-12);
    assert.ok(Math.abs(dot(e.incoming, e.incoming) - 1) < 1e-12);
  }
  // 平行镜场景下应反弹 2 次后从右侧离开
  assert.equal(result.status, "exited");
  assert.equal(result.reflections.length, 2);
  assert.ok(result.exit!.cumulativeDistance > 0);
});

test("手算轴对齐场景：逐次校验法向分量反号、切向分量相同", () => {
  const scene = { bounds, mirrors: [{ id: 0, a: { x: 0.5, y: 5 }, b: { x: 9.5, y: 5 } }] };
  const result = executeRunHelpers(scene, { origin: { x: 1, y: 6 }, direction: { x: 3, y: -4 } });
  const e = result.reflections[0]!;
  const n = e.normal;
  const dnIn = dot(e.incoming, n);
  const dnOut = dot(e.reflected, n);
  assert.ok(dnIn * dnOut < 0, "法向分量符号相反");
  assert.ok(Math.abs(dnIn + dnOut) < 1e-12, "法向分量大小相等");
  // 切向（垂直 n 的方向 (n.y,-n.x)）分量相同
  const t = { x: n.y, y: -n.x };
  assert.ok(Math.abs(dot(e.incoming, t) - dot(e.reflected, t)) < 1e-12, "切向分量相同");
  // 入射点：方向归一 (0.6,-0.8)，从 (1,6) 到 y=5：t=1.25，x=1.75
  assert.ok(Math.abs(e.point.x - 1.75) < eps);
  assert.ok(Math.abs(e.point.y - 5) < eps);
  assert.ok(Math.abs(e.segmentDistance - 1.25) < 1e-9);
});
