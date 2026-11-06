# Changelog

All notable changes to the published `vapi-network` distribution and its four
scoped packages. The packages share one version and are released together.

## Unreleased

### Fixed

- Linux: removing an absent entry from the libsecret keyring no longer throws. `secret-tool clear` exits 1 with empty stderr when it matches nothing on some libsecret builds, and the store treated that as a failure — which broke `vapi login` with "The agent link could not be stored consistently" whenever the agent had no `router.balance` secret yet. A silent non-zero exit from `clear` is now treated as "nothing to remove", mirroring the existing `lookup` behaviour; a failure that comes with a stderr message still throws.

## 0.12.0 — 2026-10-30

### Added

- `vapi code install` configures detected Claude Code and Codex tools for vAPI Compute, with optional shell aliases. `vapi code uninstall` removes those settings while preserving other config content.
- `vapi claude` and `vapi codex` choose vAPI Compute or the tool's own login at launch, with explicit route, balance, model and account options. Sessions stay on the selected route until exit.
- Core and MCP building blocks for vAPI Desktop: `createVault()` without a first account, per-wallet `linkStates()`, a remote payment account that signs through a caller-supplied channel, and `VapiMcpServer.connect` with caller-supplied streams.

### Fixed

- Windows: secrets now reach Windows Data Protection. Every secret-store call used to exit without doing anything, so the device key was never saved and `vapi setup` failed with "Unable to decrypt the vault with this device key." A vault created this way cannot be opened: move `%USERPROFILE%\.vapi` aside and run `vapi setup` again, choosing `restore` if the account was funded.

### Notes

- Claude Code on vAPI Compute needs the Router's `/v1/messages` fix and prompt-cache pricing, live on vAPI production since v3.26.0.

## 0.11.0 — 2026-10-29

### Added

- The public `vapi-network` package ships `SKILL.md` with setup, discovery, payment and recovery guidance for agents.

- API search results can include registry health and cheaper or healthier alternatives, and inspected endpoints can include response schemas and example requests.
- CLI JSON and MCP results for search, inspect and pay include up to four hints naming next actions.
- `vapi search --include-outage` and MCP `call.search`'s `includeOutage` input request listings hidden by the hosted registry's default outage filter.
- API payment spend-cap refusals now use the typed `spend_cap_exceeded` error with attempted and limit amounts, a non-retryable MCP result, and command guidance when the limit can be raised.
- `vapi mcp install claude-code` registers the vAPI server through Claude Code's CLI, while `claude-desktop`, `cursor` and `codex` retain file-based setup.
- Partner listings can display the `failed_calls_free` badge ("Provider failures aren't charged") for APIs served through vAPI's hosted shim.

### Changed

- vAPI Call takes no fee. Providers are paid directly. Publishing now guides providers to set every endpoint's x402 `payTo` to the signed payout wallet before activation, without a splitter lookup or deployment step.
- Search and inspect show `No network fee` for zero basis points and the registry's label plus the computed percentage for legacy fees. The fee schemas continue to accept legacy 500-basis-point listings.
- Human search output shows health and alternatives, and inspect shows health and an example request when supplied by the registry.
- `vapi mcp install claude` remains an alias for Claude Desktop and prints a note naming the separate Claude Code target.
- Discovery pages accept any `rankingVersion` label, so a registry that re-ranks no longer breaks installed clients. Required before the registry ships `marketplace-ranking-v2`.
- The hidden-outage hint appears only when the registry reports `totals.hiddenOutage` above zero.

## 0.10.0 — 2026-10-28

### Added

- Every MCP tool has a title and annotations for read-only behavior, destructive actions, idempotency and open-world access.
- The MCP server identifies itself as vAPI Network with a title, website URL and light/dark icons. `server.json` lists the same icons for the MCP Registry.
- `call.search` and `call.inspect` support interactive MCP Apps results in Claude Desktop. Views load from the hosted asset route and fall back to text when offline.

## 0.9.7 (2026-10-26)

### Fixed

- `vapi publish <url>` lists a URL that is itself one payable endpoint. The registry answers such a URL in `endpoint` with no `operations`, which publish used to report as "no callable endpoint".
- `vapi publish` sends each endpoint's `metadataEvidence` from the probe back with the listing, so an endpoint with a request schema is no longer refused with HTTP 422.
- `--mode` is a hint: the registry accepts it and detects the kind of URL itself. Registries before 2026-10-26 refused it with HTTP 400 "Unrecognized key: mode".

## 0.9.6 (2026-10-23)

### Fixed

- The MCP server sees accounts created in a terminal while it runs. `wallet.list` re-reads `wallets.json`, and `wallet.use`, `call.pay`, `router.usage`, `router.chat`, `receipts.list`, `receipts.stats` and the other account tools look again before they refuse an unknown name, so a new account works without restarting the MCP client. The session's active account and the default in `wallets.json` are unchanged.
- `wallet.list` reports the current default from `wallets.json`, matching the `isDefault` marker on its rows.
- Re-reading the account list never wipes the vault key an in-flight payment is still signing with.

## 0.9.5 (2026-10-22)

### Added

- `vapi dashboard [--account <name>] [--no-browser] [--json]` opens or prints the My agents page on your vAPI dashboard and offers to link an unlinked account.

### Changed

- `vapi init`, `vapi wallet create` and `vapi mcp install` offer to link the new or default wallet to your vAPI dashboard in an interactive terminal. Press Enter to accept, or use `--no-link` to skip the prompt.
- Non-interactive runs print a login hint; JSON results include `linked: false` and a `next` link step when the wallet is unlinked. A failed link never fails wallet creation or MCP installation.

## 0.9.4 (2026-10-15)

### Added

- Paid calls accept a 1–300 second timeout through MCP `call.pay`'s `timeoutSeconds` input and CLI `vapi pay --timeout <seconds>`. The initial unpaid probe uses at most 30 seconds. Without an explicit timeout, the paid request uses the provider's advertised maximum clamped to 30–120 seconds, or 120 seconds when the provider supplies none.

### Changed

- Generated MCP client entries run `vapi-network@latest`, so a restarted client picks up the current release.

### Upgrade note

- Interactive CLI runs report when a newer release is available. The check is skipped for JSON, MCP server, CI and non-TTY runs, uses a daily cache, and adds at most 1.5 seconds. Update with `npm i -g vapi-network@latest`.

## 0.9.3 (2026-10-15)

### Fixed

- Search keeps MPP and unverified listings, and tolerates unfamiliar display metadata instead of dropping otherwise valid results. Unsupported payment protocols remain unavailable for payment.
- CLI setup and import help advertise Base and Arc. Solana listings remain searchable; inspecting or paying them returns `unsupported_network`.
- CLI, MCP and SDK payment results redact locally created payment authorizations reflected by a provider, including uncertain Solana settlements.
- SDK clients respect vault locks and expired sessions before subsequent payments while preserving injected-account and explicit-password access.
- Router rate limits return retry guidance without using paid balance or buying more Router balance. Budget exhaustion still permits the configured fallback.
- Phrase recovery scans through gaps until five consecutive addresses have no Base USDC. `--accounts <n>` restores a fixed count, and recovery reports how many addresses it scanned.
- Inspect documentation describes the registry's last observed quote; a fresh quote is fetched when paying.

## 0.9.2 (2026-10-15)

0.9.1 was never published to npm; 0.9.2 is the first npm release carrying its changes.

### Fixed

