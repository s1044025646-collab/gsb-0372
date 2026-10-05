import {
  add,
  isCollinear,
  len,
  mirrorNormal,
  normalize,
  rayBoundaryExit,
  raySegmentIntersect,
  reflect,
  scale,
} from "./geometry.ts";
import type {
  Candidate,
  ReflectionEvent,
  RunResult,
  Scene,
  Settings,
  StepExplanation,
  Vec2,
} from "./types.ts";

/**
 * 运行一次射线模拟。
 *
 * 公开规则：
 * - 每一步求正向射线与全部镜面线段的最近有效交点（t > eps，s ∈ [-eps, 1+eps]）。
 * - 命中端点（s 接近 0 或 1）、多镜面同时命中（t 差 < eps）、与镜面共线：
 *   报告几何歧义并停止，绝不静默选择数组中的第一面镜子。
 * - 平行且不相交的线段跳过；延长线相交（s 越界）不计入。
 * - 边界只截断轨迹，不反射。
 * - 预算用尽时状态为 budget_exhausted，不代表射线已离开场景。
 */
export function simulate(
  scene: Scene,
  origin: Vec2,
  direction: Vec2,
  settings: Settings,
  maxReflections?: number,
): RunResult {
  const eps = settings.eps;
  const budget = Math.min(maxReflections ?? settings.maxReflections, settings.maxReflections);
  const b = scene.boundary;
  const bMin = { x: b.minX, y: b.minY };
  const bMax = { x: b.maxX, y: b.maxY };

  let p = origin;
  let d = normalize(direction);
  let cumulative = 0;
  const events: ReflectionEvent[] = [];
  const explanations: StepExplanation[] = [];
  let explanationsTruncated = false;

  for (let seq = 1; seq <= budget; seq++) {
    const boundaryT = rayBoundaryExit(p, d, bMin, bMax);

    // 评估全部镜面候选
    const candidates: Candidate[] = [];
    for (const m of scene.mirrors) {
      const normal = mirrorNormal(m.a, m.b);
      const hitInfo = raySegmentIntersect(p, d, m.a, m.b, eps);
      if (hitInfo === null) {
        if (isCollinear(p, d, m.a, m.b, eps)) {
          return finish("ambiguity", `射线与镜面 ${m.id} 共线（重合），几何歧义，停止`);
        }
        candidates.push({
          mirrorId: m.id, t: Infinity, s: NaN,
          hit: { x: NaN, y: NaN }, normal,
          status: "excluded", reason: "parallel",
        });
        continue;
      }
      const { t, s } = hitInfo;
      const hit = add(p, scale(d, t));
      if (t <= eps) {
        candidates.push({
          mirrorId: m.id, t, s, hit, normal,
          status: "excluded",
          reason: t < -eps ? "behind" : "self_proximity", // 刚反射出的零距离交点
        });
        continue;
      }
      if (s < -eps || s > 1 + eps) {
        candidates.push({
          mirrorId: m.id, t, s, hit, normal,
          status: "excluded", reason: "extension", // 延长线相交，不在线段上
        });
        continue;
      }
      if (s <= eps || s >= 1 - eps) {
        return finish("ambiguity", `射线命中镜面 ${m.id} 端点（s=${s.toFixed(6)}），几何歧义，停止`);
      }
      if (t >= boundaryT - eps) {
        candidates.push({
          mirrorId: m.id, t, s, hit, normal,
          status: "excluded", reason: "beyond_boundary", // 边界先截断
        });
        continue;
      }
      candidates.push({ mirrorId: m.id, t, s, hit, normal, status: "hit" });
    }

    const hits = candidates.filter((c) => c.status === "hit");
    let chosen: Candidate | null = null;
    let note: string;

    if (hits.length === 0) {
      note = "无更近镜面，射线到达边界并离开场景";
    } else {
      hits.sort((c1, c2) => c1.t - c2.t);
      if (hits.length > 1 && hits[1].t - hits[0].t < eps) {
        return finish(
          "ambiguity",
          `镜面 ${hits[0].mirrorId} 与 ${hits[1].mirrorId} 在 t≈${hits[0].t.toFixed(9)} 处同时命中，几何歧义，停止`,
        );
      }
      chosen = hits[0];
      note = `选择最近有效交点：镜面 ${chosen.mirrorId}，t=${chosen.t}`;
    }

    // 记录解释（受条数限制截断，计算仍继续）
    if (explanations.length < settings.maxExplanations) {
      explanations.push({ seq, origin: p, dir: d, chosen, candidates, boundaryT, note });
    } else {
      explanationsTruncated = true;
    }

    if (chosen === null) {
      // 离开边界
      const exitPoint = add(p, scale(d, boundaryT));
      cumulative += boundaryT;
      return {
        status: "exited",
        events,
        exit: { point: exitPoint, dir: d, distance: boundaryT },
        totalDistance: cumulative,
        explanations,
        explanationsTruncated,
      };
    }

    // 反射
    const dirOut = reflect(d, chosen.normal);
    events.push({
      seq,
      origin: p,
      mirrorId: chosen.mirrorId,
      hit: chosen.hit,
      normal: chosen.normal,
      dirIn: d,
      dirOut,
      distance: chosen.t,
      cumulative: cumulative + chosen.t,
    });
    cumulative += chosen.t;
    p = chosen.hit;
    d = dirOut;
  }

  return finish(
    "budget_exhausted",
    `反射预算 ${budget} 次用尽；射线未必已离开场景`,
  );

  function finish(status: "ambiguity" | "budget_exhausted", message: string): RunResult {
    if (status === "ambiguity") {
      return {
        status, events, totalDistance: cumulative,
        ambiguity: message, explanations, explanationsTruncated,
      };
    }
    return { status, events, totalDistance: cumulative, ambiguity: message, explanations, explanationsTruncated };
  }
}

/** 手算校验辅助：入射/出射方向的法向分量符号相反、切向分量相同 */
export function checkReflectionInvariants(e: ReflectionEvent): boolean {
  const n = e.normal;
  const tangent = { x: -n.y, y: n.x };
  const dnIn = e.dirIn.x * n.x + e.dirIn.y * n.y;
  const dnOut = e.dirOut.x * n.x + e.dirOut.y * n.y;
  const dtIn = e.dirIn.x * tangent.x + e.dirIn.y * tangent.y;
  const dtOut = e.dirOut.x * tangent.x + e.dirOut.y * tangent.y;
  const okLen = Math.abs(len(e.dirOut) - 1) < 1e-9;
  return dnIn * dnOut < 0 && Math.abs(dtIn - dtOut) < 1e-9 && okLen;
}
