/** 二维点 / 向量。坐标口径：矩形边界为 [0, BOUND_MAX]×[0, BOUND_MAX] 的轴对齐正方形区域。 */
export interface Vec2 {
  x: number;
  y: number;
}

/** 平面镜线段，双面理想反射。id 为场景内稳定编号（从 0 开始）。 */
export interface Mirror {
  id: number;
  a: Vec2;
  b: Vec2;
}

/** 场景：矩形边界 + 固定镜面集合。边界仅用于截断轨迹，不参与反射。 */
export interface Scene {
  id: number;
  version: number;
  parentVersionId: number | null;
  name: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  mirrors: Mirror[];
  createdAt: string;
}

/** 统一数值设置。所有几何判定共用同一组容差，禁止逐处使用不同 epsilon。 */
export interface NumericSettings {
  /** 绝对浮点容差（坐标与叉积比较）。 */
  epsilon: number;
  /** 反射后沿方向推进的最小归一化距离，防止零距离重复碰撞；远小于真实间距。 */
  rayOffset: number;
  /** 最大允许镜面数量。 */
  maxMirrors: number;
  /** 单次运行最大反射次数（预算）。 */
  maxReflections: number;
  /** 单次运行保留的候选解释条数上限（超出截断，但计算继续）。 */
  maxExplanations: number;
  /** 坐标绝对值上限。 */
  coordLimit: number;
}

export const DEFAULT_SETTINGS: NumericSettings = {
  epsilon: 1e-9,
  rayOffset: 1e-7,
  maxMirrors: 64,
  maxReflections: 256,
  maxExplanations: 2048,
  coordLimit: 1e5,
};

export interface LaunchInput {
  origin: Vec2;
  /** 可为任意非零向量，内部统一归一化。 */
  direction: Vec2;
  maxReflections?: number;
}

/** 一次射线-镜面相交候选及其入选/排除解释。 */
export interface HitCandidate {
  mirrorId: number;
  /** 沿射线方向的正向参数 t（origin + t*d）。 */
  t: number | null;
  /** 候选状态。 */
  status: "nearest" | "farther" | "behind" | "parallel_miss" | "collinear" | "outside_segment";
  reason: string;
}

export interface ReflectionEvent {
  /** 第几次反射（从 1 开始）。 */
  index: number;
  mirrorId: number;
  point: Vec2;
  normal: Vec2;
  incoming: Vec2;
  reflected: Vec2;
  /** 本段行进距离（从上一事件点/起点到本点），恒为非负。 */
  segmentDistance: number;
  /** 累计路程。 */
  cumulativeDistance: number;
  /** 入射角/反射角（弧度，方向与法线夹角，[0, π/2]）。 */
  angleOfIncidence: number;
  candidates: HitCandidate[];
  candidatesTruncated: boolean;
}

export interface ExitEvent {
  point: Vec2;
  /** 从最后一个反射点到边界的行进距离。 */
  segmentDistance: number;
  cumulativeDistance: number;
  /** 命中的边界边。 */
  side: "left" | "right" | "bottom" | "top";
}

/**
 * 运行结果状态：
 * - exited：射线在预算内离开边界；
 * - budget_reached：达到反射次数上限，射线仍在场景内（不代表已离开）；
 * - geometric_ambiguity：命中端点 / 多镜同点 / 重合线，几何上不唯一，停止。
 */
export type RunStatus = "exited" | "budget_reached" | "geometric_ambiguity";

export interface RunResult {
  status: RunStatus;
  origin: Vec2;
  direction: Vec2;
  reflections: ReflectionEvent[];
  exit: ExitEvent | null;
  /** 预算用尽时射线所在点（最后反射点）与当前方向，供继续运行。 */
  budgetPoint: Vec2 | null;
  budgetDirection: Vec2 | null;
  ambiguity: { kind: string; detail: string } | null;
  settings: NumericSettings;
}
