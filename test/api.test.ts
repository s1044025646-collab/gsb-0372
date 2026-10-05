import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import type { Server } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "mirror-api-"));
let server: Server;
let base: string;

before(async () => {
  const started = await startServer({ dbPath: join(dir, "test.db") });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

async function jsonRequest(path: string, init?: RequestInit & { body?: unknown }) {
  const res = await fetch(base + path, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json()) as any;
  return { status: res.status, body };
}

test("保存场景→运行→查询候选/路径/导出，全链路", async () => {
  const created = await jsonRequest("/scenes", {
    method: "POST",
    body: {
      name: "API 测试场景",
      mirrors: [{ a: { x: 1, y: 5 }, b: { x: 9, y: 5 } }],
    },
  });
  assert.equal(created.status, 201);
  const sceneId = created.body.id;

  const run = await jsonRequest(`/scenes/${sceneId}/runs`, {
    method: "POST",
    body: { origin: { x: 2, y: 7 }, direction: { x: 1, y: -1 } },
  });
  assert.equal(run.status, 201);
  assert.equal(run.body.status, "exited");
  assert.equal(run.body.reflections.length, 1);
  const runId = run.body.runId;

  const candidates = await jsonRequest(`/runs/${runId}/candidates?event=1`);
  assert.equal(candidates.status, 200);
  assert.ok(candidates.body.candidates.some((c: any) => c.status === "nearest"));

  const path = await jsonRequest(`/runs/${runId}/path`);
  assert.equal(path.body.points[0].kind, "origin");
  assert.ok(path.body.points.some((p: any) => p.kind === "reflection"));
  assert.ok(path.body.points.some((p: any) => p.kind === "exit"));

  const exported = await jsonRequest(`/runs/${runId}/export`);
  assert.equal(exported.body.format, "coordinates-v1");
  assert.equal(exported.body.scene.id, sceneId);
});

test("改镜面创建新版本，不覆盖旧版本", async () => {
  const v1 = await jsonRequest("/scenes", {
    method: "POST",
    body: { name: "v", mirrors: [{ a: { x: 1, y: 5 }, b: { x: 9, y: 5 } }] },
  });
  const v2 = await jsonRequest("/scenes", {
    method: "POST",
    body: {
      name: "v",
      parentId: v1.body.id,
      mirrors: [{ a: { x: 1, y: 2 }, b: { x: 9, y: 2 } }],
    },
  });
  assert.equal(v2.body.version, 2);
  assert.equal(v2.body.parentVersionId, v1.body.id);
  const old = await jsonRequest(`/scenes/${v1.body.id}`);
  assert.equal(old.body.mirrors[0].a.y, 5);
});

test("错误码：退化点镜 400、未知场景 404", async () => {
  const bad = await jsonRequest("/scenes", {
    method: "POST",
    body: { mirrors: [{ a: { x: 1, y: 1 }, b: { x: 1, y: 1 } }] },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "VALIDATION");

  const missing = await jsonRequest("/scenes/999999");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");
});

test("预算运行后可查询每次方向与路程", async () => {
  const created = await jsonRequest("/scenes", {
    method: "POST",
    body: {
      mirrors: [
        { a: { x: 1, y: 3 }, b: { x: 9, y: 3 } },
        { a: { x: 1, y: 7 }, b: { x: 9, y: 7 } },
      ],
    },
  });
  const run = await jsonRequest(`/scenes/${created.body.id}/runs`, {
    method: "POST",
    body: { origin: { x: 1.5, y: 4.5 }, direction: { x: 1, y: 1 }, maxReflections: 1 },
  });
  assert.equal(run.body.status, "budget_reached");
  const shown = await jsonRequest(`/runs/${run.body.runId}`);
  assert.equal(shown.body.reflections[0].cumulativeDistance > 0, true);
});