- `vapi search`, MCP `call.search` and the SDK no longer fail on a discovery page with a Solana row. Mirrored rows accept any CAIP-2 network; bare `solana` and `solana-devnet` normalize to CAIP-2.
- One malformed discovery row is dropped instead of failing the page, with the count recorded as `dropped` in `searches.jsonl`.
- Service endpoints accept Solana payment metadata.
- An account without a Solana signer never selects a Solana quote, so a Solana-only `402` fails at quote selection instead of reserving spend that could not be signed.

### Changed

- `vapi inspect`, `vapi pay`, `call.inspect` and `call.pay` on a Solana listing (by its payment network, or a service whose declared networks are all Solana) return `unsupported_network`.

### Known limitations

- Solana payments from the vault arrive in a later release.

### Upgrade note

- Clients ≤ 0.9.0 fail every search whose results include a Solana row. Update to 0.9.2 with `npm i -g vapi-network@latest`.

## 0.9.1 (2026-10-13)

### Fixed

- MCP `tools/list` omits non-object `outputSchema`s, including those on `auth.status` and `swarm.run`. Claude Desktop rejects their union schemas.
- MCP `tasks.post` accepts an optional `vendor` address and sends it as `invitedProviderAddress`.
- Proposal and bounty submission payloads sign the lowercased `providerAddress` to match server canonicalization for `vapi task propose` and `vapi task submit`.
- Task errors surface JSON `code`/`message` or normalized plain-text bodies capped at 300 characters as `code: message`. `VAPI_DEBUG_HTTP` is removed, and `401`/`403` response bodies stay hidden.
- Signed-in `vapi task status` and `tasks.status` read `GET /v1/work-orders/:id/chain-state` and `GET /v1/work-orders/:id/events`. Either missing route is named in the error.
- Worker escrow creation through `sign`, plus `fund`, `deliver` and `release`, waits for vAPI to index chain results and reports the confirming `blockNumber` when available. CLI `--no-wait` and `--timeout` control the default 120-second polling limit; MCP `wait` controls a 60-second polling limit.
- Indexing waits require the projected escrow state to advance; transaction hashes and delivery records alone do not finish a wait. Each poll is bounded by the remaining deadline, and polling failures preserve server error codes in CLI and MCP output.
- After an HTTP, network or timeout prepare failure, escrow creation, funding, delivery, release, refund, dispute, counter-evidence and unmatched resolution resume a matching server operation in `prepared`, `submitted` or `confirmed` state. Delivery recovery checks the recorded manifest, existing plan and receipt checks still apply, and the chain executor never calls `abandonOperation`. Ambiguous escrow creation recovery refuses to select a milestone.

### Changed

- MCP task money-tool descriptions describe executing the user's own instruction with the user's vault wallet. Funding copy keeps the configured spend policy and approval-threshold refusal; dispute and counter-evidence copy keeps task and daily caps and `approval:true`.

### Known limitations

- A participant-masked `/events` response of `Work order not found` returns `events: null` and `nextAfter: null` while preserving the available chain state.
- A polling error still fails the command or tool after a confirmed transaction; it never repeats the chain mutation.
- Authentication errors may include sign-in or scope guidance, and chain errors include the HTTP status beside the code.

## 0.9.0 (2026-10-12)

### Added

- Public documentation access through core `searchDocs`, `readDocs` and `askDocs`, the SDK client's wallet-free `docs` namespace, `vapi docs` commands, and the read-only MCP tools `docs.search` and `docs.read`.
- `vapi task sign`, `fund`, `deliver`, `release`, `refund`, `dispute`, `counter-evidence`, `resolve-unmatched` and `watch --auto-release` sign scopes and broadcast chain operations with the local vault key. MCP tools `tasks.sign`, `tasks.fund`, `tasks.deliver`, `tasks.release`, `tasks.refund`, `tasks.dispute`, `tasks.counter-evidence` and `tasks.resolve-unmatched` expose the same local signer operations.
- Task chain operations trust a locally pinned escrow factory, verify every prepared plan before signing and wait for two confirmations. Base Sepolia pins `0x6Ba83621eb386B3E093032096251cA504F6ee033`, reads `BASE_SEPOLIA_RPC_URL` and accepts a local factory override through `VAPI_TASKS_ESCROW_FACTORY_<chainId>`. Scope terms are recomputed locally before signing. The acting role is derived from the order's client address and accepted proposal, never from the server's role label. Pending transactions are recorded under `VAPI_HOME` for recovery, and chain mutations are never retried automatically.
- `vapi task sign` shows direction, counterparty, amount and deadline before signing and requires `--yes` or interactive confirmation. A non-interactive run without `--yes` exits `3` without signing or creating a local party binding. MCP `tasks.sign` requires a human-supplied `counterparty` and returns `counterparty_required` without it, so it cannot create a binding or authorize funding without that confirmation.
- Money actions require a scope signed on this machine. `--counterparty` only confirms the existing local binding and cannot import a scope signed elsewhere. The per-task spend cap is the running total of escrow funding and dispute fees reserved for each task, and funding retries reuse one spend reservation per milestone.

### Known limitations

- Dispute and counter-evidence pay the verified contract fee under the local spend policy.
- The pinned Base Sepolia factory predates escrow V2, so V2 dispute actions refuse until a V2 deployment is pinned in a later release.

## 0.8.0 (2026-10-01)

### Added

