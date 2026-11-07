# Swarms

A swarm groups local agent accounts around one treasury and one capital policy. Each member keeps its own key, balance, caps, profile, and owner link.

## The building blocks

These names have the same meaning in the CLI, MCP tools, movement files, and swarm state.

| Term     | Meaning                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------- |
| Owner    | The human wallet that approves links and receives the final treasury sweep.                              |
| Account  | One local vault key with its own USDC balance, owner link, spend caps, and ceiling.                      |
| Agent    | An account with a local profile that names its model, instructions, tools, and run limits.               |
| Swarm    | A named group of member accounts on one device, with one treasury and one capital policy.                |
| Treasury | A linked account that holds swarm capital. It has no agent profile and never runs an agent loop.         |
| Role     | A member label such as `lead`, `helper`, or `trader`, with a weight, target, and ceiling.                |
| Movement | A planned set of transfer legs with one reason and one recorded nonce per leg.                           |
| Journal  | Local movement files, receipts, and audit entries that record why money moved. The chain holds balances. |

One account belongs to at most one local swarm. A member key must be present on the same device as its swarm. Accounts on other devices can receive transfers but cannot become members.

## Capital flow

Capital enters the treasury before it reaches members. Members spend their own balances on Call and Router. Ceiling sweeps return excess funds to the account's parent.

```text
Owner ── fund ──▶ Treasury ── allocate / rebalance / delegate ──▶ Members ── spend ──▶ Call and Router
  ▲                    ▲                                                │
  └── sweep above ceiling                                              └── sweep above ceiling
       Treasury to Owner                                                    Member to Treasury
```

Rebalance, allocate and delegate move capital between the treasury and members. A member sweep goes to its treasury, while a treasury sweep goes to the owner.

## Commands and MCP tools

The CLI and MCP tools operate on the same local swarm files and accounts. Setup and capital commands are safe to rerun because they resume recorded work.

Member profiles use the Router model `venice/claude-sonnet-5` unless `--model <id>` names another model from `vapi router models`.

| CLI command                                                                                                                                                                                                                                                                              | MCP tool          | What it does                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `vapi swarm create <name> [--agents <n>\|--roles <a,b,c>] [--fund <usd> --from <account>] [--strategy <targets\|even\|weights>] [--targets <role=usd,...>] [--caps <perCall>/<perDay>] [--treasury-caps <perCall>/<perDay>] [--network <base\|arc>] [--model <id>] [--no-wait] [--json]` | `swarm.setup`     | Creates or resumes the treasury, members, caps, profiles, links, and optional funding.     |
| `vapi swarm add <name> <role> [--json]`                                                                                                                                                                                                                                                  | `swarm.add`       | Adds or resumes one member with the named role.                                            |
| `vapi swarm remove <name> <member> [--json]`                                                                                                                                                                                                                                             | `swarm.leave`     | Sweeps one member to the treasury before removing its membership.                          |
| `vapi swarm fund <name> <usd> [--from <account>] [--json]`                                                                                                                                                                                                                               | `swarm.fund`      | Funds the treasury from a linked account, or returns owner funding instructions.           |
| `vapi swarm rebalance <name> [--targets <role=usd,...>] [--json]`                                                                                                                                                                                                                        | `swarm.rebalance` | Moves funds between the treasury and members under the selected targets and local caps.    |
| `vapi swarm status <name> [--json]`                                                                                                                                                                                                                                                      | `swarm.status`    | Shows balances, links, allocation history, and unfinished movements without moving funds.  |
| `vapi swarm dissolve <name> [--json]`                                                                                                                                                                                                                                                    | `swarm.dissolve`  | Sweeps members to the treasury and the treasury to the owner, then removes the swarm file. |

Removing a member keeps its local account, key, and profile. Dissolving a swarm also keeps every account and profile. Dissolve refuses while a Railway sandbox of the swarm may still hold a member key; stop it first with `vapi swarm stop <name> --all`. A later deposit to a dissolved treasury stays in that retained account.

An account name and its recorded address identify one swarm account. Every new movement leg also records its resolved sender and recipient addresses before signing. Planning, execution and `vapi accounts distribute --resume` refuse a name that now resolves to another address. Restore the recorded account at that name before retrying.

`vapi accounts remove` refuses every account named by a swarm or unfinished movement. This includes a sender whose leg is sent while another leg remains open. Retryable failures and failed legs with signed authorizations remain open. Non-restored terminal unsigned failures and cancelled legs do not. Restored legs stay open until sent or cancelled. Rename protects the same names. Dissolve the swarm, resume the movement, or cancel its terminal legs before changing an account name.

