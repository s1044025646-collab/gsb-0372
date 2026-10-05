/** 二维向量 */
export interface Vec2 {
  x: number;
  y: number;
}

/** 矩形边界（轴对齐），min < max 严格成立 */
export interface Boundary {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 线段镜面（理想双面镜） */
export interface Mirror {
  id: number;
  a: Vec2;
  b: Vec2;
}

/** 场景定义（不可变，修改即新版本） */
export interface Scene {
  boundary: Boundary;
  mirrors: Mirror[];
}

/** 数值容差与限制设置 */
export interface Settings {
  /** 统一数值容差 */
  eps: number;
  /** 坐标绝对值上限 */
  coordLimit: number;
  /** 镜面数量上限 */
  maxMirrors: number;
  /** 反射次数上限（预算） */
  maxReflections: number;
  /** 单次运行记录的解释条数上限 */
  maxExplanations: number;
}

export const DEFAULT_SETTINGS: Settings = {
  eps: 1e-9,
  coordLimit: 1e6,
  maxMirrors: 256,
  maxReflections: 1000,
  maxExplanations: 10000,
};

/** 单个镜面候选交点的评估结果 */
export interface Candidate {
  mirrorId: number;
  /** 参数 t：hit = origin + t * dir（单位方向），即行进距离 */
  t: number;
  /** 线段参数 s ∈ [0,1] */
  s: number;
  hit: Vec2;
  normal: Vec2;
  status: "hit" | "excluded";
  /** 被排除时的原因 */
  reason?: string;
}

/** 一次反射事件 */
export interface ReflectionEvent {
  seq: number;
  origin: Vec2;
  mirrorId: number;
  hit: Vec2;
  normal: Vec2;
  dirIn: Vec2;
  dirOut: Vec2;
  /** 本段行进距离 */
  distance: number;
  /** 累计路程 */
  cumulative: number;
}

export type RunStatus =
  | "exited" // 射线离开边界
  | "budget_exhausted" // 反射预算用尽（不代表已离开场景）
  | "ambiguity"; // 几何歧义，按公开规则停止

/** 一次运行的完整结果 */
export interface RunResult {
  status: RunStatus;
  events: ReflectionEvent[];
  /** 离开边界时的出射点与方向（status=exited 时存在） */
  exit?: { point: Vec2; dir: Vec2; distance: number };
  totalDistance: number;
  /** 歧义说明（status=ambiguity 时存在） */
  ambiguity?: string;
  /** 每一步的候选评估（受 maxExplanations 截断） */
  explanations: StepExplanation[];
  explanationsTruncated: boolean;
}

export interface StepExplanation {
  seq: number;
  origin: Vec2;
  dir: Vec2;
  chosen: Candidate | null;
  candidates: Candidate[];
  boundaryT: number;
  note: string;
}