- Backup plaintext version 2 adds account ceilings, Router refill settings, agent profiles, swarms, open movements and matching transfer receipt revisions. Oversized backups drop agents, then swarms, then movements and receipts without dropping account policy, and uploads report dropped sections in `omitted` with a 64 KB warning.
- Core `planAllocation` supports `weights` and `targets` strategies: weights use a largest-remainder split, targets top members up or sweep them down to a target, and legs that do not fit are returned as blocked with a reason.
- Movements can contain legs from more than one sender. New version 2 legs record the resolved sender and recipient addresses before signing. Older movement files remain readable and signed nonces can still resume. Resume recovers legacy addresses from immutable signed journal evidence. An unsigned local legacy leg requires the terminal-only `--bind-legacy-addresses` review before it can bind current names and sign.
- `vapi accounts distribute --cancel <id>` terminates eligible unsent movement legs without signing. It reconciles sent evidence, requires on-chain expiry for signed authorizations, releases eligible expired reservations, and remains unavailable through MCP. Restored legs still refuse cancellation by default. After balance and explorer review, terminal-only `--replace-expired-restored` cancels an unjournaled restored leg or a signed restored leg with proven expiry. Pending authorizations and failed chain checks refuse the whole command without changing the movement or spend ledger. Version 2 backup and restore preserve cancelled legs as terminal.
- Ceiling sweeps and core transfers can sweep to an account's treasury through `sweepParent` and `resolveParent`; without a parent, they still go to the owner.
- `accounts.send` is declared once in the action register and passes the policy gate; agent profiles cannot move money between accounts yet.
- Core swarm lifecycle APIs create resumable treasuries and member accounts with local caps, ceilings, profiles and links. Member profiles default to the Router model `venice/claude-sonnet-5`; `--model` overrides it.
- Version 1 swarm state records role targets and weights without storing balances, keys, phrases or tokens.
- Swarm fund, rebalance, leave and dissolve operations move `vAPI` capital through resumable movement journals.
- MCP tools `swarm.setup`, `swarm.add`, `swarm.leave`, `swarm.fund`, `swarm.rebalance`, `swarm.status` and `swarm.dissolve` expose the local swarm lifecycle.
- `vapi swarm` commands create, add, remove, fund, rebalance, show status for and dissolve local swarms.
- Swarm setup funding and allocation intent are journaled in `swarm.json`, so setup retries re-plan from current members and ceilings without funding twice or retrying terminal blocked legs.
- Agent profiles can grant `read`, `delegate` and `allocate`; swarm setup gives leads all three grants and other members the `read` grant.
- The agent-only `call.read` action sends GET requests to origins paid in the current run, supports SIWX sign-in, never pays and is refused outside agent runs.
- Core `createRunBudget` and `vapi agent run --budget <usd>` apply one hard limit across Call payments and Router top-ups, with the `run_budget` stop reason when a top-up exceeds it.
- Agent runs put run ids on receipts and audit records and return the id as `runId` with run-budget usage when configured.
- `vapi swarm run` and MCP `swarm.run` run either the lead or each eligible member under local run budgets and a per-run treasury draw.
- Agent actions `swarm.allocate` and `swarm.delegate` are grant-gated, available only inside a swarm run, draw-limited, and restrict delegation to one level.
- Core `allocateFromTreasury` moves run-scoped capital from a swarm treasury under the treasury policy and draw limit.
- `swarm.allocate` and `swarm.delegate` are idempotent per request (`<runId>:<toolCallId>`): a retry returns the recorded movement or resumes it, never sends twice, and conflicting reuse is refused with `request_conflict`.
- A delegated budget that was sent before its child started now starts the child from the recorded amount when the request is retried.
- The Swarms guide covers the domain model, capital flow, CLI and MCP lifecycle, example setups, safety limits and recovery.
- The MCP `Runtime` seam stores secret-free run records at `<VAPI_HOME>/runs/<runId>.json` with mode `0600`.
- The local runtime starts detached child processes and writes their output to `runs/<runId>.log`.
- `vapi swarm run --detach`, `vapi agent run --detach` and `--runtime local` start background work.
- `vapi swarm runs` lists background work, and `vapi swarm stop` signals one or all registered run handles; the local runtime only signals a process group whose leader is still the run it started.
- `vapi swarm status` includes running detached work for each member.
- `--result-file` records a run's final JSON result, and `VAPI_RUN_ID` supplies the validated run id to a child process.
- MCP `swarm.run` accepts `detach`, and the read-only `swarm.runs` tool reports stored run status.
- Detached starts refuse a second active run for the same member with `member_busy`.
- Experimental: `vapi swarm run <name> "<task>" --mode each --runtime railway --checkpoint <name> --allow-remote-key [--budget <usd>] [--keep-sandbox]` runs each swarm member in its own Railway sandbox booted from a checkpoint (`VAPI_RAILWAY_CHECKPOINT` is the fallback). Every member must hold a target of at most 1.00 USDC and an effective ceiling of at most 2.00 USDC, or nothing starts; the treasury, lead mode and accounts outside a swarm are refused; a terminal must type the swarm name to confirm. `VAPI_NO_SECRETS` and the agent markers refuse it as they refuse `vapi export-key`. The CLI waits for a new sandbox to answer before it starts the member. `vapi swarm runs` destroys a finished run's sandbox unless `--keep-sandbox` was set, and `vapi swarm stop` destroys it, kept or not. `vapi agent run --detach --runtime railway` is refused.
- Railway runtime (experimental): a member bundle carries only that member's key, short-lived access token, Router credentials and credential-free client config. The owner's refresh token, RPC URLs and API key stay local. The EVM key still controls every asset at that address on every chain, so remote members must use dedicated accounts.
- Railway runtime (experimental): the CLI checks canonical USDC on Base mainnet, Arc mainnet and Arc testnet before export, taking only the RPC URL from configuration. The swarm-network balance must be at most 2.00 USDC, every other known-network balance must be zero, and an unreadable mainnet balance refuses export. An unreadable Arc testnet balance is skipped unless Arc testnet is the swarm network, because testnet USDC has no value.
- Railway runtime (experimental): the confirmation shows the checkpoint and its source (`--checkpoint` or `VAPI_RAILWAY_CHECKPOINT`). A checkpoint name must be 1-64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. Only the confirmed members start.
- Railway runtime (experimental): an each-mode start is all or nothing. If one member fails to start, the members that command already started are stopped. The error keeps its class and `code` in `--json` output.
- Railway runtime (experimental): a `0600` sidecar at `<home>/runs/<runId>.railway.json` is written before `railway sandbox create` and kept while a sandbox may hold a key. A failed create, a failed destroy, or Ctrl-C/SIGTERM during the start leaves it `orphaned` or `creating`; `vapi swarm runs <name>` lists those and kept sandboxes with their destroy command, and `vapi swarm stop <name> --all` or `stop <name> <runId>` retries the destroy. SIGINT/SIGTERM during a start deletes the env file and tries a bounded destroy before exiting.
- Railway runtime (experimental): a sandbox counts as gone only on a not-found for that sandbox or a 404 naming its id and nothing else; a project, environment, token or workspace not-found is an error. Any other destroy failure keeps the run `running`, and `vapi swarm stop` exits 1.
- Railway runtime (experimental): `vapi swarm dissolve` refuses while a railway run of the swarm is running or a sidecar of the swarm exists. `vapi swarm runs` and `vapi swarm stop` still reach the runs and sidecars of a swarm whose file is gone.
- Railway runtime (experimental): `VAPI_NO_SECRETS` and the agent markers are read from the process environment as well as an injected SDK environment.
- Railway runtime (experimental): export is refused while a member has an unresolved ceiling sweep, unfinished movement leg or latest unknown transfer authorization. A later sent or failed receipt for the same wallet, network and nonce supersedes an earlier unknown receipt. Automatic ceiling sweeps are disabled in the headless sandbox, so it cannot sign a second sweep nonce.
- Railway runtime (experimental): each start permanently reserves the smaller of its run budget and remaining daily allowance in the owner's local spend ledger. The remote per-day cap and run budget equal that reservation until the next UTC midnight. Payments and Router top-ups are refused after expiry, and remote EIP-3009 signatures never remain valid past it. Zero remaining allowance refuses launch, and reservations are not released automatically because remote spend is not reconciled back.
- Railway runtime (experimental): a detached child revalidates that its profile wallet is the named member of the named swarm. A treasury or another member's wallet is refused before dependencies are constructed.
- Railway runtime (experimental): run records reserve a member with `starting` before worker launch, then save the local process id or Railway sandbox id before launch continues. List and stop reconcile an interrupted start from that reference. A stale unreconciled start remains blocked and, after five minutes, names the terminal-only `vapi swarm stop <name> <runId> --confirm-worker-stopped` command. After the owner confirms the worker is gone, that command retires the matching id-less `creating` sidecar and clears the reservation under the member lock. Sidecars with ids keep the destroy-then-clear path, and MCP cannot invoke the override. Starting sidecars participate in stranded-sandbox cleanup.
- Railway runtime (experimental): an expired remote access token fails with a new-run instruction and never rotates the owner's credentials.
- Railway cleanup failures retain sanitized status detail. `vapi swarm runs` includes it in JSON, prints a human warning and exits with code 1 while the run remains `running`.
- Detached-run mnemonic redaction checks every overlapping 12-word and 24-word window, including phrases embedded in prose.
- `vapi agent run --bundle-env <VAR> ("<task>" | --task-base64url <text>)` runs one member headless from a member bundle in an ephemeral home with an in-memory secret store, and removes the home when the run ends.
- `@vapi-network/core/secrets` exports `exportMemberKey` and the member bundle (`createMemberBundle`, `openMemberBundle`), which carries one member's key, link credentials, caps and profile without `delegate` and `allocate`, and never the recovery phrase or another account's credentials.
- Core `memorySecretStore` keeps secrets in memory only, for headless homes and tests.
- The audit event `agent.remote_key_exported` records every member key sent to a remote runtime (once `railway sandbox create` ran, also when a signal cuts the start off), with the account and sandbox but never the key. `agent.remote_key_refused` records each refused export, with the account and the reason.
- MCP `swarm.run` with `detach` refuses every runtime except `local`, so a member key can only leave the machine from the CLI.

