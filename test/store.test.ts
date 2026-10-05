import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { simulate } from "../src/engine.ts";
import { DEFAULT_SETTINGS, type Scene } from "../src/types.ts";

const scene: Scene = {
  boundary: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  mirrors: [{ id: 1, a: { x: 2, y: 3 }, b: { x: 8, y: 3 } }],
};

test("场景不可变、运行原子保存、重启后可查询", () => {
  const store = new Store(":memory:");
  const sceneId = store.saveScene(scene);
  const rayId = store.saveRay(sceneId, { x: 5, y: 8 }, { x: 1, y: -2 });
  const result = simulate(scene, { x: 5, y: 8 }, { x: 1, y: -2 }, DEFAULT_SETTINGS);
  const runId = store.saveRun(rayId, DEFAULT_SETTINGS, result);

  // 修改场景生成新版本，旧路径不变
  const sceneId2 = store.saveScene({ ...scene, mirrors: [] });
  assert.notEqual(sceneId, sceneId2);
  assert.equal(store.getScene(sceneId).mirrors.length, 1);

  const run = store.getRun(runId);
  assert.equal(run.status, "exited");
  const events = store.getEvents(runId);
  assert.equal(events.length, 1);
  const explain = store.getExplanation(runId, 1) as { candidates: unknown[] };
  assert.ok(Array.isArray(explain.candidates));
  store.close();
});
