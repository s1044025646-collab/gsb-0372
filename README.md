# 二维平面镜射线多次反射教学后端

仅后端的二维理想平面镜反射教学服务：给定矩形边界、若干线段镜面、发射点与方向，逐步计算射线每次命中的镜面、入射点、法向、入射/反射方向、段距离与累计路程，直到射线离开边界或达到反射次数预算。

- 技术栈：TypeScript + Node.js（内置 `node:sqlite`，无需原生编译），仅提供 HTTP API 与 CLI。
- 运行环境：Windows 本地直接运行，**不依赖 Docker、WSL、付费服务或外部在线 API**。
- Node 版本：≥ 22.5（开发与验证使用 Node v25，内置 SQLite 直接可用）。

## 理想化范围

本服务只处理**理想双面平面镜**：

- 反射公式 `d' = d - 2(d·n)n`，其中 `d`、`n` 均规范化为单位向量；法向取镜子哪一侧结果相同。
- 不做透射、折射、透镜、波动、干涉、色散、颜色或光照渲染；不生成网页，不调用外部光学引擎。
- 矩形边界**只用于截断轨迹，不发生反射**；镜面必须完全位于边界内部。
- 每一步在**全部镜面**中求正向射线（`t ≥ 0`）与**线段本体**的交点，选择最近的有效交点；
  不使用“到镜面中点的距离”代替交点远近，不接受线段延长线上的相交。
- 平行且不相交的镜面跳过；**重合线、命中镜面端点、多面镜子同点同时命中**均按几何歧义报告并停止，
  不会静默选择数组中的第一面镜子。

## 坐标与角度口径

- 二维直角坐标系：`x` 向右，`y` 向上（数学正方向）。默认边界为 `[0,10]×[0,10]`。
- 发射点必须**严格位于边界内部**；方向为任意非零向量，内部统一归一化。
- 角度单位为**弧度**；入射角取入射方向与镜面法向的夹角，范围 `[0, π/2]`，与法向朝向无关。
- 距离/路程为欧氏长度；`segmentDistance` 为本段从上一事件点到本入射点的行进距离（恒为非负），
  `cumulativeDistance` 为累计路程。反射点之后会沿新方向推进一个极小偏移 `rayOffset`（计入累计路程），
  用于避免在同一交点上零距离重复碰撞；偏移远小于任何真实段长，不用大步长跨越附近镜面。

## 数值容差与限制

所有几何判定共用同一组设置（可随请求覆盖并随运行记录持久化）：

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `epsilon` | `1e-9` | 绝对浮点容差（叉积、平行、端点、t 比较） |
| `rayOffset` | `1e-7` | 反射后沿新方向的微推进（必须 > `epsilon`） |
| `maxMirrors` | `64` | 单场景镜面数量上限 |
| `maxReflections` | `256` | 单次运行反射次数预算上限 |
| `maxExplanations` | `2048` | 保留的相交候选解释条数上限 |
| `coordLimit` | `1e5` | 坐标绝对值上限 |

候选解释被截断时，计算仍会完成到允许的反射次数；结果中标记 `candidatesTruncated`。

结果状态严格区分：

- `exited`：射线在预算内从某条边界离开（报告离开点与所在边）；
- `budget_reached`：达到反射次数预算，**射线仍在场景内，不代表已离开**，同时返回当前点与方向；
- `geometric_ambiguity`：遇到端点 / 共线重合 / 多镜同点，理想模型下不唯一，停止并说明原因。

主要错误码：`VALIDATION`(400)、`NOT_FOUND`(404)、`GEOMETRY`(422)、`INTERNAL`(500)。

## 安装、构建、测试、启动、演示

