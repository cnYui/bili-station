# bili-station

[中文](README.md) · **English**

A local tool for tidying up a Bilibili account, with a web UI. Unfollow in bulk, manage follow groups, sort favorites into folders, clean out dead videos.

**Every write goes out through CDP from inside your already-logged-in Chrome tab**, carrying a complete browser fingerprint (buvid3/4, bili_ticket, Sec-Fetch-*) — rather than a local process stitching together a Cookie header and a hand-written UA. This is the key conclusion from reading 12 comparable open-source projects: a missing fingerprint is precisely why pure-CLI tools have to start their backoff at 60 seconds.

Zero runtime dependencies — Node built-ins only. Requires Node ≥ 22.

## Two ways to use it

**CLI (recommended, and easy to hand off to Claude / Codex)**

```bash
npm run chrome                  # launch Chrome with a debug port, then log in to Bilibili there
npm link                        # register the global `bili-station` command (or just use `node cli.mjs`)

bili-station status
bili-station sort --folders "Programming,Games,Cooking,Science"                                  # emit the task list
bili-station sort --folders "Programming,Games,Cooking,Science" --assign assign.json             # dry run, show the plan
bili-station sort --folders "Programming,Games,Cooking,Science" --assign assign.json --yes       # execute
```

The core constraint: **you define the candidate folders, and the classifier must pick exactly one of them — inventing a new category is not allowed.** This makes quota overflow structurally impossible. The flow is: define candidates → create any that don't exist yet → hand the candidate list to the classifier → route by title / uploader / description → copy or move in batches.

### Who does the classifying

Default is `--engine external`: **the CLI only emits the task list; the caller supplies the classification. No API key needed.** If the thing calling you is Claude or Codex, it's already an LLM — bolting on another model means one more key and one more bill.

```bash
bili-station sort --folders "A,B,C" --emit-tasks tasks.json
# read tasks.json, pick one category from `candidates` for each entry,
# produce {"<video id>":"<category name>"}
bili-station sort --folders "A,B,C" --assign assign.json --yes
```

A category outside the candidate set is **rejected**, not silently coerced into something else — a misfiled favorite is very hard to notice later. The `rejected` field in the result tells you how many were dropped and what they were.

The other two engines:
- `--engine keyword` — local keyword rules, offline and free
- `--engine deepseek` — the CLI calls the model itself; bring your own `DEEPSEEK_API_KEY` (no key is bundled in this repo)

### Calling it from an agent

Pass `--json`: stdout carries exactly one JSON object, logs go to stderr.
Exit codes are meaningful: `0` success / `1` error / `2` aborted on rate-limiting / `3` session expired / `4` nothing to do.
[AGENTS.md](AGENTS.md) in this repo is the operating manual written for agents to read.

`bili-station --help` lists every option.

## Web UI

```bash
npm run chrome    # launch Chrome with a debug port under a separate profile, log in to Bilibili
npm start         # start the local server
```

Open http://127.0.0.1:8787 and click "连接 Chrome" (Connect Chrome).

To look at the interface without connecting an account: http://127.0.0.1:8787/?demo=1

```bash
npm test          # 63 pure-logic assertions; no Chrome, no login required
npm run test:e2e  # 59 end-to-end assertions against a fake Bilibili backend, fully deterministic, no key, no cost
```

## Layout

```
server.mjs              HTTP server + JSON API + SSE live log
cli.mjs                 CLI entry point (agent-friendly)
selftest.mjs            63 assertions across the planning / classification / risk layers
test-sort-flow.mjs      end-to-end chain test: create folders → fill in ids → then move
scripts/launch-chrome.mjs
src/
  cdp.mjs               CDP transport: attach to a logged-in tab, fetch from inside the page
  bili.mjs              Bilibili API layer; WBI signing computed in Node, then handed to the page
  risk.mjs              rate-limit engine
  plan.mjs              planning layer (pure functions, testable)
  executor.mjs          executor: dry run / resume / backoff / stop on first wall
  classify/external.mjs task emission and write-back validation for external classification (default engine)
  classify/keyword.mjs  local keyword-rule classifier
  classify/ai.mjs       AI semantic classification, 10 providers (optional, bring your own key)
web/                    the visual interface
```

The data directory defaults to `~/.bili-station/` (config, cache, resume records, backups). Override it with `BILI_STATION_DIR`.

## The rate-limit engine

Six mechanisms synthesized from 12 comparable projects, each of which got only part of it right:

