import { ApiError, ERR } from "./errors.ts";
import { insideBoundary, len, pointSegmentDistance, sub } from "./geometry.ts";
import type { Boundary, Mirror, Scene, Settings, Vec2 } from "./types.ts";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function parseVec2(v: unknown, name: string): Vec2 {
  if (typeof v !== "object" || v === null) throw new ApiError(ERR.BAD_REQUEST, `${name} 必须是 {x,y} 对象`);
  const o = v as Record<string, unknown>;
  if (!isNum(o.x) || !isNum(o.y)) throw new ApiError(ERR.BAD_REQUEST, `${name}.x/y 必须是有限数字`);
  return { x: o.x, y: o.y };
}

function checkRange(p: Vec2, s: Settings, name: string): void {
  if (Math.abs(p.x) > s.coordLimit || Math.abs(p.y) > s.coordLimit) {
    throw new ApiError(ERR.RANGE_EXCEEDED, `${name} 超出坐标范围 ±${s.coordLimit}`);
  }
}

export function parseBoundary(v: unknown, s: Settings): Boundary {
  if (typeof v !== "object" || v === null) throw new ApiError(ERR.BAD_REQUEST, "boundary 必须是对象");
  const o = v as Record<string, unknown>;
  for (const k of ["minX", "minY", "maxX", "maxY"]) {
    if (!isNum(o[k])) throw new ApiError(ERR.BAD_REQUEST, `boundary.${k} 必须是有限数字`);
  }
  const b = v as Boundary;
  if (!(b.minX < b.maxX) || !(b.minY < b.maxY)) {
    throw new ApiError(ERR.INVALID_BOUNDARY, "边界必须满足 minX<maxX 且 minY<maxY");
  }
  checkRange({ x: b.minX, y: b.minY }, s, "boundary.min");
  checkRange({ x: b.maxX, y: b.maxY }, s, "boundary.max");
  return b;
}

export function parseMirrors(v: unknown, b: Boundary, s: Settings): Mirror[] {
  if (!Array.isArray(v)) throw new ApiError(ERR.BAD_REQUEST, "mirrors 必须是数组");
  if (v.length > s.maxMirrors) {
    throw new ApiError(ERR.TOO_MANY_MIRRORS, `镜面数量 ${v.length} 超过上限 ${s.maxMirrors}`);
  }
  const min = { x: b.minX, y: b.minY };
  const max = { x: b.maxX, y: b.maxY };
  return v.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new ApiError(ERR.BAD_REQUEST, `mirrors[${i}] 必须是对象`);
    const o = raw as Record<string, unknown>;
    const a = parseVec2(o.a, `mirrors[${i}].a`);
    const bb = parseVec2(o.b, `mirrors[${i}].b`);
    checkRange(a, s, `mirrors[${i}].a`);
    checkRange(bb, s, `mirrors[${i}].b`);
    if (len(sub(bb, a)) < s.eps) {
      throw new ApiError(ERR.DEGENERATE_MIRROR, `mirrors[${i}] 退化为点，已拒绝`);
    }
    if (!insideBoundary(a, min, max, 0) || !insideBoundary(bb, min, max, 0)) {
      throw new ApiError(ERR.MIRROR_OUTSIDE, `mirrors[${i}] 未完全位于边界内部`);
    }
    const id = isNum(o.id) ? o.id : i + 1;
    return { id, a, b: bb };
  });
}

export function parseScene(v: unknown, s: Settings): Scene {
  if (typeof v !== "object" || v === null) throw new ApiError(ERR.BAD_REQUEST, "场景必须是对象");
  const o = v as Record<string, unknown>;
  const boundary = parseBoundary(o.boundary, s);
  const mirrors = parseMirrors(o.mirrors ?? [], boundary, s);
  return { boundary, mirrors };
}

/** 校验发射点与方向（运行前检查） */
export function validateRay(origin: Vec2, dir: Vec2, scene: Scene, s: Settings): void {
  checkRange(origin, s, "origin");
  const b = scene.boundary;
  if (!insideBoundary(origin, { x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY }, s.eps)) {
    throw new ApiError(ERR.ORIGIN_OUTSIDE, "发射点必须严格位于边界内部");
  }
  if (len(dir) < s.eps) throw new ApiError(ERR.ZERO_DIRECTION, "方向向量必须非零");
  for (const m of scene.mirrors) {
    if (pointSegmentDistance(origin, m.a, m.b) < s.eps) {
      throw new ApiError(ERR.ORIGIN_ON_MIRROR, `发射点落在镜面 ${m.id} 上，已拒绝`);
    }
  }
}