Capital commands reconcile a sender's unfinished automatic ceiling sweep before planning or resuming another leg. Automatic sweeps perform the reciprocal check under the same sender lock. They reconcile signed movement legs when possible and skip with `unfinished_movement` while an authorization may still settle. The standalone `vapi sweep` command uses the same sender lock and refuses until the movement resumes or is safely cancelled.

The relay accepts at most 50 USDC per transfer by default. Funding and sweep amounts above that limit become several legs in one durable movement. A retry resumes the unfinished leg and skips every sent leg.

The `even` strategy splits whole cents and gives every remainder cent to the first linked member. Recipient ceilings can reduce a member's executable leg without reallocating that blocked amount.

Setup recovery never raises an account limit. If setup stopped before recording its cap step, one registry update keeps the lower value for each existing cap and ceiling field. An owner reduction made during recovery wins because the comparison occurs under the registry lock. Use `vapi accounts caps` in a terminal when the planned setup needs a higher value.

### Runs

`swarm.run` and `vapi swarm run <name> "<task>" [--mode lead|each]` run either the lead or every member. Lead mode lets the lead delegate, while each mode gives the same task to every member separately.

`swarm.delegate` gives one member a subtask and a hard run budget. Delegation is one level deep, and its budget comes from the treasury in a `delegate` movement.

`swarm.allocate` asks the treasury for member budget and requires the `allocate` grant. `call.read` uses SIWX to GET a result URL from a listing paid during the run. The URL must share that listing's origin, and `call.read` never pays. A response that reflects the generated SIWX header or signature returns those values as `[redacted]`.

## Running members on Railway (experimental)

The `railway` runtime runs each swarm member in its own Railway sandbox. It is experimental. Each member runs `vapi agent run --bundle-env` inside a sandbox booted from a checkpoint that has the vAPI CLI installed.

### What goes into the sandbox

A sandbox receives one member bundle through a `0600` env file. The file is deleted as soon as `railway sandbox create` returns. The bundle holds:

- that member's own private key;
- that member's short-lived access token and Router key;
- that run's reserved per-call and per-day caps;
- the next UTC midnight, when that run's spending allowance expires;
- that member's profile, without the `delegate` and `allocate` grants;
- a config with the swarm network's id, its canonical USDC address, and the two discovery URLs.

The owner's refresh token, recovery phrase, treasury key and every other account stay on this machine. The bundle never appears in a command line, a log, the run registry, the audit log or a receipt.

The member key controls every asset at that address on every EVM chain. The one-network bundle config does not restrict the key. Use dedicated swarm member accounts that hold no assets outside the swarm.

The bundle config carries no RPC URL and no API key from your `config.json`. Owner RPC URLs often embed a provider API key, so they stay on this machine. The bundle schema refuses an `rpcUrl` or `apiKey` key at any depth. A discovery URL with a user name, password, query string or fragment is refused before any key is read.

Inside the sandbox, `vapi agent run --bundle-env` writes a config on the public RPC defaults from the network definitions:

| Network                   | Public RPC default                    |
| ------------------------- | ------------------------------------- |
| Base mainnet              | `https://mainnet.base.org`            |
| Arc mainnet               | `https://rpc.mainnet.arc.io`          |
| Solana mainnet (both ids) | `https://api.mainnet-beta.solana.com` |

The bundle carries only the swarm network as client configuration. Before export, the CLI checks USDC at the member address on Base mainnet, Arc mainnet and Arc testnet. Each check uses that network's canonical USDC contract. A configured network contributes its RPC URL, never its token address. A positive balance outside the swarm network stops the run. An unreadable mainnet balance also stops it; an unreadable Arc testnet balance is skipped unless the swarm runs on Arc testnet.

A swarm whose own network has no public default still cannot run in the headless sandbox. An RPC variable inside the sandbox, such as `BASE_RPC_URL`, overrides that network's public default.

The bundle access token cannot refresh or rotate the owner's credentials. Router calls fail with a clear error after the token expires. Start a new Railway run from the owner machine to supply a new access token.

### Audit lines

Every railway start that runs `railway sandbox create` writes one `agent.remote_key_exported` line to `audit.log`, also when Ctrl-C or SIGTERM cuts the start off. The line names the account and the sandbox id, or `none` or `unknown` when `create` returned no id, never the key. A start that stops before `create` runs, such as a refused env file or a missing `railway` binary, sent nothing and writes no export line.

A refused start writes an `agent.remote_key_refused` line instead, with the account and the refusal reason, whether the CLI or an SDK caller started it. No key is read before a refusal.

### Limits