### Changed

- Version 2 restore rebuilds profiles, swarms with the new device name, open movements and matching transfer receipts. It reports skipped items and no-clobber conflicts, and changes a planned leg with a receipt to unknown so a signed leg resumes with the same authorization.
- Mutating swarm commands, account distribution, agent create, pause, resume and revoke, and automatic Router refill changes now request a best-effort cloud upload. Swarm changes and account distribution request one after failure, as do account and legacy wallet add.
- Agents may move treasury money only through `swarm.allocate` and `swarm.delegate`, and only while running inside a swarm run.
- A retried treasury request needs fresh draw only for the part not already reserved under that request.

### Fixed

- Account rename and remove now hold the same ordered account locks as capital signing across reference checks and every file mutation. Account-name mutations are independently serialized. Receipt appends, restore and migration writes, and account-name rewrites share one bounded journal lock, so a rename cannot erase another account's signed authorization. A busy account or journal fails with a retry instruction, and a late journal failure rolls the account rename back.
- Version 2 backup export verifies that every captured unknown or journal-signed failed movement leg has its matching receipt. It retries the whole snapshot up to three times when account, movement, or receipt files change, then refuses the backup before upload with a retry instruction.
- Swarm capital commands reconcile automatic ceiling sweeps before using the same sender. Automatic sweeps now share the movement executor's per-sender signing lock, reconcile signed movement legs under that lock, and skip while an authorization may still settle.
- Planned, unknown, retryable failed, journal-signed failed, and every restored nonterminal movement leg now share one open-leg predicate. Automatic ceiling enforcement and `vapi sweep` refuse to sign another sweep until the open leg becomes terminal.
- Every new movement binds each sender and recipient name to its resolved address. Planning, execution, generic distribution resume and the core transfer path refuse an address mismatch.
- Account removal and rename protect names referenced by planned, unknown, retryable failed, journal-signed failed, and restored nonterminal movement legs. A local terminal unsigned non-retryable failure no longer blocks the account name.
- Account removal and rename protect every account named by a movement while any leg remains open. A completed sender in a multi-sender movement stays protected until all legs become terminal.
- Legacy unbound legs use recorded signed-journal addresses when available. Without immutable evidence, resume prints both current addresses and requires the terminal-only `--bind-legacy-addresses` flag; the accepted binding appears in human and JSON results and remains unavailable through MCP.
- Interrupted swarm setup lowers spend caps and ceiling together under one registry lock. A concurrent owner reduction always wins over the planned setup values.
- Backup plaintext keeps local movement address bindings out of version 2. Restore requires the existing restored-leg review before it can rebind an unsigned leg, and the new `cancelled` status round-trips as terminal.
- Swarm funding and sweep amounts above the relay's 50 USDC per-transfer maximum are split into durable, resumable legs.
- Swarm `even` allocation gives remainder cents to the first member while retaining recipient ceiling checks.
- Restored swarm state now refuses to repeat setup funding or an allocation when its referenced movement file is missing, and directs the user to check balances before funding deliberately.
- Restored movement legs keep local provenance, including unfinished legs in matching or conflicting existing movement files and movements skipped for missing accounts or staging failures. A restored leg that is not proven sent, whether its authorization expired or it was never signed at backup time, now requires balance and explorer review plus the terminal-only `--replace-expired-restored` flag before vAPI signs it.
- `vapi restore --from-owner` can resume after publishing its vault or registry when an authenticated in-progress record proves that the retry uses the same backup. An unrelated vault is still refused after owner approval.
- Active CLI and MCP agent runs reload wallet caps before each Call payment, so a cap reduction applies without restarting the run.
- `call.read` redacts its generated SIWX header and signature from reflected response bodies, content types and errors.
- Interrupted delegation recovery reports spending and remaining budget as unknown instead of inventing zero spending.
- Vault-only version 2 backup sources now use the byte-identical version 1 plaintext path. Version 2 omits default account ceilings and restores an absent ceiling to the default.
- Backup size fallback now checks both the encrypted envelope and the owner restore relay payload against the 64 KB limit.
- Backup export now applies the normal agent profile defaults. Invalid profiles are reported as skipped, and the CLI warns for each one.

## 0.7.0 (2026-09-30)

### Added

- `vapi accounts --all` lists the owner's accounts on other devices as read-only rows.
- The MCP tool `vapi.siblings` and core `fetchSiblings` return the owner's linked accounts without returning keys, phrases or tokens.
- MCP tools `accounts.add` and `accounts.caps` create derived accounts and lower their local spend caps from chat.
- Trusted-device linking lets `vapi login` and `vapi accounts add` link within approved scopes and allowances without another approval.
- The `device` configuration field and `VAPI_DEVICE` environment variable set the name sent with link requests.
- `vapi send` and core `transferBetweenAccounts` move USDC from a linked account to the owner or another active account through a gas-paid relay.
- The MCP tool `accounts.send` applies account caps to transfers requested from chat.
- Core `releaseSpend` releases a transfer reservation when the relay confirms that no money moved.
- `vapi accounts distribute` splits one amount across local accounts, records every leg before signing, and resumes unfinished movements without replacing their nonces.
- Account ceilings default to 5 USDC on Base. Settled paid calls and the status screen return excess funds to the linked owner, with the per-day cap as the sweep floor.
- The status screen shows each ceiling, explains when the per-day floor applies, and prints a resume command for each unfinished movement.
- MCP `accounts.caps` can lower `ceilingUsd`. Raising or disabling the ceiling stays in the terminal and refused calls leave storage unchanged.
- `@vapi-network/core/backup` exports backup key derivation, envelope creation and opening, relay sealing, vault export and restore functions.
- The version 1 backup envelope authenticates its ordered header and encrypts the vault plaintext with AES-256-GCM.
- Owner keys use repeatable EIP-712 signatures with HKDF-SHA256 or a probed password fallback with scrypt.
- X25519 sealed boxes and a 60-bit relay code carry opaque backup envelopes through the relay.
- Deterministic vectors cover signature, password and relay encryption paths across implementations.
- MCP lint rules forbid direct or relative imports of the backup entry point.
- `vapi backup --cloud` enrolls a device and uploads its encrypted vault envelope. `vapi backup --cloud off` removes the local backup key and stops later uploads.
- `vapi restore --from-owner [--owner]` restores an owner-approved cloud backup on a new device.
- `@vapi-network/core/cloud-backup` exports `startRelay`, `awaitRelay`, `storeBackupKey`, `readBackupKey`, `forgetBackupKey`, `uploadBackup` and `restoreFromOwner`. MCP lint rules forbid importing this entry point.

### Changed

