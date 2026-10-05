import { validationError } from "./errors.js";
import {
  assertFinitePoint,
  boundaryExit,
  length,
  normalize,
  pointOnSegment,
  runRay,
  sub,
  v,
} from "./geometry.js";
import type {
  LaunchInput,
  Mirror,
  NumericSettings,
  RunResult,
  Scene,
  Vec2,
} from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

export interface BoundsInput {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MirrorInput {
  a: Vec2;
  b: Vec2;
}

export function validateBounds(bounds: BoundsInput, s: NumericSettings): BoundsInput {
  const keys: Array<keyof BoundsInput> = ["minX", "minY", "maxX", "maxY"];
  for (const key of keys) {
    if (typeof bounds[key] !== "number" || !Number.isFinite(bounds[key])) {
      throw validationError(`边界 ${key} 必须为有限数值`);
    }
    if (Math.abs(bounds[key]) > s.coordLimit) {
      throw validationError(`边界 ${key} 超出受限坐标范围 ±${s.coordLimit}`);
    }
  }
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) {
    throw validationError("边界必须为正面积矩形（maxX>minX 且 maxY>minY）");
  }
  return bounds;
}

/** 校验全部镜面：拒绝退化点镜、越界镜面；并分配稳定编号。 */
export function validateMirrors(inputs: MirrorInput[], s: NumericSettings): Mirror[] {
  if (!Array.isArray(inputs)) throw validationError("mirrors 必须为数组");
  if (inputs.length === 0) throw validationError("场景至少包含一面镜面");
  if (inputs.length > s.maxMirrors) {
    throw validationError(`镜面数量超过上限 ${s.maxMirrors}（收到 ${inputs.length}）`);
  }
  return inputs.map((m, id) => {
    if (!m?.a || !m?.b) throw validationError(`镜面 ${id} 必须包含端点 a 与 b`);
    assertFinitePoint(m.a, `镜面 ${id} 端点 a`, s.coordLimit);
    assertFinitePoint(m.b, `镜面 ${id} 端点 b`, s.coordLimit);
    const seg = sub(m.b, m.a);
    const segLen = length(seg);
    if (segLen <= s.epsilon) {
      throw validationError(`镜面 ${id} 退化为点（两端点距离 ${segLen} ≤ eps ${s.epsilon}），拒绝`);
    }
    return { id, a: m.a, b: m.b };
  });
}

/** 镜面必须完全位于矩形内部（含端点，不允许落在边界上）。 */
export function assertMirrorsInside(scene: Pick<Scene, "bounds" | "mirrors">, s: NumericSettings): void {
  const { bounds, mirrors } = scene;
  const margin = s.epsilon;
  for (const m of mirrors) {
    for (const p of [m.a, m.b]) {
      if (
        p.x <= bounds.minX + margin ||
        p.x >= bounds.maxX - margin ||
        p.y <= bounds.minY + margin ||
        p.y >= bounds.maxY - margin
      ) {
        throw validationError(`镜面 ${m.id} 的端点 (${p.x}, ${p.y}) 未严格位于边界内部`);
      }
    }
  }
}

/** 发射点必须严格位于边界内部。 */
export function assertOriginInside(
  origin: Vec2,
  bounds: BoundsInput,
  s: NumericSettings,
): void {
  assertFinitePoint(origin, "发射点", s.coordLimit);
  if (
    origin.x <= bounds.minX + s.epsilon ||
    origin.x >= bounds.maxX - s.epsilon ||
    origin.y <= bounds.minY + s.epsilon ||
    origin.y >= bounds.maxY - s.epsilon
  ) {
    throw validationError("发射点必须严格位于边界内部，不得落在边界上或边界外", { origin });
  }
}

/** 起点落在任何镜面上均在运行前拒绝（零距离碰撞无定义）。 */
export function assertOriginNotOnMirror(
  origin: Vec2,
  mirrors: Mirror[],
  s: NumericSettings,
): void {
  for (const m of mirrors) {
    if (pointOnSegment(origin, m, s.epsilon)) {
      throw validationError(`发射点位于镜面 ${m.id} 上，请调整起点后再运行`, {
        origin,
        mirrorId: m.id,
      });
    }
  }
}

export function validateSettings(input: Partial<NumericSettings> | undefined): NumericSettings {
  const s = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
  const positive: Array<keyof NumericSettings> = [
    "epsilon",
    "rayOffset",
    "maxMirrors",
    "maxReflections",
    "maxExplanations",
    "coordLimit",
  ];
  for (const key of positive) {
    const val = s[key];
    if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
      throw validationError(`数值设置 ${key} 必须为正数`, { [key]: val });
    }
  }
  if (s.rayOffset <= s.epsilon) {
    throw validationError("rayOffset 必须大于 epsilon，才能可靠避开零距离重复碰撞");
  }
 return s;
}

export function prepareLaunch(
  scene: Pick<Scene, "bounds" | "mirrors">,
  launch: LaunchInput,
  settings: NumericSettings,
): { origin: Vec2; direction: Vec2; budget: number } {
  if (!launch?.origin || !launch?.direction) {
    throw validationError("必须提供 origin 与非零 direction");
  }
  assertOriginInside(launch.origin, scene.bounds, settings);
  assertOriginNotOnMirror(launch.origin, scene.mirrors, settings);
  const direction = normalize(launch.direction);
  let budget = settings.maxReflections;
  if (launch.maxReflections !== undefined) {
    if (
      typeof launch.maxReflections !== "number" ||
      !Number.isInteger(launch.maxReflections) ||
      launch.maxReflections < 0
    ) {
      throw validationError("maxReflections 必须为非负整数");
    }
    budget = Math.min(launch.maxReflections, settings.maxReflections);
  }
  // 预校验沿初始方向确能到达边界（内部点必然可以，保留显式检查）。
  boundaryExit(launch.origin, direction, scene.bounds, settings.epsilon);
  return { origin: launch.origin, direction, budget };
}

export function executeRun(
  scene: Pick<Scene, "bounds" | "mirrors">,
  launch: LaunchInput,
  settings: NumericSettings,
): RunResult {
  const prepared = prepareLaunch(scene, launch, settings);
  return runRay({
    bounds: scene.bounds,
    mirrors: scene.mirrors,
    origin: prepared.origin,
    direction: prepared.direction,
    settings,
    reflectionBudget: prepared.budget,
  });
}

export { v };