| Limit                 | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| Member target         | 1.00 USDC or less                                        |
| Effective ceiling     | 2.00 USDC or less, the larger of ceiling and per-day cap |
| Swarm-network USDC    | 2.00 USDC or less when the key is exported               |
| Other known EVM USDC  | Zero at the member address                               |
| Daily allowance       | More than zero after local spend and prior reservations  |
| Mode                  | `--mode each` only                                       |
| Required flag         | `--allow-remote-key`                                     |
| Terminal confirmation | Type the swarm name when a terminal is attached          |
| Agent environments    | Refused when `VAPI_NO_SECRETS` or an agent marker is set |

The CLI checks every member's limits and known-network balances before it starts anything. One member over a limit stops the whole run, and the refusal names the command that fixes it:

```sh
vapi accounts caps <member> --ceiling 2 --per-day 2
```

The CLI reads each member's USDC balance on every known EVM network. The runtime reads all balances again before exporting that member's key. More than 2.00 USDC on the swarm network is refused, and the refusal names two ways to bring the balance down:

```sh
vapi swarm rebalance <name>
vapi sweep --account <member>
```

Any USDC on another known network is refused. Move it to another dedicated account. If a mainnet balance, or the swarm network's balance, cannot be read, the member is refused as well. The refusal does not repeat the reader's error because it can name an RPC URL.

The runtime refuses export while the member has a pending ceiling sweep, an unfinished movement leg or an unknown transfer receipt. Transfer receipts are compared by wallet, network and nonce. A later sent or failed resume result supersedes an earlier unknown result. Resolve a remaining authorization with `vapi sweep`, the movement resume command or the original `vapi send --resume` command.

`VAPI_NO_SECRETS=1`, `CI` and the agent variables that stop `vapi export-key` also stop the railway runtime, with or without `--allow-remote-key`. The runtime checks the environment of the running process as well as any environment an SDK caller passes in, so a clean injected environment cannot lift a marker the process runs under. Each refusal writes an `agent.remote_key_refused` line to `audit.log`.

The treasury never runs remotely. Lead mode needs the treasury key, so the railway runtime refuses it. MCP never starts a railway run, and no MCP tool can export a key.

A leaked member key can spend every asset at that address on every chain. Revoking the link stops Router and relays, but not x402 payments the key signs itself. Dedicated member accounts and the balance checks limit this exposure.

Before launch, the owner reserves `min(run budget, remaining per-day allowance)` in the local member spend ledger. Without `--budget`, the runtime reserves the full remaining allowance. The bundle per-day cap and hard run budget both equal this reservation. A zero allowance stops the run.

Remote reservations are never released automatically. A failed or ambiguous run keeps its reservation because remote spend is not reconciled into the owner's ledger. The reservation expires at the next UTC midnight. After that time, the headless run refuses Call payments and Router top-ups. Any EIP-3009 authorization signed before midnight also expires no later than midnight. Start a new Railway run to reserve allowance for the new UTC day.

Automatic ceiling sweeps are off inside the headless sandbox. This prevents the disposable home from signing another sweep nonce while an earlier authorization may still settle.

### Make the checkpoint

Create a sandbox, install the CLI inside it, and save it as a checkpoint. Replace `<sandbox-id>` with the id that `create` prints.

```sh
railway sandbox create
railway sandbox exec <sandbox-id> -- npm i -g @vapi-network/cli
railway sandbox checkpoint create vapi-cli
```

The checkpoint needs `@vapi-network/cli` 0.8.0 or later, the first release with `vapi agent run --bundle-env`.

### Run, follow and stop

```sh
vapi swarm run research "Compare three weather APIs" --mode each --runtime railway --checkpoint vapi-cli --allow-remote-key --budget 0.50
```

`--runtime railway` always starts a background run, with or without `--detach`. `VAPI_RAILWAY_CHECKPOINT` replaces `--checkpoint`. On a terminal the CLI prints the warning and asks you to type the swarm name. Without a terminal, `--allow-remote-key` alone lets the run start.

The warning ends with the checkpoint the sandboxes boot and where the name came from:

```text
Checkpoint: vapi-cli (from --checkpoint)
```

A checkpoint name has 1 to 64 letters, digits, `.`, `_` or `-`, and starts with a letter or digit. Any other name is refused before a file, key or sandbox is touched. The runtime starts only the members listed in the warning; a member added to the swarm after the confirmation is refused.

The start is all or nothing. If one member fails to start, the CLI stops the members that the same command already started, then reports the failure. A member it cannot stop is named in the error with its `vapi swarm stop <name> <runId>` command.

```sh
vapi swarm runs research
vapi swarm stop research --all
```