| Mechanism | Source |
|---|---|
| Error-code triage: back off and retry on rate-limit codes, stop immediately on auth codes | bili-unfollow |
| Decaying sliding-window heat model (45-minute half-life, green/yellow/orange/red) | the "risk calendar" in bilibili-following-manager |
| AIMD, fast down and slow up: double the delay on a rate-limit hit plus a global cooldown; ×0.85 after 5 consecutive successes | Bilibili-AI-Favorites-Organizer |
| Hard cap of 100 write operations per round | following-manager (community testing: 500+ with no delay almost always trips it) |
| Random jitter instead of a fixed cadence | bilibili-unfollow (a fixed 250ms is itself a machine signature) |
| Stop on first wall rather than pushing through | bilibili-unfollow |

Write operations are weighted by sensitivity, and **creating a folder carries the highest weight (2.5×)** because creating several in a row is the easiest way to trip the system.

## Gaps that comparable projects generally miss

- **The following-list pagination ceiling.** All 12 projects treat "the API stopped returning results" as "we've read everything." This tool flags `truncated` and tells you how far it actually got.
- **Folder quota pre-check.** When the quota is full, Bilibili returns an error that looks a lot like rate-limiting and is easily misread as such. The planning stage works out in advance whether you'll exceed it.
- **The 1000-items-per-folder pre-check.** Tells you up front which folder will overflow and by how much.
- **Same-name folder reuse.** Exact match first, then case- and whitespace-insensitive. Re-running won't leave you with "Games_1" and "Games_2".
- **Folder creation is idempotent by existence check**, not by resume record. When the resume record says a folder was created but it isn't actually there (deleted by hand, or the creation half-failed), later moves won't all silently land nowhere.
- **New folders are private by default** (`privacy=1`), so a few dozen freshly split folders don't show up on your profile. Configurable in settings.

## Safety net

- Every destructive operation is a **dry run** by default; you have to explicitly uncheck the box in the UI to really run it
- A timestamped snapshot backup is written to `~/.bili-station/backups/` before any real execution, and is never overwritten
- Resume support: completed items are recorded in `resume-*.json` and skipped on a re-run
- Special-follow accounts are **kept unconditionally**, exempt from every rule
- For favorites sorting, use **copy mode** first to confirm the result, then switch to move (copy is reversible, move is not)
- The API key is stored only in the local config, never in any export or backup, and is masked in API responses

## AI key

**The default path needs no key at all**, and none is bundled in this repo.
One is only required when you explicitly use `--engine deepseek`. Precedence: the `DEEPSEEK_API_KEY` environment variable > `~/.bili-station/config.json`. The config file lives outside the repo and is never committed; both API responses and exports mask it.

## A real run at scale

Run end to end against an account with 4260 favorites in a single folder: merge and dedupe first, then split semantically into 29 folders, then clean out the dead videos.

| Stage | Write ops | Failures | Rate-limit codes from Bilibili |
|---|---:|---:|---:|
| Create folders | 5 | 0 | 0 |
| Move 3808 items | 265 | 0 | 0 |
| Delete 366 dead videos | 19 | 0 | 0 |
| Total | **290** | **0** | **0** |

The move endpoint accepts up to 20 resources per call, so 3808 items amount to 265 calls, not one request each.

A few facts that only surface at this scale:

- **The 100-writes-per-round hard cap really does stop you.** A single submission of 195 write operations was blocked by it and had to be split across rounds. That limit is not decorative.
- **The heat model is conservative.** Heat peaked at 97/100 (red), yet Bilibili returned zero rate-limit codes the whole way. The heat score is this tool's own prior, not Bilibili's actual counter — when the two disagree, trust the error codes. Heat is good for adaptive pacing, not as a gate on starting work.
- **`media_count` lags.** After a bulk delete, the folder listing still showed the old number (88 reported when the real count was 0). Trust what pagination actually returns.
- **Bilibili doesn't flag every dead video.** One entry's title was already `【已删除】` ("deleted"), but `attr=0` with no dead bit set, so the `dead` command couldn't see it. It had to be removed by id.

## Known gaps

- The rule editor for follow groups isn't wired into the UI yet (the `buildTagOps` backend is ready)
- Upload probing (detecting dormant accounts) is capped at 300 per pass; a large following list needs several passes
- The folder-count limit defaults to 20 (a conservative value — Bilibili publishes no authoritative number). In testing, this account ran fine with 30 folders. Adjust it in settings to match your own account.

## Disclaimer

This calls Bilibili's official web APIs; the behavior is equivalent to clicking through the site yourself. Bulk operations can still trip rate-limiting. Start small, and stop and wait a while if you hit it. You are responsible for any consequences of using this tool.
