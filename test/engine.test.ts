import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, checkReflectionInvariants } from "../src/engine.ts";
import { mirrorNormal, reflect, normalize } from "../src/geometry.ts";
import { validateRay, parseScene } from "../src/validate.ts";
import { ApiError } from "../src/errors.ts";
import { DEFAULT_SETTINGS, type Scene } from "../src/types.ts";

const boundary = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
const S = DEFAULT_SETTINGS;

test("水平镜反转竖直分量", () => {
  const scene: Scene = { boundary, mirrors: [{ id: 1, a: { x: 2, y: 3 }, b: { x: 8, y: 3 } }] };
  const r = simulate(scene, { x: 5, y: 8 }, { x: 1, y: -2 }, S);
  assert.equal(r.status, "exited");
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  // 手算：t=2.5 命中 (7.5,3)，方向 (1,-2)/√5 → (1,2)/√5
  assert.ok(Math.abs(e.hit.x - 7.5) < 1e-9 && Math.abs(e.hit.y - 3) < 1e-9);
  const n = normalize({ x: 1, y: 2 });
  assert.ok(Math.abs(e.dirOut.x - n.x) < 1e-9 && Math.abs(e.dirOut.y - n.y) < 1e-9);
  assert.ok(Math.abs(e.distance - 2.5 * Math.sqrt(5)) < 1e-9);
  assert.ok(checkReflectionInvariants(e));
});

test("竖直镜反转水平分量", () => {
  const scene: Scene = { boundary, mirrors: [{ id: 1, a: { x: 7, y: 2 }, b: { x: 7, y: 8 } }] };
  const r = simulate(scene, { x: 2, y: 5 }, { x: 3, y: 1 }, S);
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.ok(Math.abs(e.hit.x - 7) < 1e-9);
  assert.ok(e.dirOut.x < 0 && e.dirOut.y > 0);
  assert.ok(checkReflectionInvariants(e));
});

test("两面平行镜之间多次反射", () => {
  const scene: Scene = {
    boundary,
    mirrors: [
      { id: 1, a: { x: 1, y: 2 }, b: { x: 9, y: 2 } },
      { id: 2, a: { x: 1, y: 8 }, b: { x: 9, y: 8 } },
    ],
  };
  const r = simulate(scene, { x: 5, y: 5 }, { x: 1, y: -4 }, S);
  assert.equal(r.status, "exited");
  // 从 (5,5) 向斜下：在 y=2 与 y=8 之间往返，x 递增，直至 x>9 超出镜面
  assert.ok(r.events.length >= 2);
  assert.deepEqual(
    r.events.map((e) => e.mirrorId),
    [1, 2, 1],
  );
  for (const e of r.events) assert.ok(checkReflectionInvariants(e));
  // 每段长度非负且方向单位化
  for (const e of r.events) {
    assert.ok(e.distance > 0);
    assert.ok(Math.abs(Math.hypot(e.dirOut.x, e.dirOut.y) - 1) < 1e-9);
  }
});

test("延长线相交不算命中，选择最近有效镜面", () => {
  const scene: Scene = {
    boundary,
    mirrors: [
      { id: 1, a: { x: 4, y: 6 }, b: { x: 4, y: 8 } }, // 延长线被穿过
      { id: 2, a: { x: 3, y: 4 }, b: { x: 3, y: 6 } },
    ],
  };
  const r = simulate(scene, { x: 5, y: 5 }, { x: -1, y: 0 }, S);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].mirrorId, 2);
  const step = r.explanations[0];
  const c1 = step.candidates.find((c) => c.mirrorId === 1);
  assert.equal(c1?.status, "excluded");
  assert.equal(c1?.reason, "extension");
});

test("法向翻转不变", () => {
  const d = normalize({ x: 1, y: -2 });
  const n1 = mirrorNormal({ x: 2, y: 3 }, { x: 8, y: 3 });
  const n2 = { x: -n1.x, y: -n1.y };
  const r1 = reflect(d, n1);
  const r2 = reflect(d, n2);
  assert.ok(Math.abs(r1.x - r2.x) < 1e-12 && Math.abs(r1.y - r2.y) < 1e-12);
});

test("方向缩放归一后路径相同", () => {
  const scene: Scene = { boundary, mirrors: [{ id: 1, a: { x: 2, y: 3 }, b: { x: 8, y: 3 } }] };
  const r1 = simulate(scene, { x: 5, y: 8 }, { x: 1, y: -2 }, S);
  const r2 = simulate(scene, { x: 5, y: 8 }, { x: 100, y: -200 }, S);
  assert.equal(r1.events.length, r2.events.length);
  assert.ok(Math.abs(r1.totalDistance - r2.totalDistance) < 1e-9);
  assert.ok(Math.abs(r1.events[0].hit.x - r2.events[0].hit.x) < 1e-9);
});