- `call.search`, `call.inspect` and `call.pay` are declared once in an action register (`@vapi-network/mcp` `actions`, `runAction`, `checkAction`). The MCP tools, the agent loop's tools and `vapi search`, `vapi inspect` and `vapi pay` all run through it, and every paying action passes one policy gate. Tool names, schemas, outputs and messages are unchanged.
- `AgentProfile["tools"]` is typed `string[]`; `createAgentProfileSchema(toolNames)` builds the schema from a tool list, and profile validation still rejects any name outside it (`DEFAULT_AGENT_TOOLS` in core, the register's names in the CLI and the `vapi-network` client).
- Interactive `vapi setup` now offers cloud backup after the vault exists. `--no-cloud-backup` and non-interactive setup skip the offer.
- Successful account create, import, rename, remove, restore, caps, default and link commands now request a best-effort cloud upload with a 10-second bound.
- The status screen now shows whether cloud backup is on and the last successful upload time.
- Local backup restore and owner-approved restore now share the validated `restoreBackupPlaintext` write path.
- Account link requests now reuse an eligible linked account for trusted-device approval before showing the owner approval flow.
- `WalletStore.setSpendCaps` now throws `KeystoreError` for an account that is not in the registry instead of silently skipping the write.
- Receipts can carry `kind: "transfer"` with the transfer outcome and relay details.

### Fixed

- Vault-only version 2 backup sources now use the byte-identical version 1 plaintext path. Version 2 omits default account ceilings and restores an absent ceiling to the default.
- Backup size fallback now checks both the encrypted envelope and the owner restore relay payload against the 64 KB limit.
- Backup export now applies the normal agent profile defaults. Invalid profiles are reported as skipped, and the CLI warns for each one.
- `vapi` installed with `npm i -g` (a symlink in the global bin directory) now runs; before, it exited 0 without output because the entry check compared the symlink path with the resolved module path.

## 0.6.0 (2026-09-29)

### Added

- The device vault stores `vault.json`, one recovery phrase, derived and imported accounts, and the device key in the OS secret store.
- `vapi accounts` lists, derives, imports, renames, selects, removes, restores and caps local accounts.
- Bare `vapi` prints the status screen with the home, owner, vault, accounts and next commands.
- `vapi setup` creates or restores the vault, derives `main`, and links the first account to the owner wallet. It can run again to fill missing state.
- `vapi vault protect|unprotect|lock|unlock|status` manages vault password protection and sessions; `VAPI_VAULT_PASSWORD` supplies the password for non-interactive runs.
- `vapi restore` rebuilds a vault from a recovery phrase and derives accounts from the phrase.
- `vapi mcp install <claude|cursor|codex>` writes a client MCP configuration with the server home and registry.
- MCP registers `vapi.status` and `vapi.accounts`; the first returns the status report and the second returns the account list.
- `createVapiClient({ account })` selects a vault account or accepts an injected payment account.
- The OS secret-store layer supports macOS Keychain, Windows Credential Manager through DPAPI, and Linux libsecret.

### Changed

- `--account` replaces `--wallet`. Selection uses `--account`, then `VAPI_WALLET`, then the default set by `vapi accounts use`.
- Bare `vapi` shows the status screen instead of help.
- Missing arguments print one usage line, such as `Usage: vapi accounts add <name> [--label <text>] [--no-link] [--json]`.
- On first run, 0.5 keystores are imported as accounts and the old files move to `wallets.migrated/`.

### Deprecated

- `--wallet` is deprecated; use `--account`. It keeps working for one release.
- `VAPI_KEYSTORE_PASSWORD` is deprecated for vault passwords; use `VAPI_VAULT_PASSWORD`.
- `vapi wallet ...` is deprecated; use `vapi accounts ...`.
- Top-level `vapi unlock` and `vapi lock` are deprecated; use `vapi vault unlock` and `vapi vault lock`. The old names work for one release.
- `createVapiClient({ wallet })` is deprecated; use `createVapiClient({ account })`. The option remains accepted until 0.7.

## 0.5.1 (2026-09-28)

### Fixed

- The OS secret store now starts the keychain tool in its own session. On macOS, `security -w`
  reads the value from the terminal whenever the process has one, so an interactive `vapi unlock`,
  `vapi login` or a token refresh showed the tool's own "password data for new item" prompt and stored
  whatever was typed there instead of the value the client sent. Every keychain write now goes over
  the pipe, in a terminal or not.

## 0.5.0 (2026-09-25)

### Added

- `vapi login`, `vapi logout` and `vapi whoami`: link a local agent wallet to
  your vAPI account. The wallet signs a sign-in message, you approve the link
  in the console with your own wallet (any provider) and set a daily vAPI
  Router allowance, and the agent's tokens and Router key are stored in the OS
  secret store under the wallet name, never in a file. `whoami` asks the
  console whether the link is still active. Agents hold rights on your account,
  never on your wallet; `vapi sweep` with no address sends funds back to the
  linked owner.
- `vapi router models`, `vapi router usage`, `vapi router chat` and
  `vapi router key --rotate`: use vAPI Router from a linked wallet, paid from
  the owner's daily Compute allowance. The Router key is sent only to the
  Router host stored with the link and is printed only on a real terminal.
- `vapi router buy <1|5|20|50>` buys prepaid Router balance with USDC over
  x402 from the agent wallet, within its spend caps, and stores a balance key.
  Chats use Compute first and the bought balance once Compute runs out;
  `vapi router buy --auto <tier> --below <usd>` refills automatically, still
  within the per-day cap. `vapi router usage` shows the balance.
- `vapi stake status` shows the owner's stake and today's Compute; `vapi stake
open` opens the console's stake page. Staking itself stays in the console.
- `vapi agent create`, `run`, `list`, `pause`, `resume` and `revoke`: a small
  agent that runs on your own machine, thinks with vAPI Router and pays for
  APIs on vAPI Call from its own capped wallet. Tool output reaches the model
  only as untrusted data; it pays only verified listings it found in the same
  run, asks above a price threshold, and stops when a settlement is uncertain,
  a budget runs out, or after twelve steps. Every step is in the audit log.
  `examples/agent-researcher.md` walks through a run.
- MCP tools `auth.link` and `auth.status` (link from Claude, Cursor or Codex;
  the owner still approves in the browser) and `router.models`, `router.usage`,
  `router.chat` and `router.buy`. No tool ever returns a key.
- `createVapiClient` in the `vapi-network` package: the same pieces in code,
  including `router.openai()` for OpenAI-compatible frameworks and signing with
  an injected account on a server.
- `vapi publish` and `vapi claim` use the agent link when it carries
  `call.publish` and no API key is set.
- `vapi inspect` prints `On-chain identity:` and `Reputation:` lines when the
  registry reports an ERC-8004 agent for the listing; `identity` reaches
  `--json` and `call.inspect`. The client reads it from the registry and makes
  no chain call.
- `vapi whoami` prints `On-chain identity:` for the wallet: its ERC-8004 agent
  on Base and reputation, or `not registered`, read from the vAPI API at
  `/api/call/identity/<wallet>` with no chain call. `--json` carries `identity`;
  a failed lookup prints nothing and does not change the exit code.
- Every EVM and Solana x402 payment now carries the `builder-code` extension
  with the client code `vapi`. APIs that advertise `payment-identifier` receive
  one generated payment id, echoed with their extension metadata; receipts
  record it as `paymentId`, and `vapi pay --resume` shows it without paying or
  resubmitting.
- `vapi check` now lists known extensions advertised by a 402 offer. Missing
  Bazaar metadata is a warning because Bazaar and Coinbase for Agents use it to
  discover the API.
- `vapi check` recognises Stripe/Tempo's Machine Payments Protocol: a 402 whose
  `WWW-Authenticate: Payment` challenge replaces the x402 offer passes the
  `transport` rule with the `mpp` tag, and the JSON report's new `transport`
  field says `x402` or `mpp`. `vapi pay` cannot pay MPP.
- Arc mainnet is now a payable x402 network (`eip155:5042`) with the public RPC
  `https://rpc.mainnet.arc.io`; `ARC_RPC_URL` overrides it. Enable it with
  `vapi init --networks base,arc`, `vapi accounts --enable arc`, or the
  equivalent wallet create/import `--networks` flag. Setting `ARC_RPC_URL` also
  enables it. Arc sweeps retain 0.05 USDC for gas by default, configurable with
  `VAPI_ARC_GAS_HEADROOM_USDC`, and print transaction links at
  `https://explorer.arc.io`; missing-authorization receipt messages link the
  payer there as well.
- `vapi stats` now shows the network-wide amount routed through vAPI for 24h and
  30d in USD plus the 30d transaction count when the registry reports it. The
  figure covers all vAPI clients, not just the selected wallet.

### Changed

- `vapi check` now looks for OpenAPI beside the checked path and in each parent
  directory before `/openapi.json`. It then follows up to 10 same-origin
  `service-desc` links from `/.well-known/api-catalog`.
- `ARC_MAINNET_CAIP2_PLACEHOLDER` was replaced by `ARC_MAINNET_CAIP2`. The
  programmatic `getDefaultConfig` alias `arc` now means Arc mainnet; use
  `arc-testnet` for Arc testnet.

### Fixed

- The macOS Keychain stores values longer than 128 characters in parts (the
  `security` tool silently truncates its prompt), so agent tokens survive a
  restart. Short values are stored exactly as before.
- After the owner revokes an agent, every router, agent and login command ends
  in one sentence and exit code 1 instead of a stack trace. A sweep without ETH
  for gas names the address to fund.

## 0.4.0

Listing on vAPI became permissionless, so "is this listed?" stopped being a
useful question and "how far did vAPI review it?" took its place. The registry
now returns a verification tier on every listing, and the client's job is to
carry that tier all the way to whoever is about to spend money — one switch to
widen the search, one word on every result, and one line before an unverified
payment. Nothing is blocked; nothing is decided for you.

### Added

- `vapi publish <url>`: listing an API from the terminal. vAPI probes the URL —
  an origin, one endpoint, or an OpenAPI document — and prints every probe step;
  a refusal prints its code, reason and hint and exits `2` before anything is
  signed. You choose which of the endpoints it found to list, on a terminal or
  with `--select`/`--yes`, and the local wallet signs one EIP-4361 line,
  `Confirm this wallet receives vAPI Call payouts`, bound to the registry's host
  and to Base. The answer names the slug, the FeeSplitter address per network
  and the one step that stays in the console, because deploying the splitter is
  a wallet transaction. `vapi publish activate <slug>` takes the listing live,
  `vapi publish verify-request <slug>` asks for the review that ends the
  `[unverified]` tag, and `vapi publish list` shows what this key owns.
  `--json` emits the registry's raw responses.
- `vapi publish` handles large catalogs: more than 20 endpoints — the
  registry's cap per listing — become several listings of up to 20, named
  `Name (k/n)` in probe order, each with its own payout-line signature, and
  every endpoint gets a result line (`listed`, `failed`, `pending`, `skipped`).
  A batch refused on its merits does not stop the next; a rejected key, a rate
  limit or an outage does. `--resume` reads `vapi publish list` and skips every
  endpoint this key already lists, so a stopped run picks up where it ended.
  `--json` carries the created `listings` and per-endpoint `results`.
- `vapi claim <origin>`: the owner of an API vAPI indexed from a public
  catalog takes those listings over. vapi fetches the registry's EIP-4361 claim
  message for the local wallet, refuses to sign one that is not bound to the
  registry's host, this wallet, Base and that origin, signs it on the same path
  as the publish payout line, and prints the slugs it claimed. A wallet that is
  not the payee (403), an origin with nothing to claim (404) and listings that
  already have an owner (409) each get a sentence. Needs `vapi auth set-key`;
  like publishing, there is no MCP tool for it. Each claim writes a
  `listing.claim` audit line.
- `vapi check <url>`: a free, local x402 conformance doctor. It fetches the URL
  without paying, decodes the 402 from the v2 `PAYMENT-REQUIRED` header and the
  JSON body, and grades status, offer transport, declared version and its
  required fields, the `exact` scheme, canonical USDC on a known network,
  `payTo`, `maxTimeoutSeconds`, the origin's `/.well-known/x402` and
  `/openapi.json` `x-payment-info` — each pass, warn or fail with the
  registry's snake_case issue codes. `--json` returns one report; exit `0`
  when nothing failed, `1` when a rule failed, `2` for usage. No wallet, no
  payment, no registry call. The repository root is now also a composite
  GitHub Action, "x402 conformance check", with `url` and `fail-on`
  (`fail` | `warn`) inputs, running the published CLI's `check --json`.
- `vapi auth set-key`, `vapi auth status` and `vapi auth clear` for the registry
  API key. The key is typed on a prompt and never passed as an argument, is kept
  in the same OS secret store as the wallet passphrase — or in
  `~/.vapi/config.json` at mode 0600 where there is none — and is masked
  wherever it is reported. `VAPI_API_KEY` overrides both, for CI. It lives
  behind `@vapi-network/core/api-key`, which `packages/mcp` is lint-forbidden to
  import: there is no publish tool and no agent path to a provider credential.
- `verification` on every discovery hit and every service record, one of
  `"none"`, `"requested"` or `"verified"`. A registry that predates the tier,
  or one that starts sending a tier this client does not know, reads as
  `"none"` — the client never invents an endorsement. Rows mirrored from an
  external catalog are always `"none"`.
- `vapi search --include-unverified` and the `includeUnverified` argument on
  `call.search`: the one trust switch. Without it, results are vAPI-verified
  listings plus the mirrored external catalogs; with it, self-listed APIs that
  passed vAPI's automated x402 probe but were never reviewed are returned too.
  Only the opt-in is sent to the registry.
- `vapi search` tags every result with its tier next to its group —
  `[verified]`, `[requested]`, `[unverified]`, or `[external]` for a mirrored
  row, which is never repeated when the group already says `external`.
- `vapi inspect` prints a `Verification:` line and the network fee label above
  the record, and `vapi pay` prints one line naming the tier before the result
  when the listing it just paid was not verified. Neither prompts nor blocks.
- `verification` in `--json` on `search`, `inspect` and `pay`, and on the
  `call.search`, `call.inspect` and `call.pay` MCP results.
- `vapi pay --resume <receipt-id>`: after a paid call lost its response, asks
  the receipt's token contract, with EIP-3009 `authorizationState(authorizer,
nonce)`, whether the signed authorization was used — `settled` (do not pay
  again), `expired` (never used and past `validBefore` by chain time, so paying
  again is safe) or `pending` (wait until the time it prints). It unlocks no
  wallet and signs nothing. EVM only; a Solana receipt says it is not supported
  yet. Receipts now record `authorization: { from, nonce, validBefore }` for
  every EVM payment they sign; older receipts parse unchanged and are named as
  predating it. Every `settlement_unknown` "do not retry automatically" message
  from `vapi pay` and `call.pay` now ends with the exact `vapi pay --resume`
  command for its receipt.
- `vapi inspect` prints a `Liveness:` line — uptime over seven days of hourly
  re-probes, p50 and p95 latency — and a `Conformance:` line — declared x402
  version, whether the 402 follows it, where the offer travels, issue codes —
  when the registry sends `liveness` and `conformance`. Both are optional on
  every discovery hit and service record, reach `--json` and `call.inspect`
  unchanged, and a malformed value reads as absent rather than failing the
  listing.
- `includeUnverified` on `discover()` and on the `Source.search` seam, and
  `verification` on core's `Listing`. Sources that have no notion of vAPI
  verification ignore the option and claim no tier.

### Changed

- `call.pay`'s tool description now tells an agent to prefer a verified listing
  and to read the request contract and the price with `call.inspect` before
  paying one that is not.
- Resolving one exact ref — `vapi inspect`, `vapi pay`, and the registry
  source's `inspect` — always asks the registry for unverified listings too.
  Resolving a ref the caller already holds is not a browse, so the tier is
  disclosed rather than used to hide the answer.
- Every package, `scripts/pack-check.mjs`, `CLI_VERSION` and
  `VAPI_CLIENT_VERSION` move to 0.4.0.

## 0.3.0

Several wallets on one machine, a passphrase that no longer has to sit in an
editor's configuration file, and a hard line between what a person may see and
what an agent may.

### Added

- Several wallets on one machine. `~/.vapi/wallets/<name>.json` holds one
  keystore per wallet and `~/.vapi/wallets.json` records which wallet is the
  default, what each one may spend per call and per day, and its optional
  label. Names are 1 to 32 characters of lowercase letters, digits and dashes.
- `vapi wallet list|create|use|rename|remove|restore|caps` manages those
  wallets. `list` shows the address, the default marker, the caps in US
  dollars, whether the wallet is unlocked, and the label; `caps` takes
  `--per-call` and `--per-day` in dollars; `remove` asks you to type the wallet
  name and prints where the keystore went.
- `--wallet <name>` on every command that touches a wallet, with `VAPI_WALLET`
  and the machine default behind it. Each of those commands names the wallet it
  used: `Wallet: <name> (<address>)` on the first line in text mode, and a
  `wallet` field in `--json`. `vapi receipts` and `vapi stats` show the selected
  wallet and take `--all-wallets`; `vapi import` writes a named wallet.
- Spend caps belong to the wallet, not to the machine, so an agent wallet can be
  given a small daily allowance while your own keeps a large one. Today's totals
  are counted per wallet in `spend-ledger.json`; rows written before named
  wallets count as `main`.
- Receipts record the wallet that paid. `receipts.jsonl` rows gain an optional
  `wallet` field, rows written before named wallets read as `main`, and renaming
  a wallet rewrites its rows in one atomic replacement.
- Removing a wallet is a move, not a delete: the encrypted keystore goes to
  `~/.vapi/wallets/.trash/`, where `vapi wallet restore` can bring it back. The
  default wallet is refused until another one is made the default, and a wallet
  that still holds USDC is refused unless you force it.
- `vapi unlock [--wallet <name>]` and `vapi lock [--wallet <name> | --all]` keep
  a wallet's passphrase in the OS secret store instead of in an editor's
  configuration file: the macOS Keychain through `security`, or libsecret
  through `secret-tool` on Linux, under the service `vapi-network` and the
  wallet's name. `unlock` runs only on a real terminal with no agent marker set,
  and verifies that the passphrase actually opens the wallet before storing it.
  The passphrase is handed to the OS binary over stdin, never as a command-line
  argument, so it never appears in `ps`. No new dependency. Windows keeps
  `VAPI_KEYSTORE_PASSWORD` until there is a Credential Manager path.
- `wallet.list` and `wallet.use` on the MCP server. `wallet.list` returns every
  wallet with its address, label, spend caps in both atomic USDC and US dollars,
  USDC balances, and which one is the default and which one the session pays
  from; a wallet whose RPC is unreachable reports `balanceError` and the rest of
  the list still answers. `wallet.use` points the session at another wallet for
  the lifetime of that process only — it never writes `wallets.json`, so the
  default a human chose in their terminal is untouched.
- An optional `wallet` argument on `wallet.address`, `wallet.balance`,
  `wallet.accounts`, `wallet.fund`, `call.pay`, `receipts.list` and
  `receipts.stats`. Without it the session's active wallet is used, then
  `VAPI_WALLET`, then the machine default. Every tool result now carries the
  `wallet` field it used, `call.pay` applies that wallet's own spend caps and
  tags its receipt with its name, and `receipts.list` and `receipts.stats`
  filter by it or take `allWallets: true`.
- An agent can no longer be shown a secret. `vapi backup` and `vapi export-key`
  run only when stdin and stdout are a real terminal, no agent or CI marker is
  set (`VAPI_NO_SECRETS`, `CLAUDECODE`, `CLAUDE_CODE`, `CURSOR_AGENT`,
  `CODEX_SANDBOX`, `OPENAI_CODEX`, `AGENT`, `CI`), and the person types the
  wallet name to confirm. Otherwise they print nothing and say so. `vapi init`
  and `vapi wallet create` still create the wallet and point at `vapi backup`.
- `~/.vapi/audit.log` (mode 0600) gets one JSON line per secret export, per
  wallet change and per MCP session wallet switch: time, event, wallet, whether
  a terminal was attached, and the agent marker that was set. It never contains
  the secret itself.
- `@vapi-network/core/secrets`, a separate package entry point for the functions
  that return a recovery phrase or a private key: `exportRecoveryPhrase`,
  `exportKeystoreKeys`, `createKeystoreWithPhrase` and `decryptPrivateKey`.
- `examples/wallets.ts`, which lists, creates and re-caps wallets through the
  SDK. Both examples are type-checked by `pnpm typecheck`.

### Changed

- Every unlock resolves its passphrase the same way, in one place:
  `VAPI_KEYSTORE_PASSWORD` first, then the OS secret store entry for that
  wallet, then a prompt on a terminal. A run with none of the three names both
  other routes, including `vapi unlock`, instead of only the environment
  variable. A stored passphrase that no longer opens its wallet says exactly
  that and points at `vapi unlock`; `vapi passphrase` removes the stored copy
  when it changes the passphrase, so a stale entry cannot outlive it. The SDK
  entry point is `resolvePassphrase` in `@vapi-network/core`.
- The MCP server no longer pays from one account unlocked at startup. It
  resolves the wallet a tool call names and unlocks that wallet for that one
  payment, so `wallet.use` actually changes which key signs. Reads — addresses,
  balances, accounts and funding links — need no passphrase at all. An agent is
  never prompted.
- `vapi init` on a machine that already has a wallet is no longer an error: it
  says nothing was created and lists the wallets it found, without asking for a
  passphrase.
- `vapi import` writes a new named wallet instead of replacing the only one.
  `--wallet <name>` chooses it, and `main` is assumed only on a machine that has
  no wallet yet. `--replace` moves the named wallet to `wallets/.trash/` first,
  still refusing a wallet that holds USDC unless `--force`.
- `vapi wallet list` gained an `UNLOCKED` column, and `unlocked` in `--json`:
  which wallets an agent can pay from without being given a passphrase.
- `vapi mcp` takes `--wallet <name>`, which the help text now lists, and `vapi
help` is listed alongside `vapi version`.
- The README is rebuilt around the current surface: a quickstart in the order
  `vapi init` itself prints, one table for every CLI command and flag, one table
  for every MCP tool, and the SDK's two entry points side by side.

### Deprecated

- The pre-namespace MCP tool aliases `search`, `inspect`, `call` and `wallet`
  still work and still behave identically to `call.search`, `call.inspect`,
  `call.pay` and `wallet.balance`, and each result carries one `DEPRECATED:`
  line naming its replacement. They will be removed in a later release.
- `~/.vapi/keystore.json` survives the 0.3.0 migration as a mode 0600 symlink to
  `wallets/main.json`, for one release only. Scripts that read it directly
  should move to `wallets/<name>.json` or to `WalletStore`.

### Removed

- `createOnrampSession` and its `OnrampSession` and `CreateOnrampSessionOptions`
  types, deprecated in 0.2.5. The session token it minted was single-use and
  expired minutes later, so a link printed in a terminal was usually dead before
  anyone clicked it. `fundingPageUrl` — which `vapi fund` and `wallet.fund`
  already use — mints the session at click time instead.
- `openWallet` and `listReceipts` from `@vapi-network/core`. Nothing called
  either; `openWallet` also defaulted to the legacy `keystore.json` path, which
  is now a compatibility symlink. Use `WalletStore.open(...).unlock(name, …)`
  and `readReceipts`.

### Migration from 0.2.x

Nothing to do by hand. The first command you run on a 0.2.x home migrates it
once, when the wallet store is opened: `keystore.json` moves to
`wallets/main.json` with its contents untouched, `config.json`'s spend caps
become the caps of the wallet `main`, and `keystore.json` stays behind as a mode
0600 symlink for one release so existing scripts keep working. A home without a
keystore migrates nothing, and no keystore file is ever rewritten.

Receipts written before this release have no `wallet` field and read as `main`,
so `vapi receipts` and `vapi stats` show your history unchanged. Spend caps now
live on the wallet rather than in `config.json`; set them with `vapi wallet caps
<name> --per-call <usd> --per-day <usd>`. `VAPI_KEYSTORE_PASSWORD` is still
honoured, and is still checked first — `vapi unlock` is the new option, not a
replacement.

## 0.2.5

### Added

- New wallets are created from a 12-word BIP-39 recovery phrase and stored as
  keystore version 3, which keeps the encrypted phrase instead of the derived
  keys. One phrase restores the Base account (`m/44'/60'/0'/0/0`) and the Solana
  account (`m/44'/501'/0'/0'`) in MetaMask, Rabby, Coinbase Wallet or Phantom.
  Keystores written by earlier versions keep working unchanged; they have no
  phrase, and `vapi export-key` stays their backup route.
