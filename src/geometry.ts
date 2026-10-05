import type { Vec2 } from "./types.ts";

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  if (l === 0) throw new Error("ZERO_VECTOR");
  return { x: a.x / l, y: a.y / l };
}

/** 镜面单位法向（任选一侧；反射公式对 n 符号不变） */
export function mirrorNormal(a: Vec2, b: Vec2): Vec2 {
  const d = normalize(sub(b, a));
  return { x: -d.y, y: d.x };
}

/**
 * 理想镜面反射：d' = d - 2(d·n)n，d 与 n 均为单位向量。
 * 对 n 取反结果相同。返回重新规范化的单位向量。
 */
export function reflect(d: Vec2, n: Vec2): Vec2 {
  const k = 2 * dot(d, n);
  return normalize({ x: d.x - k * n.x, y: d.y - k * n.y });
}

export interface RaySegHit {
  t: number; // 射线参数（dir 为单位向量时即距离）
  s: number; // 线段参数 [0,1]
}

/**
 * 射线 p + t·d 与线段 a→b 求交。
 * 返回 null 表示平行（含共线，由调用方另行判定重合歧义）。
 */
export function raySegmentIntersect(
  p: Vec2,
  d: Vec2,
  a: Vec2,
  b: Vec2,
  eps: number,
): RaySegHit | null {
  const e = sub(b, a);
  const denom = cross(d, e);
  if (Math.abs(denom) < eps) return null; // 平行或共线
  const ap = sub(a, p);
  const t = cross(ap, e) / denom;
  const s = cross(ap, d) / denom;
  return { t, s };
}

/** 判断射线与线段是否共线（用于重合歧义检测） */
export function isCollinear(p: Vec2, d: Vec2, a: Vec2, b: Vec2, eps: number): boolean {
  const e = sub(b, a);
  if (Math.abs(cross(d, e)) >= eps) return false;
  return Math.abs(cross(sub(a, p), d)) < eps * Math.max(1, len(sub(a, p)));
}

/** 射线与轴对齐矩形边界的正向交点参数 t（起点严格在内部时唯一） */
export function rayBoundaryExit(p: Vec2, d: Vec2, min: Vec2, max: Vec2): number {
  let tExit = Infinity;
  const axes: Array<[number, number, number, number]> = [
    [p.x, d.x, min.x, max.x],
    [p.y, d.y, min.y, max.y],
  ];
  for (const [po, di, lo, hi] of axes) {
    if (Math.abs(di) < 1e-300) continue; // 与该轴平行，永不离开此方向
    const t1 = (lo - po) / di;
    const t2 = (hi - po) / di;
    tExit = Math.min(tExit, Math.max(t1, t2));
  }
  return tExit;
}

/** 点是否严格位于矩形内部（带容差） */
export function insideBoundary(p: Vec2, min: Vec2, max: Vec2, eps: number): boolean {
  return (
    p.x > min.x + eps && p.x < max.x - eps && p.y > min.y + eps && p.y < max.y - eps
  );
}

/** 点到线段的最近距离 */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const e = sub(b, a);
  const l2 = dot(e, e);
  if (l2 === 0) return len(sub(p, a));
  let s = dot(sub(p, a), e) / l2;
  s = Math.max(0, Math.min(1, s));
  return len(sub(p, add(a, scale(e, s))));
}