test("场景平移路径同步平移", () => {
  const scene1: Scene = { boundary, mirrors: [{ id: 1, a: { x: 2, y: 3 }, b: { x: 8, y: 3 } }] };
  const scene2: Scene = {
    boundary: { minX: 100, minY: 100, maxX: 110, maxY: 110 },
    mirrors: [{ id: 1, a: { x: 102, y: 103 }, b: { x: 108, y: 103 } }],
  };
  const r1 = simulate(scene1, { x: 5, y: 8 }, { x: 1, y: -2 }, S);
  const r2 = simulate(scene2, { x: 105, y: 108 }, { x: 1, y: -2 }, S);
  assert.equal(r1.events.length, r2.events.length);
  assert.ok(Math.abs(r2.events[0].hit.x - r1.events[0].hit.x - 100) < 1e-9);
  assert.ok(Math.abs(r1.totalDistance - r2.totalDistance) < 1e-9);
});

test("平行错过：平行镜面被跳过", () => {
  const scene: Scene = { boundary, mirrors: [{ id: 1, a: { x: 2, y: 8 }, b: { x: 8, y: 8 } }] };
  const r = simulate(scene, { x: 5, y: 5 }, { x: 1, y: 0 }, S);
  assert.equal(r.status, "exited");
  assert.equal(r.events.length, 0);
  const c = r.explanations[0].candidates[0];
  assert.equal(c.status, "excluded");
  assert.equal(c.reason, "parallel");
});

test("端点命中报告几何歧义并停止", () => {
  const scene: Scene = { boundary, mirrors: [{ id: 1, a: { x: 5, y: 3 }, b: { x: 9, y: 3 } }] };
  const r = simulate(scene, { x: 5, y: 8 }, { x: 0, y: -1 }, S); // 直击端点 (5,3)
  assert.equal(r.status, "ambiguity");
  assert.match(r.ambiguity ?? "", /端点/);
});

test("多镜面同时命中报告歧义，不静默选第一面", () => {
  const scene: Scene = {
    boundary,
    mirrors: [
      { id: 1, a: { x: 3, y: 4 }, b: { x: 5, y: 6 } },
      { id: 2, a: { x: 5, y: 6 }, b: { x: 7, y: 4 } },
    ],
  };
  const r = simulate(scene, { x: 5, y: 1 }, { x: 0, y: 1 }, S); // 直击连接点 (5,6)
  assert.equal(r.status, "ambiguity");
});

test("预算不足状态明确区分", () => {
  const scene: Scene = {
    boundary,
    mirrors: [
      { id: 1, a: { x: 1, y: 2 }, b: { x: 9, y: 2 } },
      { id: 2, a: { x: 1, y: 8 }, b: { x: 9, y: 8 } },
    ],
  };
  // 垂直方向在两面水平镜之间无限往返
  const r = simulate(scene, { x: 5, y: 5 }, { x: 0, y: 1 }, S, 2);
  assert.equal(r.status, "budget_exhausted");
  assert.equal(r.events.length, 2);
  assert.ok(!r.exit); // 预算用尽不代表已离开
});

test("起点在镜面上运行前拒绝", () => {
  const scene: Scene = { boundary, mirrors: [{ id: 1, a: { x: 2, y: 3 }, b: { x: 8, y: 3 } }] };
  assert.throws(() => validateRay({ x: 5, y: 3 }, { x: 1, y: 0 }, scene, S), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal((e as ApiError).code, "ORIGIN_ON_MIRROR");
    return true;
  });
});

test("退化镜面、越界镜面、零方向、界外起点均被拒绝", () => {
  assert.throws(() => parseScene({ boundary, mirrors: [{ a: { x: 5, y: 5 }, b: { x: 5, y: 5 } }] }, S), /退化/);
  assert.throws(() => parseScene({ boundary, mirrors: [{ a: { x: -1, y: 5 }, b: { x: 5, y: 5 } }] }, S), /边界内部/);
  const scene: Scene = { boundary, mirrors: [] };
  assert.throws(() => validateRay({ x: 5, y: 5 }, { x: 0, y: 0 }, scene, S), /非零/);
  assert.throws(() => validateRay({ x: 50, y: 5 }, { x: 1, y: 0 }, scene, S), /内部/);
});

test("手算核对：轴对齐场景坐标与路程", () => {
  // 正方形边界 [0,10]^2，水平镜 y=4 从 x=2 到 8。
  // 从 (4,9) 垂直向下：t=5 命中 (4,4)，反射向上，t=5 到达边界 (4,9)？不，向上到 y=10，t=6。
  const scene: Scene = { boundary, mirrors: [{ id: 1, a: { x: 2, y: 4 }, b: { x: 8, y: 4 } }] };
  const r = simulate(scene, { x: 4, y: 9 }, { x: 0, y: -1 }, S);
  assert.equal(r.status, "exited");
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].distance, 5);
  assert.equal(r.events[0].cumulative, 5);
  assert.equal(r.exit?.distance, 6);
  assert.equal(r.totalDistance, 11);
  assert.deepEqual(r.exit?.point, { x: 4, y: 10 });
});
