import { AppError, geometryError, validationError } from "./errors.js";
import type {
  HitCandidate,
  Mirror,
  NumericSettings,
  ReflectionEvent,
  RunResult,
  Vec2,
} from "./types.js";

export const v = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 二维叉积（标量）：正值表示 b 在 a 逆时针方向。 */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  if (!Number.isFinite(len) || len === 0) {
    throw validationError("方向向量必须为非零有限向量", { vector: a });
  }
  return { x: a.x / len, y: a.y / len };
}

export const pointOnSegment = (p: Vec2, m: Mirror, eps: number): boolean => {
  const seg = sub(m.b, m.a);
  const segLen = length(seg);
  if (segLen <= eps) return false;
  const w = sub(p, m.a);
  if (Math.abs(cross(seg, w)) > eps * Math.max(1, segLen)) return false;
  const s = dot(w, seg) / (segLen * segLen);
  return s >= -eps / segLen && s <= 1 + eps / segLen;
};

export interface SegmentHit {
  mirrorId: number;
  t: number;
  s: number;
  point: Vec2;
  normal: Vec2;
}

export interface StepTrace {
  valid: SegmentHit[];
  candidates: HitCandidate[];
  candidatesTruncated: boolean;
  ambiguity: { kind: string; detail: string } | null;
}

function candidate(
  mirrorId: number,
  t: number | null,
  status: HitCandidate["status"],
  reason: string,
): HitCandidate {
  return { mirrorId, t, status, reason };
}

/**
 * 求正向射线 p+t*d（t>=0）与所有镜面线段的相交并分类。
 * 不接受线段延长线上的相交；端点命中与多镜同时命中报告几何歧义。
 */
export function traceStep(
  p: Vec2,
  d: Vec2,
  mirrors: Mirror[],
  settings: NumericSettings,
  explanationBudget: { used: number },
): StepTrace {
  const eps = settings.epsilon;
  const valid: SegmentHit[] = [];
  const candidates: HitCandidate[] = [];
  let truncated = false;
  let ambiguity: StepTrace["ambiguity"] = null;

  const record = (c: HitCandidate): void => {
    if (explanationBudget.used >= settings.maxExplanations) {
      truncated = true;
      return;
    }
    explanationBudget.used += 1;
    candidates.push(c);
  };

  for (const mirror of mirrors) {
    const seg = sub(mirror.b, mirror.a);
    const segLen = length(seg);
    if (segLen <= eps) {
      // 退化镜面在校验阶段已拒绝，此处兜底跳过。
      continue;
    }
    const w = sub(mirror.a, p);
    const denom = cross(d, seg);

    if (Math.abs(denom) <= eps) {
      if (Math.abs(cross(d, w)) <= eps * Math.max(1, segLen)) {
        record(candidate(mirror.id, null, "collinear", "射线与镜面共线（重合线），相交集合不唯一"));
        ambiguity = {
          kind: "collinear",
          detail: `镜面 ${mirror.id} 与射线共线，理想模型下相交不唯一`,
        };
      } else {
        record(candidate(mirror.id, null, "parallel_miss", "射线与镜面平行且不相交，跳过"));
      }
      continue;
    }

    const t = cross(w, seg) / denom;
    const s = cross(w, d) / denom;

    if (t < -eps) {
      record(candidate(mirror.id, t, "behind", "交点位于射线后方（t<0），排除"));
      continue;
    }
    if (s < -eps / segLen || s > 1 + eps / segLen) {
      record(
        candidate(mirror.id, t, "outside_segment", "交点仅在镜面线段的延长线上，不在线段范围内，排除"),
      );
      continue;
    }
    if (s <= eps / segLen || s >= 1 - eps / segLen) {
      record(candidate(mirror.id, t, "collinear", `命中镜面 ${mirror.id} 端点（s=${s.toFixed(6)}），几何歧义`));
      ambiguity = {
        kind: "endpoint",
        detail: `射线命中镜面 ${mirror.id} 的端点，角点归属不唯一`,
      };
      continue;
    }

    const normal = normalize(v(-seg.y, seg.x));
    valid.push({ mirrorId: mirror.id, t, s, point: add(p, scale(d, t)), normal });
    record(candidate(mirror.id, t, "farther", "线段范围内的正向交点，参与最近比较"));
  }

  if (!ambiguity && valid.length > 1) {
    valid.sort((a, b) => a.t - b.t);
    const first = valid[0]!;
    for (let i = 1; i < valid.length; i += 1) {
      const other = valid[i]!;
      if (Math.abs(other.t - first.t) <= eps) {
        ambiguity = {
          kind: "simultaneous",
          detail: `镜面 ${first.mirrorId} 与镜面 ${other.mirrorId} 在同一距离被同时命中，反射不唯一`,
        };
        break;
      }
    }
  }

  return { valid, candidates, candidatesTruncated: truncated, ambiguity };
}