The CLI waits up to about 30 seconds for a new sandbox to answer before it starts the member. The task reaches the sandbox base64url-encoded, so quotes and shell characters arrive unchanged.

`vapi swarm runs` reads each sandbox's result and reconciles saved launch references. A finished run's sandbox is destroyed on that call. A failed cleanup leaves the run `running` with a sanitized detail and exits with code 1. `vapi swarm stop` attempts to stop recovered starts, running workers and unknown runs.

For an **unknown** Railway run, only `railway sandbox destroy <id>` exiting **0** permits `stopped` to be persisted. Railway's experimental-feature warning on stderr is harmless on a successful exit. Every non-zero exit, timeout, interruption or thrown error keeps the run unknown and blocking, even if its output says “not found.” Human CLI text does not verify absence in the original project/environment. Ordinary stop and refresh behavior is unchanged; this stricter rule applies to unknown records.

If the sandbox was already destroyed and Railway cannot return a successful destroy, verify its destruction yourself in the **original** project and environment. Then explicitly confirm it in the CLI:

```sh
railway sandbox list --project <original-project> --environment <original-environment>
vapi swarm forget-run research <runId> --confirm-destroyed
```

`forget-run` refuses without the flag and refuses a running, starting, finished or stopped run. It accepts only an unknown/orphaned Railway run, including an orphaned sidecar without a run record. Before changing state, it prints the sandbox id, the recorded original project/environment and the scoped list command to check. Legacy records without scope say **not recorded** and print placeholders; identify the original scope yourself rather than relying on today's Railway link. Creation JSON scope fields, when present, are retained in the run handle. The command does not run Railway or infer destruction from a missing row. Listing is an aid for human verification; Railway CLI 5.30.1's list is not a complete automatic absence proof.

The retained run record becomes `forgotten` with `forgottenAt` and `confirmedBy: "cli"`; it no longer blocks dissolution. A matching sidecar is retired. An orphan-only sidecar first receives a blocking run record, so a failed final write remains unresolved and can be retried. No MCP forget tool or confirmation flag is exposed: agents can attempt a normal stop but cannot confirm away their money guard. The dissolution refusal names `vapi swarm stop` for live workers and the CLI confirmation command for unknown/orphaned ones.

Polls, stops, CLI confirmation and cleanup of an identified member share its lifecycle lock. A poll re-reads the run inside that lock before contacting Railway: an older `running` snapshot cannot move a stored `unknown` run to finished or overwrite stopped/forgotten state and confirmation. Start and stop use an internal refresh while already holding the lock. Cleanup re-reads the sidecar under that same lock, so a failed destroy cannot recreate an orphan after confirmation removed it. Lock contention leaves metadata unchanged and reports a busy member.

`--keep-sandbox` keeps a finished run's sandbox for inspection, with the member key still inside it. `vapi swarm runs` leaves a kept sandbox up and lists it as `kept`. `vapi swarm stop <name> --all`, or `vapi swarm stop <name> <runId>`, destroys it. Without that, it stays up until the idle timeout (30 minutes).

### Orphaned sandboxes

Every railway run has a sidecar file at `<home>/runs/<runId>.railway.json`, mode `0600`, where `<home>` is `~/.vapi` or `VAPI_HOME`. The CLI writes it before `railway sandbox create` and adds the sandbox id as soon as `create` prints one. The sidecar holds the run id, member, swarm, state, sandbox id and checkpoint, never a key, bundle or credential. It is deleted once the sandbox is destroyed.

The run registry writes a `starting` reservation before it launches a worker. The local adapter saves its process id before detaching. The Railway adapter saves its sidecar before create and copies the sandbox id into the reservation before remote execution. `vapi swarm runs` reconciles these references after a launcher crash. `vapi swarm stop` stops the recovered worker and clears the active reservation.

An unreconciled `starting` record remains fail-closed. After five minutes, `vapi swarm runs` exits with code 1 and names the terminal-only confirmation command. First use `railway sandbox list` to find and destroy any sandbox that may hold the member key. Then run `vapi swarm stop <name> <runId> --confirm-worker-stopped` to retire the matching id-less `creating` sidecar and clear the reservation under the member lock. The command keeps a mismatched sidecar, and sidecars with ids follow the normal destroy path. MCP does not expose this override. Never confirm while the worker may still run.

| Sidecar state | When                                                                              |
| ------------- | --------------------------------------------------------------------------------- |
| `creating`    | Before `create` returns, or `create` failed in a way that may have left a sandbox |
| `running`     | The member started in its sandbox                                                 |
| `orphaned`    | A destroy after a failed start failed, or was cut off by Ctrl-C or SIGTERM        |
| `kept`        | The run finished with `--keep-sandbox`                                            |