- `vapi backup [--json]`: prints the recovery phrase for the local wallet, one
  numbered word per line on stdout with the warning on stderr, so it can be
  piped. A wallet created before recovery phrases is told so and pointed at its
  keystore file and `vapi export-key`.
- `vapi import --phrase [--networks <base,solana>] [--replace] [--force]`:
  restores a wallet from words typed at the prompt — never from the command
  line, where a shell history would keep them — under a new passphrase. An
  existing keystore is left alone unless `--replace`, which first moves it to
  `keystore.json.bak-<timestamp>`, and refuses outright while that wallet still
  holds USDC on Base unless `--force`. `vapi import --key` does the same with a
  0x-prefixed private key.
- `vapi passphrase [--json]`: re-encrypts the keystore under a new passphrase.
  The wallet, its addresses, and its recovery phrase are unchanged.

### Changed

- `vapi init` states the custody terms before it creates anything: vAPI has no
  copy of the key and cannot recover it. On a terminal it then shows the 12
  words once, numbered, and waits until you confirm you have written them down.
  `--json` and piped runs never print the phrase; they carry
  `custody: "self"`, the same warning, `recoveryPhrase: "hidden"`, and point at
  `vapi backup`. The next steps gained a `vapi backup` line.
- `vapi fund` and the `wallet.fund` MCP tool now hand out the hosted funding
  page at `<registry>/fund/<address>` instead of a pre-minted Coinbase session.
  The Coinbase session token is single-use and expires after five minutes, so
  anyone who took a moment to log in landed on "Action not available". The page
  mints the session at click time and also offers a wallet transfer
  (MetaMask/Coinbase Wallet/WalletConnect) and a bridge from another chain.
