export type ToolPresentation = {
  title: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

export const SERVER_ICONS = [
  {
    src: "https://vapinetwork.ai/branding/kit/logos/vapi-app-icon-light.png",
    mimeType: "image/png",
    sizes: ["1024x1024"],
    theme: "light",
  },
  {
    src: "https://vapinetwork.ai/branding/kit/logos/vapi-app-icon-dark.png",
    mimeType: "image/png",
    sizes: ["1024x1024"],
    theme: "dark",
  },
] as const;

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const destructive = { ...write, destructiveHint: true };
const search = { ...readOnly, openWorldHint: true };

export const TOOL_PRESENTATION: Readonly<Record<string, ToolPresentation>> = {
  "docs.search": { title: "Search the vAPI docs", annotations: readOnly },
  "docs.read": { title: "Read a vAPI docs page", annotations: readOnly },
  "auth.link": {
    title: "Link this account to the vAPI dashboard",
    annotations: { ...write, idempotentHint: true },
  },
  "auth.status": { title: "Check the dashboard link", annotations: readOnly },
  "router.models": { title: "List Router models", annotations: readOnly },
  "router.usage": { title: "Show Router usage", annotations: readOnly },
  "router.chat": { title: "Chat through the vAPI Router", annotations: destructive },
  "router.buy": { title: "Buy Router balance", annotations: destructive },
  "tasks.search": { title: "Browse tasks", annotations: readOnly },
  "tasks.show": { title: "Show a task", annotations: readOnly },
  "tasks.post": { title: "Post a task", annotations: write },
  "tasks.propose": { title: "Propose on a task", annotations: write },
  "tasks.submit": { title: "Submit a proposal", annotations: write },
  "tasks.award": { title: "Award a task", annotations: write },
  "tasks.sign": { title: "Sign a task step", annotations: destructive },
  "tasks.fund": { title: "Fund escrow", annotations: destructive },
  "tasks.deliver": { title: "Deliver work", annotations: write },
  "tasks.release": { title: "Release escrow", annotations: destructive },
  "tasks.refund": { title: "Refund escrow", annotations: destructive },
  "tasks.dispute": { title: "Open a dispute", annotations: destructive },
  "tasks.counter-evidence": { title: "Add counter-evidence", annotations: write },
  "tasks.resolve-unmatched": { title: "Resolve an unmatched escrow", annotations: destructive },
  "tasks.message": { title: "Message a task thread", annotations: write },
  "tasks.thread": { title: "Read a task thread", annotations: readOnly },
  "tasks.watch": { title: "Watch a task", annotations: readOnly },
  "tasks.status": { title: "Check a task's chain status", annotations: readOnly },
  "vapi.status": { title: "Show the vAPI status screen", annotations: readOnly },
  "vapi.accounts": { title: "List vAPI accounts", annotations: readOnly },
  "vapi.siblings": { title: "List sibling agents", annotations: readOnly },
  "accounts.add": { title: "Add a local account", annotations: write },
  "accounts.caps": { title: "Lower an account's spend caps", annotations: write },
  "accounts.send": { title: "Send USDC from an account", annotations: destructive },
  "call.search": { title: "Search the vAPI marketplace", annotations: search },
  search: { title: "Search the vAPI marketplace (deprecated)", annotations: search },
  "call.inspect": { title: "Inspect a Call listing", annotations: readOnly },
  inspect: { title: "Inspect a Call listing (deprecated)", annotations: readOnly },
  "call.pay": { title: "Pay an x402 API", annotations: destructive },
  call: { title: "Pay an x402 API (deprecated)", annotations: destructive },
  "call.read": { title: "Read a paid origin", annotations: readOnly },
  "wallet.address": { title: "Show the account address", annotations: readOnly },
  "wallet.balance": { title: "Show the account balance", annotations: readOnly },
  "wallet.accounts": { title: "Show the account's addresses", annotations: readOnly },
  "wallet.list": { title: "List local accounts", annotations: readOnly },
  "wallet.use": { title: "Switch the active account", annotations: write },
  "wallet.fund": { title: "Fund the account", annotations: destructive },
  wallet: { title: "Show the account balance (deprecated)", annotations: readOnly },
  "receipts.list": { title: "List payment receipts", annotations: readOnly },
  "receipts.stats": { title: "Show receipt statistics", annotations: readOnly },
  "support.report": { title: "Create a local support report", annotations: write },
  "swarm.setup": { title: "Set up a swarm", annotations: write },
  "swarm.add": { title: "Add a swarm member", annotations: write },
  "swarm.leave": { title: "Leave a swarm", annotations: write },
  "swarm.fund": { title: "Fund a swarm", annotations: destructive },
  "swarm.rebalance": { title: "Rebalance a swarm", annotations: destructive },
  "swarm.status": { title: "Show swarm status", annotations: readOnly },
  "swarm.dissolve": { title: "Dissolve a swarm", annotations: destructive },
  "swarm.run": { title: "Run a swarm", annotations: destructive },
  "swarm.allocate": { title: "Allocate swarm budget", annotations: destructive },
  "swarm.delegate": { title: "Delegate a swarm task", annotations: destructive },
  "swarm.runs": { title: "List swarm runs", annotations: readOnly },
  "swarm.stop": {
    title: "Stop swarm workers",
    annotations: destructive,
  },
};

export function withPresentation<T extends { name: string }>(tool: T): T & ToolPresentation {
  const presentation = Object.hasOwn(TOOL_PRESENTATION, tool.name)
    ? TOOL_PRESENTATION[tool.name]
    : undefined;
  if (!presentation) throw new Error(`no presentation for tool ${tool.name}`);
  return { ...tool, ...presentation };
}