A sandbox becomes orphaned in three ways:

- `railway sandbox create` exits with an error, or prints no sandbox id; the sandbox may exist anyway, and the sidecar stays `creating`.
- The start fails after `create` (readiness, `exec`), and destroying the sandbox fails too; the error names the sandbox id and the `railway sandbox destroy <id>` command.
- Ctrl-C or SIGTERM arrives during the start. The CLI deletes the env file, records the sidecar, tries to destroy a known sandbox for up to 5 seconds, then exits on the signal.

A failed start also names the env file path if the CLI could not delete it, so you can remove it yourself.

`vapi swarm runs <name>` lists the sidecars of that swarm's members that no running run tracks, and every kept sandbox. Each row shows the member, run id, state (`orphaned` or `kept`), sandbox id and the command that destroys it. `--json` adds them as `sandboxes`.

```sh
vapi swarm runs research
vapi swarm stop research --all
vapi swarm stop research <runId>
```

`vapi swarm dissolve <name>` refuses while a Railway worker or sidecar may hold a member key, including unknown/orphaned records. It names the stop command and, for unresolved runs, the explicit CLI confirmation command. If a swarm file is gone anyway, `vapi swarm runs <name>` and `vapi swarm stop <name>` still work while runs or sidecars of that name remain.

`vapi swarm stop` retries the destroy for those sidecars and deletes each sidecar whose sandbox is destroyed. It exits with code 1 while any sandbox stays up. A sidecar without a sandbox id cannot be destroyed automatically, so find the sandbox yourself:

```sh
railway sandbox list
railway sandbox destroy <sandbox-id>
```

For a matching stale `starting` record, run its terminal confirmation command after the sandbox is gone. The confirmation retires that id-less sidecar with the reservation, so the member can start again.

A sandbox nobody destroys stops at the idle timeout (30 minutes), the last backstop. Until then its key can spend what the member holds. The 2.00 USDC balance limit is checked at key export; it does not restrict later deposits.

Railway authentication is whatever the `railway` CLI is logged into, or `RAILWAY_API_TOKEN`. vAPI never reads or stores Railway tokens.

## Example setups

A team can use one lead and two helpers. Funding during setup moves 5 USDC from `main` into the treasury and then applies the swarm policy.

```sh
vapi swarm create research --roles lead,helper,helper --fund 5 --from main
```

Competing agents use one member account each. The second command gives every trader the same task.

```sh
vapi swarm create traders --roles trader,trader,trader --fund 6 --from main --strategy even
vapi swarm run traders "Compare the same market and report one decision" --mode each
```

An earning member can pass excess revenue to its treasury. The treasury can pass its own excess to the owner.

```sh
vapi swarm create earners --roles earner
vapi accounts caps earners-earner-1 --ceiling 1
vapi accounts caps earners-treasury --ceiling 20
```

The member's excess above 1 USDC sweeps to `earners-treasury`. Treasury funds above 20 USDC sweep to the linked owner.

## What is safe

Swarms are non-custodial. Local runs keep keys on this device; the experimental Railway runtime exports each member key only with `--allow-remote-key`. Per-call caps, per-day caps, and ceilings limit each account separately. The treasury holds capital without an agent profile or loop.

Each registered action passes one policy gate before it runs. Every movement is written before signing with one nonce and two resolved addresses per leg. A rerun skips sent legs and resumes bound planned or unknown legs without replacing a live nonce. An older planned leg without address bindings fails closed before signing.

## What is not safe

A leaked member key can spend that member's on-chain balance. Revoking its owner link stops relayed transfers and Router access. Revocation cannot stop x402 payments that the leaked key signs itself.

## Recovery

Cloud backup can include profiles, swarms, open movements, and the transfer receipts needed to resume them. Backup plaintext keeps the stable version 2 movement shape and omits local address-binding fields. Restore changes each swarm's device field to the new device name. Each restored account must link again because link tokens are excluded.

If restored swarm state references a setup funding or allocation movement whose local file is missing, vAPI refuses to transfer again. Check the balances with `vapi swarm status <name>`, then add capital deliberately with `vapi swarm fund <name> <usd>` if needed.

See [Backup and recovery](backup-and-recovery.md) for size limits, skipped items, conflicts, and movement resume rules.

## Ask an AI assistant

Connect the vAPI MCP server before sending this prompt. The assistant can use `swarm.setup` and return each owner approval code. Approve the links before expecting every account to be ready.

```text
Set up a swarm called research with a lead and two helpers, fund it with 5 USDC from main, and show me the link codes to approve.
```
