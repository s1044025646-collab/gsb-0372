# 平面镜射线多次反射与最近交点解释后端

二维平面镜反射教学服务。场景为矩形边界 + 若干固定线段镜面（理想双面镜），给定严格位于边界内部的发射点与非零方向向量，计算射线逐次命中哪面镜子、反射到哪里，直至离开边界或达到反射次数预算。

只做 API 与 CLI，不做网页、透射、折射、透镜、波动干涉、颜色或光照渲染，不调用任何外部光学引擎。纯 TypeScript + Node.js + SQLite（`node:sqlite` 内置模块），Windows 本地运行，无需 Docker / WSL / 付费服务 / 在线 API。

## 运行要求

- Node.js >= 22.6（直接使用内置 TypeScript 类型擦除与 `node:sqlite`，无需编译步骤）
- 本项目在 Node 25 上开发与验证

## 命令

```powershell
npm install        # 仅安装开发依赖（typescript / @types/node，用于类型检查）
npm test           # 运行全部测试（node:test）
npm run typecheck  # tsc 类型检查（构建）
npm run demo       # 演示：水平镜/竖直镜/平行镜多次反射/延长线不命中
npm start          # 启动 API（默认自动选择空闲端口，PORT 环境变量可指定）
npm run cli -- ... # CLI 入口
```

CLI 示例：

```powershell
node src/cli.ts scene-create @examples/scene1.json
node src/cli.ts ray-create 1 5 8 1 -2
node src/cli.ts run 1            # 反射事件表
node src/cli.ts explain 1 1      # 第 1 步候选与排除理由
node src/cli.ts path 1           # 路径事件表
node src/cli.ts export 1         # 坐标 CSV
node src/cli.ts serve            # 启动 API，打印实际端口
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/scenes` | 保存场景（不可变，返回新版本 `sceneId`） |
| POST | `/scenes/validate` | 仅校验场景 |
| GET | `/scenes/:id` | 读取场景 |
| POST | `/rays` | 建立射线 `{sceneId, origin, direction}`（运行前校验） |
| POST | `/rays/:id/run` | 运行，可选 `{maxReflections}`，原子保存 |
| GET | `/runs/:id` | 运行概要（状态、总路程、容差设置） |
| GET | `/runs/:id/path` | 全部反射事件 |
| GET | `/runs/:id/explain/:seq` | 某步候选交点与被排除理由 |
| GET | `/runs/:id/export` | 坐标 CSV |

错误响应统一为 `{"error":{"code","message"}}`，错误码见 `src/errors.ts`（如 `ORIGIN_ON_MIRROR`、`DEGENERATE_MIRROR`、`MIRROR_OUTSIDE`、`ZERO_DIRECTION`、`RANGE_EXCEEDED`、`LIMIT_EXCEEDED`、`NOT_FOUND` 等）。

## 几何与数值口径

- 坐标系：右手笛卡尔平面，y 向上；不直接输出角度，方向一律以**单位向量**表示。
- 每步对全部镜面求正向射线交点 `p + t*d`（`d` 为单位向量，`t` 即行进距离），取 `t > eps` 且线段参数 `s` 在 `[-eps, 1+eps]` 内的**最近**交点；不以镜面中点距离代替交点远近，延长线相交（`s` 越界）不计入。
- 反射公式 `d' = d - 2(d*n)n`，`d`、`n` 均规范化；法向任选一侧结果相同（测试覆盖法向翻转不变性）。
- 边界只截断轨迹、不反射；无更近镜面时射线走到边界并报告 `exited`。
- 统一容差 `eps = 1e-9`，坐标范围 ±1e6，均记录在每次运行的 `settings_json` 中。
- 刚反射后的零距离自交通过 `t > eps` 排除（不做大跳步，不会跨过附近真实镜面）。
- 镜面须完全位于边界内部；退化为点的镜面、界外起点、镜面上的起点均在运行前拒绝。

## 歧义公开规则（不静默处理）

以下情况报告 `ambiguity` 并停止，绝不静默选择数组中的第一面镜子：

- 射线命中镜面端点（`s` 约等于 0 或 1）；
- 多面镜子在 `eps` 内同时命中；
- 射线与镜面共线（重合）。

平行且不相交的线段跳过（解释中记为 `parallel`）。

## 状态语义

- `exited`：射线离开边界（给出出射点与方向）；
- `budget_exhausted`：反射预算用尽，**不代表**射线已离开场景；
- `ambiguity`：几何歧义停止（附说明）。

## 持久化

SQLite 保存不可变场景版本、发射参数、数值设置与轨迹；修改镜面即创建新版本，旧路径永远引用旧坐标。一次运行在事务中原子写入，重启后仍可查询每次方向与路程。数据目录默认为项目内 `data/`（`MIRROR_DB` 环境变量可改）。

## 限制

- 镜面数 <= 256，反射预算 <= 1000，解释条数 <= 10000（可用 `settings.json` 或 `MIRROR_EPS` 等环境变量调整）；解释被截短时计算仍完成，`explanationsTruncated=true`。
- 理想化范围：仅几何光学直线传播 + 理想双面平面镜，不处理衍射、偏振、吸收、曲面镜与非轴对齐边界。
- 容差边界：间距小于 `eps` 的镜面配置会被判为歧义或同时命中，这是有意行为。
