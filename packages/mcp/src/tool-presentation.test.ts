import { readFile } from "node:fs/promises";

import { getDefaultConfig } from "@vapi-network/core";
import { describe, expect, it } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createVapiServer } from "./server.js";
import { SERVER_ICONS, TOOL_PRESENTATION, withPresentation } from "./tool-presentation.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;

const readOnlyTools = [
  "docs.search",
  "docs.read",
  "auth.status",
  "router.models",
  "router.usage",
  "tasks.search",
  "tasks.show",
  "tasks.thread",
  "tasks.status",
  "tasks.watch",
  "call.search",
  "call.inspect",
  "call.read",
  "search",
  "inspect",
  "vapi.status",
  "vapi.accounts",
  "vapi.siblings",
  "wallet.address",
  "wallet.balance",
  "wallet.accounts",
  "wallet.list",
  "wallet",
  "receipts.list",
  "receipts.stats",
  "swarm.status",
  "swarm.runs",
];
const destructiveTools = [
  "call.pay",
  "call",
  "router.chat",
  "router.buy",
  "accounts.send",
  "wallet.fund",
  "tasks.fund",
  "tasks.release",
  "tasks.refund",
  "tasks.dispute",
  "tasks.resolve-unmatched",
  "tasks.sign",
  "swarm.fund",
  "swarm.rebalance",
  "swarm.dissolve",
  "swarm.allocate",
  "swarm.delegate",
  "swarm.run",
  "swarm.stop",
];

const aliases = {
  search: "call.search",
  inspect: "call.inspect",
  call: "call.pay",
  wallet: "wallet.balance",
};

describe("MCP tool presentation", () => {
  it("covers exactly the registered tools", async () => {
    const server = createVapiServer({
      account: privateKeyToAccount(PRIVATE_KEY),
      config: getDefaultConfig(),
      fetchImpl: () => Promise.reject(new Error("The presentation test makes no network call.")),
    });
    try {
      const { tools } = await server.listTools();
      expect(Object.keys(TOOL_PRESENTATION).sort()).toEqual(tools.map((tool) => tool.name).sort());
    } finally {
      await server.close();
    }
  });

  it("uses short sentence titles with the vAPI spelling", () => {
    for (const { title } of Object.values(TOOL_PRESENTATION)) {
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(64);
      expect(title).not.toMatch(/\.$/);
      expect(title).not.toMatch(/\bVAPI\b|Vapi/);
    }
  });

  it("applies the read, write and money hint policy to every tool", () => {
    for (const [name, { annotations }] of Object.entries(TOOL_PRESENTATION)) {
      expect(annotations, name).toEqual({
        readOnlyHint: readOnlyTools.includes(name),
        destructiveHint: destructiveTools.includes(name),
        idempotentHint: readOnlyTools.includes(name) || name === "auth.link",
        openWorldHint: name === "call.search" || name === "search",
      });
    }
    expect(TOOL_PRESENTATION["wallet.use"]?.annotations.destructiveHint).toBe(false);
  });

  it("gives each deprecated alias its target's title and hints", () => {
    for (const [alias, target] of Object.entries(aliases)) {
      expect(TOOL_PRESENTATION[alias]?.title).toBe(
        `${TOOL_PRESENTATION[target]?.title} (deprecated)`,
      );
      expect(TOOL_PRESENTATION[alias]?.annotations).toEqual(TOOL_PRESENTATION[target]?.annotations);
    }
  });

  it("adds presentation while retaining the tool's other fields", () => {
    expect(withPresentation({ name: "call.search", description: "Original description" })).toEqual({
      name: "call.search",
      description: "Original description",
      ...TOOL_PRESENTATION["call.search"],
    });
  });

  it.each(["nope", "toString", "__proto__"])("rejects missing presentation for %s", (name) => {
    expect(() => withPresentation({ name })).toThrow(`no presentation for tool ${name}`);
  });

  it("keeps MCP Registry icons equal to the server identity icons", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../server.json", import.meta.url), "utf8"),
    ) as { icons: unknown };
    expect(manifest.icons).toEqual(SERVER_ICONS);
  });
});
