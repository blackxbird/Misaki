# vAPI Network

vAPI Network builds payment and trust infrastructure for AI agents on Base, with
x402 API payments in USDC.

**One wallet, every x402 API.** `vapi-network` is its open-source, non-custodial
TypeScript client for discovering and paying x402 services from a terminal, an
MCP client, or your own code. The device vault encrypts your keys on this machine,
using an OS-stored device key with optional password protection. vAPI applies spend policy before
signing, sends the payment straight to the service, and writes a local receipt.
Local runs keep keys on this machine; experimental Railway runs require explicit member-key export.
Every payment identifies this client as `vapi` through x402 `builder-code`; when
an API advertises `payment-identifier`, the generated id is kept on that receipt.

vAPI Call takes no fee. Providers are paid directly.

Call, Router, Stake and Agents are live on production. Tasks is coming soon.
See [vapinetwork.ai](https://vapinetwork.ai) and the
[documentation](https://docs.vapinetwork.ai).

vAPI Network is not related to Vapi.ai, the voice AI company.

## Install

This README describes client 0.12.0. `npm view vapi-network version` shows the latest published release.

```bash
npm i -g vapi-network
```

No install? Prefix any command with `npx vapi-network`, for example
`npx vapi-network init`. (`npx vapi` cannot work: the bare `vapi` name on npm
belongs to an unrelated package.)

An agent can set itself up from the agent skill. Tell it: "Read
https://vapinetwork.ai/SKILL.md and follow it to set up vAPI." The same file
ships in this package as [SKILL.md](./packages/vapi-network/SKILL.md), with the
CLI version it describes in its frontmatter.

Interactive CLI runs check for a newer release at most once a day and cache the result in
`~/.vapi/update-check.json`. JSON, MCP server, CI and non-TTY runs skip the check. Set
`VAPI_NO_UPDATE_CHECK=1` to disable it.

## Quickstart

```bash
npm i -g vapi-network
vapi setup [--no-cloud-backup]   # creates or restores the vault, derives main, links it to your owner wallet; safe to rerun
vapi fund                        # opens the hosted funding page for your address
vapi search "weather"            # every catalogue, merged, with provenance
vapi pay <listing-ref> --max 0.02
vapi receipts                    # one line per paid call: quote, settlement, latency
```

Back up the recovery phrase only in a terminal; vAPI cannot recover it.
Turn on encrypted cloud backup with `vapi backup --cloud`; only the owner can approve a restore.

## What you can do

| Surface | What it does                                                               | Guide                                                        |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Call    | Discover, check, publish and pay for x402 APIs.                            | [docs/call.md](./docs/call.md)                               |
| Router  | Use vAPI Router for model access and balance.                              | [docs/router.md](./docs/router.md)                           |
| Tasks   | Preview task posting, USDC escrow and delivery; coming soon on production. | [docs/tasks.md](./docs/tasks.md)                             |
| Agents  | Run capped local agents with dedicated wallets and profiles.               | [docs/agents.md](./docs/agents.md)                           |
| Swarms  | Group capped local agents around a treasury and capital policy.            | [docs/swarms.md](./docs/swarms.md)                           |
| MCP     | Use namespaced payment tools from an MCP client.                           | [docs/mcp.md](./docs/mcp.md)                                 |
| SDK     | Use Call, vAPI Router and local agents behind one wallet-bound API.        | [docs/sdk.md](./docs/sdk.md)                                 |
| Vault   | Manage the owner wallet, device vault, accounts and spend caps.            | [docs/wallets.md](./docs/wallets.md)                         |
| Backup  | Store encrypted vault copies and restore with owner approval.              | [docs/backup-and-recovery.md](./docs/backup-and-recovery.md) |

Wallets and custody are in [docs/wallets.md](./docs/wallets.md), and account transfers are in [docs/sending.md](./docs/sending.md). Configuration, funding, networks and bug reports are in [docs/configuration.md](./docs/configuration.md).

The MCP server registers `docs.search`, `docs.read`, `tasks.search`, `tasks.show`, `tasks.post`, `tasks.propose`, `tasks.submit`, `tasks.award`, `tasks.sign`, `tasks.fund`, `tasks.deliver`, `tasks.release`, `tasks.refund`, `tasks.dispute`, `tasks.counter-evidence`, `tasks.resolve-unmatched`, `tasks.message`, `tasks.thread`, `tasks.watch`, `tasks.status`, `vapi.status`, `vapi.accounts`, `vapi.siblings`, `accounts.add`, `accounts.caps`, `accounts.send`, `auth.link`, `auth.status`, `router.models`, `router.usage`, `router.chat`, `router.buy`, `call.search`, `call.inspect`, `call.pay`, `call.read`, `swarm.setup`, `swarm.add`, `swarm.leave`, `swarm.fund`, `swarm.rebalance`, `swarm.status`, `swarm.dissolve`, `wallet.address`, `wallet.balance`, `wallet.accounts`, `wallet.list`, `wallet.use`, `wallet.fund`, `receipts.list`, `receipts.stats`, `support.report`, `swarm.run`, `swarm.allocate`, `swarm.delegate`, `swarm.runs`, `swarm.stop`. The `tasks.*` tools target the Tasks preview, which is coming soon on production. Inputs and results are in [docs/mcp.md](./docs/mcp.md).

### Swarms

Swarms keep a treasury and capped member accounts on this machine. Setup is safe to rerun; the owner approves account links and funds the treasury.
A deposit arriving at the treasury after dissolve stays on the treasury account, which is kept on this device.

- `swarm.setup` sets up or resumes the treasury, member accounts, profiles and owner links.
- `swarm.add` adds or resumes one member.
- `swarm.leave` sweeps one member to the treasury and removes it from the swarm.
- `swarm.fund` returns owner funding instructions or funds the treasury from a linked local account.
- `swarm.rebalance` moves funds between the treasury and linked members under local caps.
- `swarm.status` reports balances, links, allocation history and unfinished movements.
- `swarm.dissolve` sweeps the swarm back to the owner and removes its local swarm record.
- `swarm.run` runs the lead, which may delegate one level deep using treasury-funded budgets bounded by a per-run draw (default $2.00), or runs every member independently on its own capital.
- `swarm.run` accepts `detach: true` to start in the background, and `swarm.runs` lists a swarm's runs with status. `swarm.stop` stops one tracked run (`name`, `runId`) or all tracked runs (`name`, `all: true`), including unknown workers, through an available stop adapter.
- `swarm.allocate` and `swarm.delegate` are agent-only operations and are refused outside a swarm run; their optional `requestId` input makes retries idempotent.

MCP always declines approval prompts during swarm runs.

CLI commands:

- `vapi swarm create <name>` creates or resumes a local swarm and can fund it after linking.
- `vapi swarm add <name> <role>` adds or resumes one member.
- `vapi swarm remove <name> <member>` sweeps one member to the treasury and removes it.
- `vapi swarm fund <name> <usd>` prints owner funding instructions or funds from a local account.
- `vapi swarm rebalance <name>` moves capital toward the swarm's configured targets.
- `vapi swarm status <name>` reports balances, links, allocation history and unfinished movements.
- `vapi swarm dissolve <name>` sweeps the swarm to the owner and removes its swarm record.
- `vapi swarm run <name> "<task>"` runs the lead or every eligible member with per-run budget and treasury-draw limits.
- `vapi swarm run <name> "<task>" --detach [--runtime local]` starts the run in the background.
- `vapi swarm runs <name>` lists background runs and their status.
- `vapi swarm stop <name> [<runId>|--all] [--confirm-worker-stopped]` stops one or all local or Railway runs for the swarm. The confirmation flag clears one stale start only after you verify its worker is gone.
- `vapi swarm forget-run <name> <runId> --confirm-destroyed` records human confirmation that an unknown/orphaned Railway sandbox was destroyed; no MCP tool exposes this override.
- `vapi agent run <name> "<task>" --detach` starts one agent run in the background.

#### Deprecated tool aliases

These pre-namespace names still work and each result carries a DEPRECATED: line naming its replacement.

| Alias     | Use instead      |
| --------- | ---------------- |
| `search`  | `call.search`    |
| `inspect` | `call.inspect`   |
| `call`    | `call.pay`       |
| `wallet`  | `wallet.balance` |

## Use your Compute in Claude Code and Codex

These commands are available since 0.12.0.

Set up a vAPI account with the quickstart above. Install Claude Code or Codex and make its executable available on PATH. Configure
vAPI for the tools it finds:

```bash
vapi code install
```

The installer reuses your account link and Router key, or starts login and creates
a key when needed. The key stays in the existing OS secret store. Codex gets a
`vapi` model provider and profile in `~/.codex/config.toml`, or
`$CODEX_HOME/config.toml` when `CODEX_HOME` is set. Claude Code needs no config file
change. Missing tools are reported and skipped; if neither exists, nothing is
written.

Interactive terminals ask once before adding shell aliases. To accept without a prompt:

```bash
vapi code install --yes
```

Aliases cover only tools found on PATH. The installer replaces its marked block
in `~/.zshrc` or `~/.bashrc`; Windows skips aliases. Open a new terminal after
adding them. To keep your shell configuration as it is:

```bash
vapi code install --no-alias
```

Start either tool in your project directory:

```bash
vapi claude
vapi codex
```

At launch, vAPI chooses the Router when at least $0.50 of today's Compute remains.
Otherwise, or when the Router cannot be reached, it starts your own Claude
subscription or Codex/ChatGPT login. You must already be signed in to that tool.
The choice happens at launch. There is no local proxy or automatic mid-session
switch.

Claude Code defaults to `venice/claude-sonnet-5-5`. The installer sets Codex's
profile model to `venice/openai-gpt-61-sol`. At launch, Codex uses that profile's
configured model unless `--model` overrides it. Without the profile, the launcher
supplies equivalent options for the child process and writes no config file.

| Flag            | Behavior                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--own`         | Uses the tool's own login with your existing environment, without checking the Router.                              |
| `--vapi`        | Forces the Router route, even below $0.50. Missing credentials fail the launch; unavailable usage omits the amount. |
| `--use-balance` | Counts purchased Router balance for launch selection; uses it for the session when Compute is below $0.50.          |
| `--model`       | Selects a model. Claude accepts `sonnet`, `opus`, `haiku` or a Router model id; Codex takes the model id unchanged. |
| `--account`     | Selects the vAPI account whose Router credentials and allowance to use.                                             |

```bash
vapi claude --own
vapi codex --vapi
vapi claude --use-balance --model opus
vapi codex --model venice/openai-gpt-61-sol --account main
```

Other arguments keep their order. A literal `--` ends launcher option parsing and
passes everything after it to the tool. The interactive launchers reject
`--json`; install and uninstall support it. If you supply Claude Code's
`--settings`, vAPI passes yours through and warns that its model settings were
not added.

When Compute runs out mid-session, the Router returns HTTP 429 with
`budget_exceeded`. Exit Claude Code:

```text
/exit
```

Then resume the conversation through the launch check:

```bash
vapi claude --continue
```

For Codex, quit the session:

```text
/quit
```

Then resume its last conversation:

```bash
vapi codex resume --last
```

The launchers change model endpoint and selection. Project files, `CLAUDE.md`,
skills and MCP servers stay as configured. Claude requests on vAPI Compute go
through Venice. Claude rows on Venice are anonymized, not private.

Remove the installed provider, profile and marked alias blocks:

```bash
vapi code uninstall
```

Uninstall preserves other config content, including MCP entries. It retains
your account link and Router key.

## CLI reference

The code installer and Claude Code/Codex launchers below are available since 0.12.0. Task commands require a preview server; Tasks is coming soon on production.

Most commands accept `--json` and write one success or error value to stdout.
The Claude Code and Codex launchers are interactive and reject that flag.
Task watch and a partially completed scope-signing flow can emit newline-delimited
JSON; delivery emits one result after chain success. See [Task commands](./docs/tasks.md#cli). Exit codes are
`0` for success, `1` for an operational failure, and `2` for invalid usage or
an announced preview-only command.
Solana listings remain searchable. Inspecting or paying one returns
`unsupported_network` (CLI exit `1`); vault payments on Solana arrive in a later release.
Inspect shows the registry’s last observed quote; pay fetches a fresh quote before signing.
Hosted search hides listings in outage unless `--include-outage` is set.
API hits can include health and cheaper or healthier alternatives; inspect can
include response schemas and an example request. Search, inspect and pay JSON
results include zero to four next-action hints.

Protected-vault access and legacy secret-store commands are documented in the [wallet guide](./docs/wallets.md).

Every wallet command takes `--account <name>`, falls back to `VAPI_WALLET`, then the default from `vapi accounts use`; `--wallet <name>` is deprecated and still accepted.

Task exit codes are `0` ok, `1` error or invalid usage, `2` policy refusal, and `3` approval needed in non-interactive mode. Scope signing requires `--yes` or interactive approval; without either it exits `3`. A policy refusal at exit `2` has JSON `ok:false` with `reason: "policy.perTask"` or `reason: "policy.perDay"`. Invalid usage exits `1` with `{ok:false,error:{code:"usage_error",message}}`. Run `vapi task --help` for details. Chain operations require a locally trusted escrow factory. Base Sepolia pins `0x6Ba83621eb386B3E093032096251cA504F6ee033`; `VAPI_TASKS_ESCROW_FACTORY_<chainId>` can configure another chain or override that pin. Base Sepolia uses `BASE_SEPOLIA_RPC_URL`, or `https://sepolia.base.org` when the variable is unset. The client verifies factory and clone state through the trusted RPC before signing, waits for successful transaction receipts and server confirmation envelopes, and records pending operations under `VAPI_HOME` for recovery. Dispute and counter-evidence approve the verified contract fee before submitting evidence. Local per-task, daily and approval policies apply to that fee. Fund, deliver, release, refund, dispute, counter-evidence, resolve-unmatched and watch auto-release require a scope signed on this machine. `--counterparty` only confirms the existing local binding. See [task security and recovery](docs/tasks.md).

Posting a task moves no money. The create-order contract stores its market amount, deadline, intake and award limit. A webhook is configured on the new order through its dedicated endpoint. OAuth task reads require `tasks:read`; writes require `tasks:write`, which also grants reads. See [Task commands](./docs/tasks.md#cli).

| Command                                                        | Options                                                                                                                                                                                                                                            | What it does                                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vapi init`                                                    | `--networks <base,arc>`, `--no-link`                                                                                                                                                                                                               | Creates `~/.vapi`, the wallet `main` and the config. Says so if one exists.                                                                           |
| `vapi setup`                                                   | `--no-cloud-backup`, `--accounts <n>`, `--json`                                                                                                                                                                                                    | Creates or restores the vault, links the first account, and can offer cloud backup. Safe to rerun.                                                    |
| `vapi accounts`                                                | `--all`, `--json`                                                                                                                                                                                                                                  | Lists local accounts and can add the owner's accounts on other devices as read-only rows                                                              |
| `vapi accounts add <name>`                                     | `--label <text>`, `--no-link`, `--json`                                                                                                                                                                                                            | Derives and links a new account                                                                                                                       |
| `vapi accounts import <name>`                                  | `--keystore <path>` or `--key-file <path>`, `--label <text>`, `--json`                                                                                                                                                                             | Imports an account from a private-key prompt or local keystore                                                                                        |
| `vapi accounts rename <old> <new>`                             | `--json`                                                                                                                                                                                                                                           | Renames an account and its local records                                                                                                              |
| `vapi accounts use <name>`                                     | `--json`                                                                                                                                                                                                                                           | Sets the default account                                                                                                                              |
| `vapi accounts remove <name>`                                  | `--force`, `--json`                                                                                                                                                                                                                                | Moves an account to `wallets/.trash/`                                                                                                                 |
| `vapi accounts restore <name>`                                 | `--json`                                                                                                                                                                                                                                           | Restores an account from `wallets/.trash/`                                                                                                            |
| `vapi accounts caps <name>`                                    | `--per-call <usd>`, `--per-day <usd>`, `--ceiling <usd\|off>`, `--json`                                                                                                                                                                            | Sets the account's spend caps and automatic Base USDC ceiling                                                                                         |
| `vapi accounts distribute <amount>`                            | `--from <account>`, `--to <a,b,c>`, `--network <base\|arc>`, `--json`                                                                                                                                                                              | Splits USDC across linked local accounts and records resumable legs                                                                                   |
| `vapi accounts distribute --resume <id>`                       | `--replace-expired-restored`, `--bind-legacy-addresses`, `--json`                                                                                                                                                                                  | Continues an unfinished distribution; unsafe restored or legacy address replacement requires its terminal-only review flag                            |
| `vapi accounts distribute --cancel <id>`                       | `--replace-expired-restored`, `--json`                                                                                                                                                                                                             | Cancels eligible legs without signing; restored legs require terminal-only review and signed legs require proven expiry                               |
| `vapi swarm create <name>`                                     | `--agents`/`--roles`, `--fund`/`--from`, `--strategy`/`--targets`, `--caps`/`--treasury-caps`, `--network`, `--model`, `--no-wait`, `--json`                                                                                                       | Creates or resumes a treasury, member accounts, profiles and owner links                                                                              |
| `vapi swarm add <name> <role>`                                 | `--json`                                                                                                                                                                                                                                           | Adds or resumes one member                                                                                                                            |
| `vapi swarm remove <name> <member>`                            | `--json`                                                                                                                                                                                                                                           | Sweeps a member to the treasury and removes it from the swarm                                                                                         |
| `vapi swarm fund <name> <usd>`                                 | `--from <account>`, `--json`                                                                                                                                                                                                                       | Prints owner funding instructions or funds the treasury from a local account                                                                          |
| `vapi swarm rebalance <name>`                                  | `--targets <role=usd,...>`, `--json`                                                                                                                                                                                                               | Moves funds between the treasury and linked members under local caps                                                                                  |
| `vapi swarm status <name>`                                     | `--json`                                                                                                                                                                                                                                           | Reports balances, links, allocation history and unfinished movements                                                                                  |
| `vapi swarm dissolve <name>`                                   | `--json`                                                                                                                                                                                                                                           | Sweeps the swarm back to the owner and removes its local swarm record                                                                                 |
| `vapi swarm run <name> "<task>"`                               | `--mode <lead\|each>`, `--lead <member>`, `--budget <usd>`, `--draw <usd>`, `--detach`, `--runtime <local\|railway>`, `--result-file <path>`, `--json`                                                                                             | Runs the lead or each member under run budgets                                                                                                        |
| `vapi swarm run <name> "<task>" --mode each --runtime railway` | `--checkpoint <name>`, `--allow-remote-key`, `--budget <usd>`, `--keep-sandbox`, `--json`                                                                                                                                                          | Runs dedicated members in experimental Railway sandboxes; see the swarm guide                                                                         |
| `vapi swarm runs <name>`                                       | `--json`                                                                                                                                                                                                                                           | Lists stored runs and their runtime status                                                                                                            |
| `vapi swarm stop <name> [<runId>]`                             | `--all`, `--confirm-worker-stopped`, `--json`                                                                                                                                                                                                      | Stops local or Railway runs; confirmation clears a verified stale start                                                                               |
| `vapi swarm forget-run <name> <runId>`                         | `--confirm-destroyed`, `--json`                                                                                                                                                                                                                    | Confirms a verified unknown/orphaned Railway sandbox is destroyed and retains its run record                                                          |
| `vapi send <amount>`                                           | `--from <account>`, `--to <account\|owner\|0x…>`, `--network <base\|arc>`, `--resume <nonce>`, `--json`                                                                                                                                            | Sends USDC to the owner or another active account; vAPI pays gas                                                                                      |
| `vapi wallet list`                                             | -                                                                                                                                                                                                                                                  | Name, address, default marker, caps in USD, unlocked, label                                                                                           |
| `vapi wallet create <name>`                                    | `--label <text>`, `--no-link`                                                                                                                                                                                                                      | Deprecated alias for `accounts add`; derives an account in the device vault                                                                           |
| `vapi wallet use <name>`                                       | -                                                                                                                                                                                                                                                  | Makes it the default for every later command                                                                                                          |
| `vapi wallet rename <old> <new>`                               | -                                                                                                                                                                                                                                                  | Deprecated alias for `accounts rename`; renames the account and local records                                                                         |
| `vapi wallet remove <name>`                                    | `--force`                                                                                                                                                                                                                                          | Deprecated alias for `accounts remove`; moves the account to `wallets/.trash/`                                                                        |
| `vapi wallet restore <name>`                                   | -                                                                                                                                                                                                                                                  | Deprecated alias for `accounts restore`; restores the removed account                                                                                 |
| `vapi wallet caps <name>`                                      | `--per-call <usd>`, `--per-day <usd>`                                                                                                                                                                                                              | Sets that wallet's spend caps, in US dollars                                                                                                          |
| `vapi fund`                                                    | `--amount <usd>`, `--account <name>`                                                                                                                                                                                                               | Prints and opens the hosted funding page. Makes no network call.                                                                                      |
| `vapi docs "<question>"`                                       | `--json`                                                                                                                                                                                                                                           | Asks the public vAPI documentation assistant and prints its answer and sources; no wallet or payment                                                  |
| `vapi docs search "<query>"`                                   | `--json`                                                                                                                                                                                                                                           | Searches the vAPI documentation and prints matching excerpts; no wallet or payment                                                                    |
| `vapi docs read <url-or-path>`                                 | `--json`                                                                                                                                                                                                                                           | Reads one vAPI documentation page as Markdown; no wallet or payment                                                                                   |
| `vapi accounts`                                                | `--enable <arc>`, `--account <name>`                                                                                                                                                                                                               | Legacy form: one deposit account per configured network, with balances and guidance                                                                   |
| `vapi search [query]`                                          | `--kind <kind>` (repeatable), `--network <caip2>`, `--limit <n>`, `--cursor <cursor>`, `--include-unverified`, `--include-outage`                                                                                                                  | Registry discovery with group, tier, health and alternatives                                                                                          |
| `vapi inspect <id>`                                            | `--endpoint <name>`                                                                                                                                                                                                                                | Health, verification, request and response contracts, example request and the registry's last observed quote                                          |
| `vapi pay <id-or-url>`                                         | `--method`, `--endpoint`, `--body <json>`, `--content-type`, `--network <caip2>`, `--expected-pay-to`, `--max <usd>`, `--timeout <seconds>`, `--account <name>`                                                                                    | Pays locally, includes hints in JSON, and names the limit blocking a payment                                                                          |
| `vapi pay --resume <receipt-id>`                               | -                                                                                                                                                                                                                                                  | Checks settlement, shows its payment id, and never pays                                                                                               |
| `vapi check <url>`                                             | `--method <method>`                                                                                                                                                                                                                                | Grades its 402, extensions and same-origin discovery. Never pays                                                                                      |
| `vapi balance`                                                 | `--account <name>`                                                                                                                                                                                                                                 | The wallet's address and USDC balances                                                                                                                |
| `vapi receipts`                                                | `--limit <n>`, `--account <name>`, `--all-wallets`                                                                                                                                                                                                 | The local append-only call ledger, newest last                                                                                                        |
| `vapi receipts export`                                         | `--format <json\|csv>`, `--range <24h\|7d\|30d>`, `--account <name>`, `--all-wallets`                                                                                                                                                              | Raw receipts for a spreadsheet or dashboard                                                                                                           |
| `vapi stats`                                                   | `--range <24h\|7d\|30d>`, `--account <name>`, `--all-wallets`                                                                                                                                                                                      | Spend, outcomes, latency percentiles and top services                                                                                                 |
| `vapi sweep [<address>]`                                       | `--network <caip2>`, `--account <name>`                                                                                                                                                                                                            | Moves USDC to an address, or to the linked owner when omitted; open movement legs block it                                                            |
| `vapi agent create <name>`                                     | `--model <id>`, `--instructions <file>`, `--call-budget <usd>`, `--max-per-call <usd>`, `--router-budget <usd>`, `--approve-above <usd>`, `--max-per-task <usd>`, `--auto-release-below <usd>`, `--include-unverified`, `--max-steps <n>`, `--yes` | Creates a capped local agent wallet, profile and owner link; `--yes` skips task policy prompts                                                        |
| `vapi agent run <name> "<task>"`                               | `--budget <usd>`, `--detach`, `--runtime local`, `--result-file <path>`, `--json`                                                                                                                                                                  | Runs the named agent with an optional hard budget across Call and Router top-ups; can detach locally                                                  |
| `vapi agent run --bundle-env <VAR>`                            | `"<task>"` or `--task-base64url <text>`, `--budget <usd>`, `--result-file <path>`, `--json`                                                                                                                                                        | Runs from an exported member bundle in the experimental remote runtime; see the [swarm guide](docs/swarms.md#running-members-on-railway-experimental) |
| `vapi agent list`                                              | None                                                                                                                                                                                                                                               | Lists profiles, links and today's Call and Router budgets                                                                                             |
| `vapi agent show <name>`                                       | None                                                                                                                                                                                                                                               | Prints the agent's spend policy, caps and tools                                                                                                       |
| `vapi agent pause <name>`                                      | None                                                                                                                                                                                                                                               | Stops future runs until the agent is resumed                                                                                                          |
| `vapi agent resume <name>`                                     | None                                                                                                                                                                                                                                               | Allows a paused agent to run again                                                                                                                    |
| `vapi agent revoke <name>`                                     | None                                                                                                                                                                                                                                               | Revokes the link and removes the profile, but keeps its wallet                                                                                        |
| `vapi dashboard`                                               | `--account <name>`, `--no-browser`, `--no-link`                                                                                                                                                                                                    | Opens My agents on your vAPI dashboard and offers to link an unlinked wallet.                                                                         |
| `vapi login`                                                   | `--account <name>`, `--label <name>`, `--publish`, `--no-browser`                                                                                                                                                                                  | Links the local agent wallet to your vAPI account                                                                                                     |
| `vapi logout`                                                  | `--account <name>`                                                                                                                                                                                                                                 | Removes the selected wallet's agent link and stored credentials                                                                                       |
| `vapi whoami`                                                  | `--account <name>`                                                                                                                                                                                                                                 | Shows the chosen wallet's owner link and permissions, whether the link is live, and its ERC-8004 agent identity.                                      |
| `vapi code install`                                            | `--yes`, `--no-alias`, `--account <name>`, `--json`                                                                                                                                                                                                | Unreleased (next version). Configures detected coding tools for vAPI Compute and optional shell aliases                                               |
| `vapi code uninstall`                                          | `--json`                                                                                                                                                                                                                                           | Unreleased (next version). Removes the vAPI provider, profile and marked shell aliases                                                                |
| `vapi claude [args...]`                                        | `--vapi`, `--own`, `--use-balance`, `--model <m>`, `--account <name>`                                                                                                                                                                              | Unreleased (next version). Starts Claude Code on Compute or the tool's own login; interactive, no JSON                                                |
| `vapi codex [args...]`                                         | `--vapi`, `--own`, `--use-balance`, `--model <id>`, `--account <name>`                                                                                                                                                                             | Unreleased (next version). Starts Codex on Compute or the tool's own login; interactive, no JSON                                                      |
| `vapi router models`                                           | `--account <name>`                                                                                                                                                                                                                                 | Lists the vAPI Router model ids                                                                                                                       |
| `vapi router usage`                                            | `--account <name>`                                                                                                                                                                                                                                 | Shows the agent's Compute allowance and Router balance                                                                                                |
| `vapi router chat --model <id> "<prompt>"`                     | `--system <text>`, `--max-tokens <n>`, `--account <name>`                                                                                                                                                                                          | Sends one chat request through vAPI Router                                                                                                            |
| `vapi router clear-pending`                                    | `--confirm-unpaid`, `--account <name>`, `--json`                                                                                                                                                                                                   | Checks receipt and nonce before clearing; human override requires unavailable chain evidence (CLI only)                                               |
| `vapi router key`                                              | `--rotate`, `--account <name>`                                                                                                                                                                                                                     | Prints a gated Router key or rotates it without printing it                                                                                           |
| `vapi router buy <1\|5\|20\|50>`                               | `--account <name>`, `--json`                                                                                                                                                                                                                       | Buys vAPI Router balance with USDC from your wallet                                                                                                   |
| `vapi router buy --auto <tier> --below <usd>`                  | `--account <name>`, or use `--auto off`                                                                                                                                                                                                            | Sets or clears automatic vAPI Router balance refill                                                                                                   |
| `vapi stake status`                                            | `--account <name>`                                                                                                                                                                                                                                 | Shows the linked owner's stake and Compute today                                                                                                      |
| `vapi stake open`                                              | `--account <name>`, `--no-browser`                                                                                                                                                                                                                 | Prints and optionally opens the staking page                                                                                                          |
| `vapi task search`                                             | `--open`, `--min <usd>`, `--tab trending\|new\|closing\|paid`, `--limit <n>`, `--account <name>`, `--json`                                                                                                                                         | Finds public tasks and filters the returned page.                                                                                                     |
| `vapi task show <id>`                                          | `--account <name>`, `--json`                                                                                                                                                                                                                       | Shows the acting party's task or a public card and prints settled escrow receipts                                                                     |
| `vapi task post`                                               | `--title <text>`, `--brief <file\|->`, `--amount <usd>`, `--deadline <duration\|ISO>`, `--intake proposals\|submissions`, `--max-awards <k>`, `--webhook <https-url>`, `--account <name>`, `--json`                                                | Stores the task and market settings, configures an optional webhook, and moves no money                                                               |
| `vapi task propose <id>`                                       | `--price <usd>`, `--duration <duration>`, `--note <text>`, `--account <name>`, `--json`                                                                                                                                                            | Signs proposal terms locally and offers to take a task                                                                                                |
| `vapi task submit <id>`                                        | `--proof <https-url>` (repeatable), `--file <path>` (repeatable), `--account <name>`, `--json`                                                                                                                                                     | Uploads files and signs bounty proof. Needs server support for public terms, submissions and bearer tokens on upload routes.                          |
| `vapi task award <id> <proposalId>`                            | `--account <name>`, `--json`                                                                                                                                                                                                                       | Awards a proposal or submission. Moves no money. Needs server support for bearer tokens on participant routes.                                        |
| `vapi task sign <id>`                                          | `--yes`, `--no-wait`, `--timeout 120s`, `--account <name>`, `--json`, `--counterparty <0x…>`                                                                                                                                                       | Signs the agreed scope locally. A worker creates the unfunded escrow with the local vault wallet.                                                     |
| `vapi task fund <id>`                                          | `--yes`, `--no-wait`, `--timeout 120s`, `--account <name>`, `--json`, `--counterparty <0x…>`                                                                                                                                                       | Applies local spend policy and funds escrow with the local vault wallet.                                                                              |
| `vapi task deliver <id>`                                       | `--files <path...>`, `--note <text>`, `--no-wait`, `--timeout 120s`, `--account <name>`, `--json`, `--counterparty <0x…>`                                                                                                                          | Prepares a delivery manifest from 1 to 20 files and records delivery onchain.                                                                         |
| `vapi task release <id>`                                       | `--no-wait`, `--timeout 120s`, `--account <name>`, `--json`, `--counterparty <0x…>`                                                                                                                                                                | Releases escrow to the worker with the local vault wallet.                                                                                            |
| `vapi task refund <id>`                                        | `--account <name>`, `--json`, `--counterparty <0x…>`                                                                                                                                                                                               | Returns escrow to the poster with the local vault wallet.                                                                                             |
| `vapi task dispute <id>`                                       | `--evidence-hash <0x + 64 hex>`, `--yes`, `--account <name>`, `--json`, `--counterparty <0x…>`                                                                                                                                                     | Applies spend policy, approves the verified fee and raises a dispute.                                                                                 |
| `vapi task counter-evidence <id>`                              | `--evidence-hash <0x + 64 hex>`, `--yes`, `--counterparty <0x…>`, `--account <name>`, `--json`                                                                                                                                                     | Pays the verified fee and submits counter-evidence before the deadline.                                                                               |
| `vapi task resolve-unmatched <id>`                             | `--counterparty <0x…>`, `--account <name>`, `--json`                                                                                                                                                                                               | Resolves an unanswered dispute after the onchain deadline.                                                                                            |
| `vapi task message <id> <text>`                                | `--account <name>`, `--json`                                                                                                                                                                                                                       | Sends a task message. Needs server support for bearer tokens on participant routes.                                                                   |
| `vapi task thread <id>`                                        | `--after <cursor>`, `--account <name>`, `--json`                                                                                                                                                                                                   | Reads task messages. The cursor is nextBeforeSeq for an older page. Needs server support for bearer tokens on participant routes.                     |
| `vapi task watch <id>`                                         | `--until <state>`, `--auto-release`, `--timeout 7d`, `--interval 5s`, `--account <name>`, `--json`, `--counterparty <0x…>`                                                                                                                         | Watches task events. Auto-release signs with the selected local vault wallet.                                                                         |
| `vapi task status <id>`                                        | `--account <name>`, `--json`                                                                                                                                                                                                                       | Shows chain state and participant events when signed in, or the public task card.                                                                     |
| `vapi export-key`                                              | `--network <caip2>`, `--account <name>`                                                                                                                                                                                                            | Prints the private key. Terminal only, never for an agent.                                                                                            |
| `vapi backup`                                                  | `--account <name>`, `--cloud [off]`, `--json`                                                                                                                                                                                                      | Prints the 12 words, or turns encrypted cloud backup on or off.                                                                                       |
| `vapi restore`                                                 | `--accounts <n>`, `--from-owner [--owner <0x…>]`, `--json`                                                                                                                                                                                         | Rebuilds the vault from a recovery phrase typed at the prompt or piped on stdin, or restores an owner-approved cloud backup.                          |
| `vapi import`                                                  | `--phrase` or `--key`, `--account <name>`, `--networks <base,arc>`, `--replace`, `--force`                                                                                                                                                         | Restores a wallet from a prompt, never from argv                                                                                                      |
| `vapi passphrase`                                              | `--account <name>`                                                                                                                                                                                                                                 | Changes a legacy keystore passphrase; vault accounts use `vapi vault protect`                                                                         |
| `vapi vault protect`                                           | `--json`                                                                                                                                                                                                                                           | Adds a password to the device vault                                                                                                                   |
| `vapi vault unprotect`                                         | `--json`                                                                                                                                                                                                                                           | Removes the password from the device vault                                                                                                            |
| `vapi vault lock`                                              | `--json`                                                                                                                                                                                                                                           | Closes the protected vault on this device                                                                                                             |
| `vapi vault unlock`                                            | `--json`                                                                                                                                                                                                                                           | Opens a protected vault session for eight hours                                                                                                       |
| `vapi unlock`                                                  | `--account <name>`, `--json`                                                                                                                                                                                                                       | Deprecated alias for `vapi vault unlock` for vault accounts                                                                                           |
| `vapi vault status`                                            | `--json`                                                                                                                                                                                                                                           | Shows whether the device vault is protected and open                                                                                                  |
| `vapi lock`                                                    | `--account <name>`, `--all`                                                                                                                                                                                                                        | Deprecated alias for `vapi vault lock` for vault accounts                                                                                             |
| `vapi report "<what>"`                                         | `--include-addresses`, `--send`                                                                                                                                                                                                                    | Writes a privacy-preserving local bug report                                                                                                          |
| `vapi auth set-key`                                            | -                                                                                                                                                                                                                                                  | Types the registry API key on a prompt into the OS secret store                                                                                       |
| `vapi auth status`                                             | -                                                                                                                                                                                                                                                  | Whether this machine has a key and where it comes from, masked                                                                                        |
| `vapi auth clear`                                              | -                                                                                                                                                                                                                                                  | Takes the stored key back out                                                                                                                         |
| `vapi publish <url>`                                           | `--method`, `--mode <origin\|endpoint\|openapi>`, `--name <text>`, `--description <text>`, `--category <ai\|data\|crypto\|compute\|search>`, `--select <names>`, `--account <name>`, `--yes`, `--resume`                                           | Probes your API, lists the endpoints you pick, signs the payout wallet                                                                                |
| `vapi publish activate <slug>`                                 | -                                                                                                                                                                                                                                                  | Takes a listing live once every endpoint pays the signed payout wallet                                                                                |
| `vapi publish verify-request <slug>`                           | -                                                                                                                                                                                                                                                  | Asks vAPI to review the listing                                                                                                                       |
| `vapi publish list`                                            | -                                                                                                                                                                                                                                                  | Every listing this API key owns                                                                                                                       |
| `vapi claim <origin>`                                          | `--account <name>`                                                                                                                                                                                                                                 | Takes over the listings vAPI indexed from your API, signed by their payee                                                                             |
| `vapi mcp`                                                     | `--account <name>`                                                                                                                                                                                                                                 | Serves the MCP tools over stdio                                                                                                                       |
| `vapi mcp install <app>`                                       | `claude-code`, `claude-desktop`, `cursor`, `codex`; `--home <dir>`, `--registry <url>`, `--no-link`, `--json`                                                                                                                                      | Registers vAPI through Claude Code's CLI or writes the client's MCP config                                                                            |
| `vapi serve`                                                   | -                                                                                                                                                                                                                                                  | Preview only; exits `2` with a message                                                                                                                |
| `vapi version`                                                 | -                                                                                                                                                                                                                                                  | The client version, also as `--version` or `-v`                                                                                                       |
| `vapi help`                                                    | -                                                                                                                                                                                                                                                  | Lists commands and flags, also as `--help` or `-h`; bare `vapi` shows status                                                                          |

Phrase recovery checks Base USDC balances until five consecutive addresses are empty and reports the number scanned. `vapi restore --accounts <n>` (or `vapi setup --accounts <n>` when restoring) derives a fixed count without balance queries.

## Packages

| Package                 | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `vapi-network`          | zero-dependency distribution with the `vapi` binary and defaults        |
| `@vapi-network/core`    | x402 protocol, wallet store, spend policy, discovery merge and receipts |
| `@vapi-network/sources` | vAPI Registry, Coinbase Bazaar, local-file and x402scan source adapters |
| `@vapi-network/mcp`     | stdio MCP server with namespaced payment tools                          |
| `@vapi-network/cli`     | command parsing and the command implementations behind `vapi`           |

Every npm tarball is bundled and has zero runtime dependencies. The scoped
packages are useful for embedding; most users should start with `vapi-network`.

## vAPI Desktop

vAPI Desktop is the macOS app for managing agent wallets and connecting local MCP clients.
The signer process keeps keys on your computer.
Version 0.1.0 is not released yet; signing and notarization are pending. The source is in `apps/desktop`.
See [the desktop release guide](apps/desktop/RELEASE.md) for building and signing the app.

## Development

A pnpm workspace for Node.js 22 and pnpm 10. The gate, in order:

```sh
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

All five packages share one version and are released together. npm reads a
package manifest before lifecycle hooks run, so the release is made from the
generated `publish/` directories, never from the workspace package roots.

```sh
pnpm install --frozen-lockfile
pnpm pack:check
npm login
pnpm --dir packages/core publish:npm
pnpm --dir packages/sources publish:npm
pnpm --dir packages/mcp publish:npm
pnpm --dir packages/cli publish:npm
pnpm --dir packages/vapi-network publish:npm
```

`publish:npm` publishes a package's staged `./publish` directory to the `latest`
npm tag; `publish:npm:next` publishes the same tarball to `next`. The manual
release workflow verifies artifacts and prints these commands; it never receives
npm credentials and never publishes.

See [AGENTS.md](./AGENTS.md) for layout and invariants,
[CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow,
[CHANGELOG.md](./CHANGELOG.md) for what shipped in each release, and
[SECURITY.md](./SECURITY.md) for private vulnerability reports.

## License

Apache-2.0. See [LICENSE](./LICENSE).
