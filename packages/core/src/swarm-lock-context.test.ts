import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

it("rejects nested acquisition of an undeclared swarm instead of growing the lock set", async () => {
  const home = await mkdtemp(join(tmpdir(), "vapi-lock-set-"));
  try {
    const { withSwarmLock } = await import("./swarm.js");
    const { withSwarmMovementLock } = await import("./swarm-lock-context.js");
    await expect(
      withSwarmLock(
        home,
        "alpha",
        async () => await withSwarmMovementLock(home, "beta", async () => undefined),
      ),
    ).rejects.toThrow(/pre-acquired|lock set/iu);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("rejects an undeclared nested account before attempting a second lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "vapi-account-lock-set-"));
  try {
    const { withAccountMovementLock } = await import("./account-movement-lock.js");
    await expect(
      withAccountMovementLock(
        home,
        "alpha",
        undefined,
        async () => await withAccountMovementLock(home, "beta", undefined, async () => undefined),
      ),
    ).rejects.toThrow(/pre-acquired|lock set/iu);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("shares held swarm locks across independent core copies in bundled packages", async () => {
  const home = await mkdtemp(join(tmpdir(), "vapi-core-copies-"));
  try {
    const first = await import("./swarm.js");
    // CLI and MCP tarballs bundle core independently. A fresh module graph
    // models that production boundary without relying on generated dist files.
    vi.resetModules();
    const second = await import("./swarm-lock-context.js");
    let entered = false;
    await first.withSwarmLock(home, "team", async () => {
      await second.withSwarmMovementLock(home, "team", async () => {
        entered = true;
      });
    });
    expect(entered).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