```powershell
# 1. 安装依赖（仅 typescript 与类型声明）
npm install

# 2. 构建（输出到 dist/）
npm run build

# 3. 测试（几何不变量 + HTTP/持久化全链路）
npm test

# 4. 启动 HTTP 服务（默认自动选择空闲端口）
npm start                 # 自动空闲端口
npm start -- --port 8080  # 指定端口
# 也可用环境变量 PORT=8080 npm start

# 5. 演示（水平镜/竖直镜/平行多反射/延长线错过/预算不足，并写入演示库）
npm run demo
```

SQLite 数据库位于项目内 `data/` 目录（默认 `data/mirrors.db`，演示为 `data/demo.db`）。
CLI 可用 `MIRROR_DB` 环境变量指定其他数据库文件。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/scenes` | 保存场景（首个不可变版本） |
| GET | `/scenes` | 列出全部场景版本 |
| GET | `/scenes/:id` | 读取场景版本（边界、镜面） |
| GET | `/scenes/:id/validate` | 校验镜面与边界 |
| POST | `/scenes/:id/runs` | 建立发射参数并运行（原子保存） |
| GET | `/scenes/:id/runs` | 该场景版本下的运行列表 |
| GET | `/runs` | 全部运行 |
| GET | `/runs/:id` | 读取一次运行（含每次方向、法向、路程） |
| GET | `/runs/:id/candidates?event=n` | 某次反射的相交候选与排除理由 |
| GET | `/runs/:id/path` | 顺序路径点（origin/reflection/exit/budget） |
| GET | `/runs/:id/export` | 导出坐标（含坐标口径、场景、事件、路径） |

修改镜面时在 `POST /scenes` 中传 `parentId`，会创建 `version+1` 的**不可变新版本**；
旧运行始终绑定旧场景版本，不会在新坐标上被重新套用。

请求示例（PowerShell）：

```powershell
curl.exe -X POST http://127.0.0.1:<端口>/scenes -H "content-type: application/json" `
  -d '{\"name\":\"水平镜\",\"mirrors\":[{\"a\":{\"x\":1,\"y\":5},\"b\":{\"x\":9,\"y\":5}}]}'

curl.exe -X POST http://127.0.0.1:<端口>/scenes/1/runs -H "content-type: application/json" `
  -d '{\"origin\":{\"x\":2,\"y\":7},\"direction\":{\"x\":1,\"y\":-1},\"maxReflections\":20}'
```

## CLI

CLI 直接读写本地 SQLite，无需先启动服务器：

```powershell
npm run cli -- scene-list
npm run cli -- scene-create --mirrors '[{"a":{"x":1,"y":5},"b":{"x":9,"y":5}}]'
npm run cli -- run 1 --launch '{\"origin\":{\"x\":2,\"y\":7},\"direction\":{\"x\":1,\"y\":-1}}'
npm run cli -- run-show 1
npm run cli -- candidates 1 1     # 第 1 次反射的全部候选与排除理由
npm run cli -- export 1
```

`run` / `run-show` 以反射事件表展示：镜面编号、入射点、法向、段距离、累计路程、入射角。

## 持久化模型

- `scenes`：不可变场景版本（`version`、`parent_id`、边界、镜面 JSON、创建时间）。
- `runs`：一次运行的发射点、归一化方向、预算、数值设置、状态与歧义信息。
- `events`：每次反射的完整事件（入射点、法向、入射/反射方向、距离、角度、候选）。
- `candidates`：每面镜子每个候选的参数 `t`、状态（`nearest`/`farther`/`behind`/`parallel_miss`/`collinear`/`outside_segment`）与理由。
- `path_points`：顺序路径点。

一次运行在单个数据库事务内原子写入；重启后仍可查询每次方向与路程。

## 已知限制

- 仅二维、仅线段平面镜、仅理想镜面反射；不支持曲面镜、吸收/粗糙度与多次采样。
- 几何歧义（端点、共线、同点多镜）按教学约定直接报歧义停止，不做任意裁决。
- `rayOffset` 微偏移计入累计路程；需要严格零偏移的理论路程时可用 `segmentDistance` 自行求和。