- Neither command touches the network any more: `vapi fund` works offline, never
  reports `onramp_unavailable`, and prints `{ address, network, url }` with
  `--json`. `wallet.fund` returns the same shape plus a short instruction for the
  agent to hand the link to its human.

### Deprecated

- `createOnrampSession` stays exported for backwards compatibility but is no
  longer used by the CLI or the MCP server. Use the new `fundingPageUrl`.

## 0.2.3

### Added

- `vapi export-key [--network <caip2>] [--json]`: unlocks the local keystore and
  prints the private key for the selected account — the EVM key as 0x-prefixed
  hex by default, or the base58 Ed25519 secret key for a Solana network. The
  warning goes to stderr and the key alone to stdout, so it can be piped.

### Fixed

- `vapi init` checks for an existing keystore before prompting for a passphrase,
  and names the wallet address it is refusing to replace.
- Config files written by older installs that still point at the retired
  `console.vapinetwork.ai` and `console-staging.vapinetwork.ai` hosts, or at the
  `/api/network/services` and `/api/marketplace/discovery` paths, are repaired in
  memory on load and rewritten on disk by `vapi init`. Before this, every command
  failed with `URL hostname … is not allowed`.
- The `bin` entries no longer use a `./` prefix, which npm stripped from the
  published manifest with a `"bin[vapi]" script name … was invalid` warning.

