# MCP

MCP tools, aliases and server limits are covered here; see [README.md](../README.md).

## MCP

Add this to Claude Code, Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network@latest", "mcp"]
    }
  }
}
```

Set up the device vault in your own terminal. If it is password protected, open a session before starting MCP:

```bash
vapi setup
vapi vault unlock      # needed only for a password-protected vault
```

The device key stays in the local OS secret store. A password-protected vault needs `VAPI_VAULT_PASSWORD` in
the client entry or an open vault session. `vapi vault lock` closes that session.

Give an agent its own capped account by creating it yourself and pinning the
agent to it:

```bash
vapi accounts add agent-claude --label "claude code"
vapi accounts caps agent-claude --per-day 5
```

```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": ["-y", "vapi-network@latest", "mcp", "--account", "agent-claude"],
      "env": {
        "VAPI_WALLET": "agent-claude",
        "VAPI_NO_SECRETS": "1"
      }
    }
  }
}
```

The session starts on `agent-claude`, and calls that omit `wallet` use that
account's $5 daily cap. This is a default selection, not account isolation: MCP
tools can select any account in the same vault with `wallet.use` or an explicit
`wallet` argument. Use a separate `VAPI_HOME` containing only the capped account
when the agent must not access other local accounts.

### Interactive results in Claude Desktop

`call.search` and `call.inspect`, including their deprecated aliases, retain
interactive MCP Apps results in Claude Desktop. Tool titles and annotations,
server identity and icons, and the `ui://vapi/call-search.html` and
`ui://vapi/call-inspect.html` resources describe the presentation. Successful
structured results include `_view` with a creation time and sequence number
alongside their `hints` and registry metadata. If the hosted views cannot load,
the tools still return text. See [interactive results](../packages/mcp/README.md#interactive-results-in-claude-desktop).

### Tools

The `tasks.*` tools require a preview server with Tasks enabled. Tasks is coming soon on production.

| Tool                      | Input                                                                                                                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs.search`             | `query`                                                                                                                                                                 | Public vAPI documentation matches with `title`, `url` and `excerpt`; read-only, no wallet or payment                                                                                                                                                                                                                                                                  |
| `docs.read`               | `url` (a docs URL or path)                                                                                                                                              | One public vAPI documentation page as `url` and `markdown`; read-only, no wallet or payment                                                                                                                                                                                                                                                                           |
| `vapi.status`             | -                                                                                                                                                                       | The status screen as one object: `version`, `home`, `registry`, `owner`, `vault`, `accounts[]`, `unfinishedMovements[]`, `next[]`                                                                                                                                                                                                                                     |
| `vapi.accounts`           | -                                                                                                                                                                       | `accounts[]` with address, USDC, Router usage, caps and link status                                                                                                                                                                                                                                                                                                   |
| `vapi.siblings`           | `account`                                                                                                                                                               | `owner`, `siblings[]` with name, address, device, status, allowance, `self`, `onThisDevice`, and an optional `note`                                                                                                                                                                                                                                                   |
| `accounts.add`            | `name`, `caps`, `routerAllowanceUsd`, `link`                                                                                                                            | Creates a derived account with local caps and returns trusted-device or owner-approval link status                                                                                                                                                                                                                                                                    |
| `accounts.caps`           | `name`, `perCallUsd`, `perDayUsd`, `ceilingUsd`                                                                                                                         | Lowers local spend caps or the ceiling; the result's `caps` includes `ceilingUsd`                                                                                                                                                                                                                                                                                     |
| `accounts.send`           | `from`, `to`, `amountUsd`, `network`                                                                                                                                    | `status`, `from`, `to`, `toName`, `toKind`, `amountUsd`, `amountAtomic`, `network`, `txHash`, `nonce`, `replayed`, `message`                                                                                                                                                                                                                                          |
| `auth.link`               | `label`, `account`                                                                                                                                                      | Starts linking this account to a person's vAPI account for browser approval with default permissions only; returns the code and URL                                                                                                                                                                                                                                   |
| `auth.status`             | `wallet`                                                                                                                                                                | Link status, owner, label, permissions, Router-key presence, and any pending browser approval                                                                                                                                                                                                                                                                         |
| `router.models`           | -                                                                                                                                                                       | Model ids available from vAPI Router                                                                                                                                                                                                                                                                                                                                  |
| `router.usage`            | `wallet`                                                                                                                                                                | Router usage plus the linked owner's stake and stake-funded Compute                                                                                                                                                                                                                                                                                                   |
| `router.chat`             | `model`, `messages[]`, `max_tokens`, `wallet`                                                                                                                           | Completion `content`, resolved `model`, and token `usage`; the Router key stays in the OS secret store and is never returned                                                                                                                                                                                                                                          |
| `router.buy`              | `usd` (`1`, `5`, `20`, or `50`), `wallet`                                                                                                                               | Receipt summary and the new vAPI Router balance; the Router key stays in the OS secret store and is never returned                                                                                                                                                                                                                                                    |
| `call.search`             | `query`, `kinds[]`, `network`, `limit`, `cursor`, `includeUnverified`, `includeOutage`                                                                                  | One discovery page with health, alternatives and `hints`, plus `nextCursor`, `unavailableKinds`, `rankingVersion`                                                                                                                                                                                                                                                     |
| `call.inspect`            | `id`, `endpoint`                                                                                                                                                        | Verification, health, `requestSchema`, `responseSchema`, `exampleRequest`, the registry's last observed quote and `hints`                                                                                                                                                                                                                                             |
| `call.pay`                | `wallet`, `id` or `url`, `method`, `endpoint`, `body`, `contentType`, `network`, `expectedPayTo`, `maxPriceUsd`, `timeoutSeconds`                                       | `wallet`, `status`, `body`, `payment`, optional `verification` and `expectedRequest`, and `hints`                                                                                                                                                                                                                                                                     |
| `call.read`               | `url`                                                                                                                                                                   | Agent-run-only GET result: `status`, `contentType`, `body`; restricted to paid HTTPS origins, never pays, and redacts its SIWX proof                                                                                                                                                                                                                                  |
| `tasks.search`            | `open`, `minUsd`, `tab` (`trending`, `new`, `closing`, `paid`), `limit`                                                                                                 | Public board `cards` and `pinned`, filtered by open state and minimum USD; does not move money                                                                                                                                                                                                                                                                        |
| `tasks.show`              | `id`, `wallet`                                                                                                                                                          | Signed-in task order with `receipts`, or public `task` card with any `receiptUrl`; does not move money                                                                                                                                                                                                                                                                |
| `tasks.post`              | `wallet`, `title`, `brief`, `amountUsd`, `deadline`, `intake`, `maxAwards`, `webhookUrl`, `vendor` (optional 0x address; invites that wallet; anyone may still propose) | Stores the task and market settings, configures the optional webhook, and does not move money                                                                                                                                                                                                                                                                         |
| `tasks.propose`           | `id`, `wallet`, `priceUsd`, `duration`, `note`                                                                                                                          | Stored `proposal` with locally signed task terms; does not move money                                                                                                                                                                                                                                                                                                 |
| `tasks.submit`            | `id`, `wallet`, `proofUrls[]`, `files[]`                                                                                                                                | Locally signed bounty submission with HTTPS proof and optional uploaded file proofs; does not move money                                                                                                                                                                                                                                                              |
| `tasks.award`             | `id`, `wallet`, `proposalId`                                                                                                                                            | Updated `workOrder` after the poster accepts a proposal; does not move money                                                                                                                                                                                                                                                                                          |
| `tasks.sign`              | `id`, `wallet`, `counterparty` (required address), `wait` (default `true`)                                                                                              | Signs the user's own task scope locally with the user's vault wallet after the human confirms the money direction via `counterparty`; nothing is custodial. Returns verified `terms.counterparty`, accepted scope and milestone with `escrowCreation` when the worker creates an unfunded escrow; waits up to 60 seconds for indexing by default; does not move money |
| `tasks.fund`              | `id`, `wallet`, `counterparty` (optional address), `wait` (default `true`)                                                                                              | Executes the user's own task funding from the user's vault wallet within their spend policy; nothing is custodial. Returns `ok`, `money`, `policySource`, `policyDecision`, and chain `result`; waits up to 60 seconds for indexing by default; above-threshold amounts are refused with `approval:true`; moves money: locks USDC in escrow                           |
| `tasks.deliver`           | `id`, `wallet`, `files[]` (1 to 20 local files), `note`, `counterparty` (optional address), `wait` (default `true`)                                                     | Uploads local delivery files, freezes the manifest and records delivery with the local vault wallet. Returns `ok`, `manifestHash`, `result`; waits up to 60 seconds for indexing by default; does not move money                                                                                                                                                      |
| `tasks.release`           | `id`, `wallet`, `counterparty` (optional address), `wait` (default `true`)                                                                                              | Executes the user's own payment to the worker from escrow with the user's vault wallet; nothing is custodial. Returns `money` as gross · fee · net using the deployed fee and chain `result`; waits up to 60 seconds for indexing by default; moves money                                                                                                             |
| `tasks.refund`            | `id`, `wallet`, `counterparty` (optional address)                                                                                                                       | Executes the user's own refund of escrowed USDC to the poster with the user's vault wallet; nothing is custodial. Returns `money` as gross · fee · net using the deployed fee and chain `result`; moves money                                                                                                                                                         |
| `tasks.dispute`           | `id`, `wallet`, `evidenceHash` (`0x` plus 64 hex characters), `counterparty` (optional address)                                                                         | Executes the user's own verified dispute-fee approval and dispute with the user's vault wallet; nothing is custodial. Applies task and daily caps, refuses human approval with `approval:true`, and accepts a precomputed evidence hash. Returns `ok`, `money`, `disputeFee`, policy result and chain `result`; moves money                                           |
| `tasks.counter-evidence`  | `id`, `wallet`, `evidenceHash` (`0x` plus 64 hex characters), `counterparty` (optional address)                                                                         | Executes the user's own counter-evidence submission and verified dispute-fee approval with the user's vault wallet as the non-opener before the onchain deadline; nothing is custodial. Applies task and daily caps; MCP refuses human approval with `approval:true`. Returns `ok`, `money`, `disputeFee`, policy result and chain `result`; moves money              |
| `tasks.resolve-unmatched` | `id`, `wallet`, `counterparty` (optional address)                                                                                                                       | Executes the user's own dispute resolution with the user's vault wallet after the onchain counter-evidence deadline when no counter-evidence was submitted; nothing is custodial. Returns `money` and chain `result`; moves money                                                                                                                                     |
| `tasks.message`           | `id`, `wallet`, `text`                                                                                                                                                  | Stored task thread message; does not move money                                                                                                                                                                                                                                                                                                                       |
| `tasks.thread`            | `id`, `wallet`, `after` (previous `nextBeforeSeq`)                                                                                                                      | `messages[]` and `page.nextBeforeSeq` for older messages; does not move money                                                                                                                                                                                                                                                                                         |
| `tasks.watch`             | `id`, `wallet`, `after` (default `0`), `until`, `waitSeconds` (0 to 25, default `25`)                                                                                   | New `events`, `nextCursor`, `timedOut`, and `reached` when the requested state appears; never releases escrow; does not move money                                                                                                                                                                                                                                    |
| `tasks.status`            | `id`, `wallet`                                                                                                                                                          | Signed-in chain state and participant events, or the public `task` card without sign-in; does not move money                                                                                                                                                                                                                                                          |
| `wallet.address`          | `wallet`                                                                                                                                                                | `wallet`, `address`                                                                                                                                                                                                                                                                                                                                                   |
| `wallet.balance`          | `wallet`                                                                                                                                                                | `wallet`, `address`, `balances[]` per configured network                                                                                                                                                                                                                                                                                                              |
| `wallet.accounts`         | `wallet`                                                                                                                                                                | `wallet`, `accounts[]` with USDC, gas balance and deposit guidance                                                                                                                                                                                                                                                                                                    |
| `wallet.list`             | -                                                                                                                                                                       | `wallet`, `default`, and every account with caps in atomic USDC and dollars, balances, and `balanceError` when an RPC is unreachable                                                                                                                                                                                                                                  |
| `wallet.use`              | `name`                                                                                                                                                                  | `wallet`, `active`, `previous`, `scope: "session"`                                                                                                                                                                                                                                                                                                                    |
| `wallet.fund`             | `wallet`, `amountUsd`                                                                                                                                                   | `wallet`, `address`, `network`, `url`, `instructions`                                                                                                                                                                                                                                                                                                                 |
| `receipts.list`           | `wallet`, `allWallets`, `limit`                                                                                                                                         | `wallet`, `receipts[]`                                                                                                                                                                                                                                                                                                                                                |
| `receipts.stats`          | `wallet`, `allWallets`, `range`                                                                                                                                         | `wallet`, `range`, `generatedAt`, `totals`, `outcomes`, `latency`, `topServices`, `search`                                                                                                                                                                                                                                                                            |
| `support.report`          | `message`, `includeAddresses`, `send`                                                                                                                                   | `path`, `issueUrl`, the report itself, and `responseCode` when sent                                                                                                                                                                                                                                                                                                   |
| `swarm.setup`             | `name`, `agents`, `roles`, `strategy`, `targetsUsd`, `caps`, `treasuryCaps`, `network`, `model`, `fundUsd`, `from`                                                      | Creates or resumes a local swarm; returns `swarm`, `members`, owner approval steps in `next`, optional `fund`, and `message`                                                                                                                                                                                                                                          |
| `swarm.add`               | `name`, `role`, `targetUsd`, `weight`                                                                                                                                   | Adds or resumes a member; returns swarm setup status and next steps                                                                                                                                                                                                                                                                                                   |
| `swarm.leave`             | `name`, `member`                                                                                                                                                        | Sweeps a member to the treasury and removes membership; returns `status`, `member`, optional `movement`, and `message`                                                                                                                                                                                                                                                |
| `swarm.fund`              | `name`, `amountUsd`, `from`                                                                                                                                             | Funds from a linked local account, or returns owner funding instructions when `from` is omitted                                                                                                                                                                                                                                                                       |
| `swarm.rebalance`         | `name`, `targetsUsd`                                                                                                                                                    | Rebalances under local caps; returns `status`, optional `movement`, `blocked`, `skipped`, and `message`                                                                                                                                                                                                                                                               |
| `swarm.status`            | `name`                                                                                                                                                                  | Treasury and member balances, links, allocation totals and `openMovements`; moves no funds                                                                                                                                                                                                                                                                            |
| `swarm.dissolve`          | `name`                                                                                                                                                                  | Sweeps members to the treasury and the treasury to the owner; returns `status`, `movements`, and `message`                                                                                                                                                                                                                                                            |
| `swarm.run`               | `name`, `task`, `mode` (`lead` or `each`), `lead`, `budgetUsd`, `drawUsd`, `detach`                                                                                     | Attached result, or `detached: true`, `runId`, `mode`, `kind`, `runs[]`, `skipped[]`                                                                                                                                                                                                                                                                                  |
| `swarm.allocate`          | `amountUsd`, `reason`, `requestId?`                                                                                                                                     | Agent-only; direct MCP calls return an error and move no funds                                                                                                                                                                                                                                                                                                        |
| `swarm.delegate`          | `member`, `task`, `budgetUsd`, `requestId?`                                                                                                                             | Agent-only; direct MCP calls return an error and start no member run                                                                                                                                                                                                                                                                                                  |
| `swarm.runs`              | `name`                                                                                                                                                                  | `swarm` and `runs[]` with member, role, run id, runtime, mode, state and timestamps                                                                                                                                                                                                                                                                                   |

`wallet` is optional on every tool that takes it: without it the session's
active account is used, then `VAPI_WALLET`, then the machine default.
`call.pay` names the account it used, applies that account's own spend
caps before it signs and tags the receipt with its name. When a paid call's outcome
is uncertain, `call.pay` fails with `settlement_unknown`, says not to retry
automatically, and names the `vapi pay --resume <receipt-id>` that settles the
question on-chain. `wallet.use` moves the
session onto another account **for this process only**, and it never rewrites
`wallets.json`, so your own terminal keeps the default account you chose, and
appends a `wallet.use.session` line to the audit log. Reads need no passphrase at all.

Participant task tools need the acting wallet linked through `auth.link`. Public search and status need no sign-in; show uses the public card when no bearer exists. Task IDs are UUIDs. USD inputs are decimal strings with up to six places; `brief` and `note` are text, and file inputs name local regular files. Proof URLs and webhooks require HTTPS.

MCP has no interactive owner. Funding and dispute fees above the agent profile's `approveAboveUsd` returns `ok:false` with `approval:true` and does nothing. Approve in the CLI instead:

```sh
vapi task fund <id>
```

Per-task and per-day policy refusals return `ok:false` with `reason` set to `policy.perTask` or `policy.perDay` without touching the spend ledger. Money is shown as gross · fee · net using the deployed fee; an unreadable fee is reported as unavailable.

Fund, deliver, release, refund, dispute, counter-evidence and resolve-unmatched sign with the selected local vault wallet. Base Sepolia reads `BASE_SEPOLIA_RPC_URL`, defaults to `https://sepolia.base.org`, and trusts escrow factory `0x6Ba83621eb386B3E093032096251cA504F6ee033`. Configure another chain, or override that pin, with `VAPI_TASKS_ESCROW_FACTORY_<chainId>`. Chains without a trusted factory are rejected before signing.

Before signing a chain action, the client uses the trusted RPC to verify the factory payment token, the token's EIP-712 name and version, factory membership for each clone, and the clone's buyer, seller, token, amount, terms hash, state and deadline. It recomputes the accepted scope hash and verifies both party signatures. Server confirmation requires a successful RPC receipt and a valid confirmation envelope.

For `tasks.sign`, the human gets the required `counterparty` address from `tasks.show`: use the poster's `clientAddress` when signing as the worker, or the accepted proposal's `providerAddress` when signing as the poster. The address confirms the money direction. If it is missing, the tool returns `counterparty_required` without signing or creating a local binding, so fund, deliver and release cannot run.

Local scope signing derives the acting role from those order addresses rather than a server role label, verifies the other party's existing signature, and stores a durable party binding under the local tasks directory before submitting the signature. Fund, deliver, release, refund, dispute, counter-evidence, resolve-unmatched and watch auto-release require a scope signed on this machine. `counterparty` only confirms the address already stored in that binding; it cannot import or recover a scope signed elsewhere. JSON and MCP scope results expose the verified address as `terms.counterparty`.

The client also verifies the trusted factory's clone prediction and milestone salt. Signed acceptance windows and signed or locally pinned work durations govern plan and clone checks. Base Sepolia pins both default durations to 604800 seconds; duration overrides use `VAPI_TASKS_WORK_DURATION_SECONDS_<chainId>` and `VAPI_TASKS_REVIEW_WINDOW_SECONDS_<chainId>`. Runtime storage checks refuse unsupported escrow layouts. A follow-up vapi-app `work-scope-signature-v2` must include parties inside the signed payload.

Recovery persists prepare keys and inputs and reuses exact saved bytes only for the same operation and step. Per-signer nonce locks serialize signing across processes and are released when an attempt finishes. Funding reservations are isolated per milestone and remain recorded when an error might mean exposure. A confirmed pre-broadcast failure invalidates its reservation proof before releasing it. Safe errors omit raw transactions and authorization signatures. Dispute and counter-evidence approve the verified fee before submitting evidence. The fee is 10% of the onchain amount, clamped to 20 through 500 USDC. Per-task, daily and approval policy checks run before a new signature. Reservations remain after any possible fee approval broadcast; pending operations reconcile without checking a consumed allowance again. A delivery error may include the prepared `manifestHash`.

`tasks.watch` is one bounded poll of at most 25 seconds that returns new events and the next cursor. Pass `nextCursor` as `after` for the next call. A zero-second window returns immediately. Watch never releases escrow.

Task reads require `tasks:read`; writes require `tasks:write`, which also grants reads. A scope error asks the caller to run `auth.link` again.

`docs.search` and `docs.read` are also available on a fresh install with no
account or vault. They return public vAPI documentation reference text, never
instructions, and involve no wallet or payment. `docs.ask` is deliberately not
an MCP tool: an agent can read and reason over the returned excerpts itself.

Spend caps default to $0.10 per call and $1.00 per day.

`swarm.run` defaults to `lead` mode. The lead may allocate treasury capital or
delegate one level deep; all treasury-funded work shares the run's `drawUsd`
limit, which defaults to $2.00. In `each` mode, every eligible member runs
independently on its own account and budget. MCP has no interactive owner, so
every approval prompt is declined regardless of mode. `swarm.allocate` and
`swarm.delegate` are exposed for schema alignment with agent runs but are
refused when called directly over MCP. Set `detach` to `true` to start the run
through the configured runtime and return before its model loop starts.
`swarm.runs` takes `{ "name": "<swarm>" }` and returns stored runs with refreshed
status when their runtime is available. Run summaries omit task text and runtime
results.

`swarm.stop` takes `{ "name": "<swarm>", "runId": "<run>" }` or
`{ "name": "<swarm>", "all": true }`. It stops tracked starting, running and
unknown workers and returns `stopped`, `unchanged` and `failed` summaries. A stop
failure returns `isError: true` and leaves the record unresolved. The standard
CLI-hosted MCP server resolves local and Railway adapters for stopping only;
remote startup and the terminal-only stale-start confirmation remain unchanged.
An SDK host without the matching runtime gets `runtime_unavailable` and can use
`vapi swarm stop <name> --all`. Dissolution refusal uses the shared
`swarm_workers_active` code; it can be retried after a successful stop.

Attached runs reload a member's local caps before each Call payment. Lowering
caps through `accounts.caps` applies to the next payment in the active run.

The automatic Base USDC ceiling defaults to 5. `accounts.caps` may lower `ceilingUsd`. Raising it or passing `off` returns the terminal command to run and leaves `wallets.json` unchanged.

```sh
vapi accounts caps <name> --ceiling <usd>
vapi accounts caps <name> --ceiling off
```

`accounts.send` moves USDC only to the owner or one of the owner's active accounts. It always applies the sending account's caps before signing, and vAPI pays the gas. An unknown result keeps the spend reserved and names the terminal command that continues the same authorization.

`call.search` returns vAPI-verified listings plus mirrored external catalogs;
`includeUnverified: true` adds unverified self-listed APIs, which passed vAPI's
automated x402 probe but were not reviewed. Registry results from `call.search` and `call.inspect`, plus `call.pay` results
resolved from a listing, carry `verification`: `"none"`, `"requested"` or
`"verified"`. A mirrored external row is always `"none"`; payments to an explicit
URL may omit verification.
Prefer a verified listing, and read the request contract and the price with
`call.inspect` before paying one that is not.

The hosted registry hides listings whose health state is `outage` unless
`call.search` receives `includeOutage: true`. Health contains `state`
(`healthy`, `degraded`, `outage` or `unknown`), `uptime7d`, `latencyP50Ms`,
`latencyP95Ms` and `checks7d`. Alternatives contain `ref` and `reason`, either
`cheaper` or `healthier`. Results from `call.search`, `call.inspect` and
`call.pay` contain a `hints` string array with zero to four suggested next actions.

A spend-cap block from `call.pay` returns `isError: true`. Its text content is
JSON with `error` containing the message, `code: "spend_cap_exceeded"`, `cap`,
`amountUsd`, `limitUsd`, optional `spentUsd` and `wallet`, `command`, and
`retryable: false`. Amounts are decimal USD strings. Do not retry the payment
without changing the blocking limit. For account caps, `command` is the terminal command to run.
For maximum price and run-budget caps, it is the `--max` or `--budget` flag to
apply to the relevant command. The internal maximum-amount cap returns null.

### MCP registry

The root `server.json` describes the local vAPI Network server from the
`vapi-network` npm distribution, run as `npx -y vapi-network@<version> mcp`.
A fresh home needs no vault for initialization or the documentation tools.
Account and payment tools require terminal setup first; an existing protected
vault must be unlocked or supplied with `VAPI_VAULT_PASSWORD` before startup.

Keep `server.json`'s version and its npm package version aligned with every
package release. The source and staged `vapi-network/package.json` must retain
`mcpName` equal to `server.json`'s name. `pnpm pack:check` checks these values.
Published npm versions cannot gain this marker retroactively; verify it on the version being submitted.

After merging and publishing the staged npm packages through the normal release
process, a GitHub organization Owner runs these commands from the repo root:

```sh
mcp-publisher validate server.json
mcp-publisher login github
mcp-publisher publish server.json
```

The [official registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
and [authentication guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx)
cover package verification and organization access. The metadata lists the local stdio server. Hosted MCP is a separate production service.

### Install into a client

Use this command to register vAPI with a client:

```text
vapi mcp install <claude-code|claude-desktop|cursor|codex> [--home <dir>] [--registry <url>] [--no-link] [--json]
```

`--home` sets the vAPI home written into the entry's `VAPI_HOME`; it defaults
to `~/.vapi` and does not change the client configuration path. `--registry`
sets the registry URL written into `VAPI_REGISTRY_URL`.

For Claude Code, run:

```bash
vapi mcp install claude-code
```

Install Claude Code first so its `claude` command is on PATH. This runs
`claude mcp add --scope user` to register the same vAPI server entry for your
user account. Start a new Claude Code session, then ask: "Search vAPI for a
weather API."

For Claude Desktop, run:

```bash
vapi mcp install claude-desktop
```

On macOS, this writes `~/Library/Application Support/Claude/claude_desktop_config.json`.
On Windows, it writes `%APPDATA%\Claude\claude_desktop_config.json`. On Linux,
it writes `~/.config/Claude/claude_desktop_config.json`. The next step is:
Restart Claude Desktop, then ask it: "Search vAPI for a weather API."
The `claude` target remains an alias for `claude-desktop` and prints a note
naming `claude-code`.

For Cursor, run:

```bash
vapi mcp install cursor
```

This writes `./.cursor/mcp.json` in the current directory. The next step is:
Reload Cursor, then ask its agent: "Search vAPI for a weather API."

For Codex, run:

```bash
vapi mcp install codex
```

This writes `~/.codex/config.toml`. The next step is: Start codex in a new
terminal, then ask: "Search vAPI for a weather API."

With `--home /tmp/vapi-docs-home`, the Claude Desktop entry contains this
JSON. The entry's `VAPI_HOME` is the value passed to `--home`.

<!-- prettier-ignore -->
```json
{
  "mcpServers": {
    "vapi": {
      "command": "npx",
      "args": [
        "-y",
        "vapi-network@latest",
        "mcp"
      ],
      "env": {
        "VAPI_HOME": "/tmp/vapi-docs-home",
        "VAPI_REGISTRY_URL": "https://api.vapinetwork.ai"
      }
    }
  }
}
```

The entry runs `npx -y vapi-network@latest mcp`. A machine with a password-protected
vault needs `VAPI_VAULT_PASSWORD` in the entry's `env` or an unlocked session.

#### Deprecated tool aliases

These four pre-namespace names still work and still behave identically, but each
result carries one `DEPRECATED:` line naming its replacement. They will be
removed in a later release.

| Alias     | Use instead      |
| --------- | ---------------- |
| `search`  | `call.search`    |
| `inspect` | `call.inspect`   |
| `call`    | `call.pay`       |
| `wallet`  | `wallet.balance` |

#### What the MCP server cannot do

Rename, remove, restore, back up, import or export an account, or return a
recovery phrase, private key or passphrase. Those operations stay in the CLI.
`accounts.add` and swarm setup can derive accounts without exposing keys.