/** 计算沿 d 正向离开矩形边界的最小 t 及命中边。 */
export function boundaryExit(
  p: Vec2,
  d: Vec2,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  eps: number,
): { t: number; point: Vec2; side: "left" | "right" | "bottom" | "top" } {
  const hits: Array<{ t: number; side: "left" | "right" | "bottom" | "top" }> = [];
  if (Math.abs(d.x) > eps) {
    const tLeft = (bounds.minX - p.x) / d.x;
    const tRight = (bounds.maxX - p.x) / d.x;
    if (tLeft > eps) hits.push({ t: tLeft, side: "left" });
    if (tRight > eps) hits.push({ t: tRight, side: "right" });
  }
  if (Math.abs(d.y) > eps) {
    const tBottom = (bounds.minY - p.y) / d.y;
    const tTop = (bounds.maxY - p.y) / d.y;
    if (tBottom > eps) hits.push({ t: tBottom, side: "bottom" });
    if (tTop > eps) hits.push({ t: tTop, side: "top" });
  }
  if (hits.length === 0) {
    throw geometryError("射线无法到达任何边界边（方向异常或起点位于边界外）");
  }
  hits.sort((a, b) => a.t - b.t);
  const hit = hits[0]!;
  return { t: hit.t, point: add(p, scale(d, hit.t)), side: hit.side };
}

/** 理想镜面反射：d' = d - 2(d·n)n。n 取任一侧结果相同。 */
export function reflect(d: Vec2, n: Vec2): Vec2 {
  const k = 2 * dot(d, n);
  return normalize(sub(d, scale(n, k)));
}

export interface RunOptions {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  mirrors: Mirror[];
  origin: Vec2;
  direction: Vec2;
  settings: NumericSettings;
  reflectionBudget: number;
}

/** 逐次追踪射线，直至离开、达到预算或遇到几何歧义。 */
export function runRay(opts: RunOptions): RunResult {
  const { bounds, mirrors, settings } = opts;
  const eps = settings.epsilon;
  let current = opts.origin;
  let dir = normalize(opts.direction);
  const initialDir = dir;

  const reflections: ReflectionEvent[] = [];
  const explanationBudget = { used: 0 };
  let cumulative = 0;
  let resultAmbiguity: RunResult["ambiguity"] = null;

  for (;;) {
    const trace = traceStep(current, dir, mirrors, settings, explanationBudget);
    const exit = boundaryExit(current, dir, bounds, eps);

    if (trace.ambiguity) {
      resultAmbiguity = { kind: trace.ambiguity.kind, detail: trace.ambiguity.detail };
      return {
        status: "geometric_ambiguity",
        origin: opts.origin,
        direction: initialDir,
        reflections,
        exit: null,
        budgetPoint: current,
        budgetDirection: dir,
        ambiguity: resultAmbiguity,
        settings,
      };
    }

    trace.valid.sort((a, b) => a.t - b.t);
    const nearest = trace.valid[0];

    // 没有比边界更近的镜面：走到边界离开。镜面完全位于内部，故 t 比较安全。
    if (!nearest || nearest.t >= exit.t - eps) {
      cumulative += exit.t;
      return {
        status: "exited",
        origin: opts.origin,
        direction: initialDir,
        reflections,
        exit: {
          point: exit.point,
          side: exit.side,
          segmentDistance: exit.t,
          cumulativeDistance: cumulative,
        },
        budgetPoint: null,
        budgetDirection: null,
        ambiguity: null,
        settings,
      };
    }

    // 预算检查：仍存在更近镜面但反射次数已用尽。
    if (reflections.length >= opts.reflectionBudget) {
      return {
        status: "budget_reached",
        origin: opts.origin,
        direction: initialDir,
        reflections,
        exit: null,
        budgetPoint: current,
        budgetDirection: dir,
        ambiguity: null,
        settings,
      };
    }

    const reflected = reflect(dir, nearest.normal);
    cumulative += nearest.t;
    const event: ReflectionEvent = {
      index: reflections.length + 1,
      mirrorId: nearest.mirrorId,
      point: nearest.point,
      normal: nearest.normal,
      incoming: dir,
      reflected,
      segmentDistance: nearest.t,
      cumulativeDistance: cumulative,
      angleOfIncidence: Math.acos(Math.min(1, Math.abs(dot(dir, nearest.normal)))),
      candidates: trace.candidates,
      candidatesTruncated: trace.candidatesTruncated,
    };
    // 标记被选中的候选（t 与 mirrorId 匹配）。
    for (const c of event.candidates) {
      if (c.mirrorId === nearest.mirrorId && c.t !== null && Math.abs(c.t - nearest.t) <= eps) {
        c.status = "nearest";
        c.reason = "最近有效交点，发生反射";
      }
    }
    reflections.push(event);

    // 沿反射方向推进极小距离，避免在同一点零距离再次碰撞；不使用大步长跨越真实镜面。
    current = add(nearest.point, scale(reflected, settings.rayOffset));
    cumulative += settings.rayOffset;
    dir = reflected;
  }
}

export function assertFinitePoint(p: Vec2, label: string, limit: number): void {
  if (
    typeof p.x !== "number" ||
    typeof p.y !== "number" ||
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y)
  ) {
    throw validationError(`${label} 必须为有限数值`, p);
  }
  if (Math.abs(p.x) > limit || Math.abs(p.y) > limit) {
    throw validationError(`${label} 超出受限坐标范围 ±${limit}`, p);
  }
}

export { AppError };
