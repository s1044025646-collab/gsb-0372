import { executeRun } from "../src/sceneService.js";
import type { LaunchInput, Scene } from "../src/types.js";
import { DEFAULT_SETTINGS } from "../src/types.js";

export function dot(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return a.x * b.x + a.y * b.y;
}

export function executeRunHelpers(
  scene: Pick<Scene, "bounds" | "mirrors">,
  launch: LaunchInput,
): ReturnType<typeof executeRun> {
  return executeRun(scene, launch, DEFAULT_SETTINGS);
}