## 0.2.1

### Changed

- The terminal mark is drawn at the logo's real proportions (28x12 cells, solid
  colour cells; the ink blocks follow the terminal's own foreground so they read
  on light and dark themes) inside a framed welcome banner with the tagline and
  version beside it. `vapi init` and bare `vapi` show it; `--json`, `NO_COLOR`,
  `CI` and non-TTY output get the plain frame.

## 0.2.0

First release published to the npm `latest` tag. `0.2.0-dev.x` preview builds
remain on `next`.

### Added

- `vapi fund [--amount <usd>] [--json]`: asks the registry for a hosted Coinbase
  Onramp session for the local address, prints the link, opens it in the default
  browser on a terminal, and shows the resulting balance. When the onramp is
  unavailable it prints the address plus direct USDC-on-Base instructions instead
  of failing. vAPI never holds the funds.
- `wallet.fund` MCP tool, sharing `createOnrampSession` in `@vapi-network/core`
  with the CLI so both surfaces return the same session or fallback text.
- An animated block-logo banner on `vapi init` and on bare `vapi`. The mark is
  the nine-rectangle vAPI grid scaled to 34 terminal columns. It prints once as a
  static frame when stdout is not a terminal, or when `--json`, `NO_COLOR`, or
  `CI` is set.
- A next-steps block after `vapi init` (address, fund, search, pay, MCP config).
  `vapi init --json` gains a matching `nextSteps: string[]`; the rest of its JSON
  shape is unchanged.
- `vapi report` and the `support.report` MCP tool write a privacy-preserving
  local report and upload it only with an explicit `--send`.
- Listing disclosures from the registry: `group` (`vapi`, `added`, `partner`, or
  `external`) and `fee` (`{ bps, label }`). `vapi search` prints the group as a
  short tag plus the fee label, `vapi inspect` reports both, and `call.search`
  and `call.inspect` carry them in their MCP output schemas. vAPI and added APIs
  carry a 5% network fee inside the quoted price; partner and external listings
  carry none.

### Changed

- Every registry response schema is now tolerant of unknown keys, so a registry
  that starts returning an additional field can no longer fail `vapi search`,
  `vapi inspect`, or `vapi pay` with "Discovery response is malformed." Unknown
  fields are preserved and still reach `--json` consumers. Requests this client
  builds — discovery input, payment payloads, SIWx proofs — stay strict.
- Every package's `publish:npm` now targets the `latest` npm tag, and every
  package gained a `publish:npm:next` for `next` previews.
- The registry's canonical discovery paths are `/api/call/discovery` and
  `/api/call/services`, derived from `VAPI_REGISTRY_URL`. The historical
  `/api/marketplace/discovery` and `/api/network/services` paths are deprecated
  and normalized to the canonical pair.

### Fixed

- Pay-path fixes: `call.inspect` exposes a listing's executable request contract
  before payment, mirrored external listings stay off the Call surface, and
  spend policy is applied before signing so a declined call never creates a
  payment authorization.
