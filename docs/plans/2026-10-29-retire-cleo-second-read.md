# Retire the Cleo lane's second read of Content Inspo

Proposal (W3.2 of the Make Your Mind Up chain). Content Inspo is the Drive folder `1FNztJOU82M8zb6IIbUAbvuI6Kr0pF5Hu` (formerly "Cold Ideas & Inspo"). Its kept, first read is inspirationhouse (GitHub Actions) plus content-watcher. The n8n Cleo lane reads the same folder a second time. This document lists, per workflow, the nodes that make that second read and what would change if they were removed. It was prepared from read-only calls. **Nothing has been changed in n8n.**

How the folder is found: no Cleo workflow holds the folder id in a node. Each one reads the Supabase row `system_config.cleo_inspiration_folder_id`, and that row holds the Content Inspo id (checked on 2026-10-29). So every node chain that starts from that key is a read of Content Inspo.

Three workflows read it: Synthesis Engine (full read of file contents), Newsletter Sweep (file names only), and Inspiration Sweep (wired, but the read is already cut off in the live version). Content Pipeline reads it indirectly, through Newsletter Sweep.

## 1. Synthesis Engine

- Id: `ES32WlTsgnr63qO3`
- Name: Cleo | Mindmaker OS | Synthesis Engine
- Active: yes
- Trigger: schedule node "Wed + Sun 12:00 UTC", cron `0 12 * * 0,3`

This is the one real second read. Every run lists up to 15 files changed in the last 14 days, downloads the readable ones (Docs, Sheets, plain text, Markdown) and puts up to 8,000 characters of each into the synthesis prompt.

Nodes to remove (or disable and bypass):

| Node | Type |
|---|---|
| Load Folder Id Config | n8n-nodes-base.httpRequest (Supabase `system_config`) |
| Normalize Folder Id | n8n-nodes-base.code |
| Has Folder Id | n8n-nodes-base.if |
| Drive List Files | n8n-nodes-base.httpRequest (Drive API files list) |
| Drive Filter Readable | n8n-nodes-base.code |
| Drive Fetch Content | n8n-nodes-base.httpRequest (Drive API export / download) |
| Drive Aggregate | n8n-nodes-base.code |

Nodes left untouched: Wed + Sun 12:00 UTC, Record Start, Load Recent Ideas, Load Recent Signals, Drive Skip Empty (kept; it already emits an empty `drive_docs` list), Load Pillars, Load Cleo Brief, Load Synthesis Thresholds, Build Synthesis Prompt, Sonnet Synthesize, Build Gemini Body, Gemini Fallback Synth, Parse + Hard Filter, Has Survivors, Fan Hypotheses, Loop Hypotheses, Insert Synthesis Hypothesis, Heartbeat Done, Audit Log Done, Heartbeat Zero, Audit Log Zero.

Connections before:

```
Record Start -> Load Recent Ideas
Record Start -> Load Recent Signals
Record Start -> Load Folder Id Config
Load Folder Id Config -> Normalize Folder Id
Normalize Folder Id -> Has Folder Id
Has Folder Id (true) -> Drive List Files
Has Folder Id (false) -> Drive Skip Empty
Drive List Files -> Drive Filter Readable
Drive Filter Readable -> Drive Fetch Content
Drive Fetch Content -> Drive Aggregate
Drive Aggregate -> Load Pillars
Drive Skip Empty -> Load Pillars
Load Pillars -> Load Cleo Brief -> Load Synthesis Thresholds -> Build Synthesis Prompt -> Sonnet Synthesize
```

Connections after:

```
Record Start -> Load Recent Ideas
Record Start -> Load Recent Signals
Record Start -> Drive Skip Empty
Drive Skip Empty -> Load Pillars
Load Pillars -> Load Cleo Brief -> Load Synthesis Thresholds -> Build Synthesis Prompt -> Sonnet Synthesize
```

Two details for whoever makes the change:

- Build Synthesis Prompt reads `Drive Aggregate` inside a try and falls back to `Drive Skip Empty`, so it needs no code change. The prompt's inspiration block will read "(no inspiration docs)".
- The workflow runs in execution order v1, so Record Start's branches run top to bottom. Keep Drive Skip Empty below Load Recent Ideas and Load Recent Signals on the canvas, so both loaders finish before Load Pillars starts the chain that reads them.

What it writes today: up to 3 rows a run in `content_ideas` (`source_type` `synthesis_hypothesis`, state `researching`), plus `workflow_runs` and `audit_log` rows. That does not change. Only the inputs shrink: hypotheses are built from 14 days of `content_ideas` and `zara_signals`, without the raw folder text. Content Inspo material would reach it through the kept read. If content-watcher's cards land in `content_ideas`, Load Recent Ideas already picks them up. If they land elsewhere, Synthesis loses Content Inspo as a direct thread, and that is the intended effect of retiring the second read.

LLM nodes and models: Sonnet Synthesize calls the Anthropic Messages API with `claude-sonnet-4-6` (max 4,000 output tokens). The workflow's description says Opus 4.7, but the node calls Sonnet 4.6. Gemini Fallback Synth calls `gemini-3.6-flash`, and only when Anthropic errors. The saving is input tokens: up to 15 documents of up to 8,000 characters each in every Sonnet call, twice a week, plus one Drive list call and up to 15 Drive export calls a run. The model call itself stays, because it still synthesises ideas and signals.

## 2. Newsletter Sweep

- Id: `ZICpbmlXil11qMjs`
- Name: Cleo | Mindmaker OS | Newsletter Sweep
- Active: yes
- Trigger: none of its own. It is a sub-workflow (Sub-Workflow Trigger), called by Content Pipeline (section 4), daily at 08:00.

It reads the folder lightly: it lists the 10 most recently modified files and passes only their names (no contents) to the model.

Nodes to remove (or disable and bypass):

| Node | Type |
|---|---|
| Drive Lookup Folder ID | n8n-nodes-base.httpRequest (Supabase `system_config`) |
| Drive Normalize Folder ID | n8n-nodes-base.code |
| Drive Has Folder ID | n8n-nodes-base.if |
| Drive List Files | n8n-nodes-base.httpRequest (Drive API files list) |
| Drive Normalize Files | n8n-nodes-base.code |

Nodes left untouched: Sub-Workflow Trigger, Record Start, Log Run to Supabase, Gmail List Newsletters, Gmail Limit to 10, Gmail Fetch Message, Gmail Normalize, Drive Skip Empty (kept; it emits an empty `inspiration_files` list), Combine Gmail and Drive, Load Agent Brief, Build Identity Prepend, Build Extract Body, Anthropic Extract Themes, Build Gemini Body for Anthropic Extract Themes, Gemini Fallback for Anthropic Extract Themes, Adapt Gemini: Anthropic Extract Themes, Parse Response, Heartbeat Workflow Runs, Return to Caller, and the sticky note.

Connections before:

```
Record Start -> Gmail List Newsletters
Record Start -> Drive Lookup Folder ID
Drive Lookup Folder ID -> Drive Normalize Folder ID
Drive Normalize Folder ID -> Drive Has Folder ID
Drive Has Folder ID (true) -> Drive List Files
Drive Has Folder ID (false) -> Drive Skip Empty
Drive List Files -> Drive Normalize Files
Drive Normalize Files -> Combine Gmail and Drive (input 2)
Drive Skip Empty -> Combine Gmail and Drive (input 2)
```

Connections after:

```
Record Start -> Gmail List Newsletters
Record Start -> Drive Skip Empty
Drive Skip Empty -> Combine Gmail and Drive (input 2)
```

What it writes today: it writes no content table itself. It returns `newsletter_themes` and `inspiration_notes` to its caller and writes a `workflow_runs` heartbeat and an `audit_log` row. After the change, `inspiration_notes` come from newsletters only. Build Extract Body already handles an empty file list ("(no inspiration files)"). Content Inspo angles would come from the kept read's cards instead.

LLM nodes and models: Anthropic Extract Themes calls `claude-haiku-4-5-20251001` (max 500 output tokens). The Gemini fallback calls `gemini-3.6-flash`, and only when Anthropic errors. The Haiku call stays, because it also serves the Gmail newsletters. The saving is small: one Drive list call a day and up to 10 file names in the prompt. The point here is removing the second read, not the spend.

## 3. Inspiration Sweep

- Id: `D4W5TF1sP9lE828c`
- Name: Cleo | Mindmaker OS | Inspiration Sweep
- Active: yes
- Triggers: "Daily 06:00 ET", cron `0 6 * * *` (live runs start at 10:00 UTC). "Intraday 18:00 UTC" is disabled (cost audit of 2026-10-03).

The Drive lane here is already cut off in the live version. "Has Folder Id" sends both its true and its false output to "Drive Skip Empty", and "Drive List Files" has no incoming connection. So no Drive call is made. The ledger agrees: the last file this workflow registered in `inspiration_drive_files` (run prefix `inspiration-sweep`) was on 2026-08-20. Today the workflow only reads the folder id from Supabase and then discards it. The 97 `inspiration_sweep` rows in `content_ideas` over the last 45 days come from the Gmail lane.

So this section is a tidy-up, not a spend saving. It removes the dead branch so the read cannot come back by one reconnected wire.

Nodes to remove (all on the Drive lane; none of them runs today except the first three):

| Node | Type |
|---|---|
| Load Folder Id Config | n8n-nodes-base.httpRequest (Supabase `system_config`) |
| Normalize Folder Id | n8n-nodes-base.code |
| Has Folder Id | n8n-nodes-base.if |
| Drive List Files | n8n-nodes-base.httpRequest (Drive API files list) |
| Drive Filter Readable | n8n-nodes-base.code |
| Drive Seen Filter | n8n-nodes-base.httpRequest (Supabase `inspiration_drive_files`) |
| Drive Emit Unseen | n8n-nodes-base.code |
| Has Drive Work? | n8n-nodes-base.if |
| Fan Drive Files | n8n-nodes-base.code |
| Drive Fetch Content | n8n-nodes-base.httpRequest (Drive API download) |
| Drive Aggregate | n8n-nodes-base.code |
| Register Drive Files | n8n-nodes-base.httpRequest (Supabase RPC `register_inspiration_drive_files`) |
| Drive Silent? | n8n-nodes-base.if |
| Alert Drive Silent | n8n-nodes-base.httpRequest (Supabase `silent_failures`) |

Nodes left untouched: the Gmail lane (Load Gmail Label Config through Gmail Empty Passthrough, Seen Filter, Emit Unseen, Register Messages, Apply Canonical Labels), Drive Skip Empty (kept; it emits the empty drive shape Build Extraction Prompt and the heartbeats expect), Combine Inputs, Load Pillars, Load Cleo Brief, Load Thresholds, Load Source Yield, Load Recent Angles, Load Creators, Build Extraction Prompt, Anthropic Extract Seeds, Build Gemini Body, Gemini Fallback Extract, Parse + Filter Survivors, Collect Mined Ids, Mark Messages Mined, Has Survivors, Fan Survivors, Loop Survivors, Perplexity Research, Parse Research, Upsert Seed RPC, Heartbeat Done, Audit Log Done, Heartbeat Zero, Audit Log Zero, both triggers.

Connections before (live):

```
Record Start -> Load Gmail Label Config
Record Start -> Load Folder Id Config
Load Folder Id Config -> Normalize Folder Id
Normalize Folder Id -> Has Folder Id
Has Folder Id (true) -> Drive Skip Empty
Has Folder Id (false) -> Drive Skip Empty
Drive Skip Empty -> Combine Inputs (input 2)

Unreachable, no incoming edge:
Drive List Files -> Drive Filter Readable -> Drive Seen Filter -> Drive Emit Unseen -> Has Drive Work?
Has Drive Work? (true) -> Fan Drive Files -> Drive Fetch Content -> Drive Aggregate -> Register Drive Files -> Drive Silent?
Has Drive Work? (false) -> Drive Skip Empty
Drive Silent? (true) -> Alert Drive Silent -> Combine Inputs (input 2)
Drive Silent? (false) -> Combine Inputs (input 2)
```

Connections after:

```
Record Start -> Load Gmail Label Config
Record Start -> Drive Skip Empty
Drive Skip Empty -> Combine Inputs (input 2)
```

Drive Skip Empty reads `Drive Emit Unseen` inside a try, so it still returns its zero counters with that node gone. The `drive_*` counters in the heartbeats will read 0, as they do today.

What it writes today: `content_ideas` rows through the RPC `upsert_inspiration_seed`, plus `workflow_runs`, `audit_log`, and the Gmail ledger. All of it is from Gmail and stays as it is.

LLM nodes and models (unchanged, Gmail lane): Anthropic Extract Seeds calls `claude-sonnet-4-6` (max 8,000 output tokens), with Gemini Fallback Extract on `gemini-3.6-flash`. Perplexity Research calls `sonar-pro` once per surviving seed. Removing the dead Drive branch saves no model spend, because no Drive content reaches the prompt today.

## 4. Content Pipeline (indirect)

- Id: `DQVPdupeKAhocqdP`
- Name: Zara | Mindmaker OS | Content Pipeline (Zara Cleo Maya)
- Active: yes
- Trigger: schedule node "Schedule Trigger", daily at 08:00

It has no Drive node of its own. Its node "Cleo Newsletter Sweep" (n8n-nodes-base.executeWorkflow) calls Newsletter Sweep, which supplies the `inspiration_notes`. "Cleo: Generate Content Brief" puts those notes into the brief, and "Write pipeline tasks" writes it to the Supabase `tasks` table. No node change is proposed here. Once section 2 is done, the brief's `inspiration_notes` come from newsletters only. It has no LLM node of its own; its model spend is the Haiku call inside Newsletter Sweep.

## Candidates that do not read Content Inspo

- `rRAyEUs7NsY06hFy` Cleo | Mindmaker OS | Content Lane Sourcing: no Drive read. Its inputs are cadence, lane formats, recent drafts and the voice block, all from Supabase. It calls Perplexity `sonar-pro` and Anthropic `claude-sonnet-5`, and writes `content_ideas` (`lane_sourcing`).
- `5cACYr3eR4vzwiTt` Cleo | Mindmaker OS | Content Transform: no Drive read. A webhook transforms one existing `content_ideas` row with `claude-sonnet-4-6`.

Also checked (from searches for "Cleo", "Inspo", "Inspiration", "Drive", "scan"), none of them reads Content Inspo:

- `AnhkJrJBvmohfqjJ` Omnichannel Content Factory: inactive. It writes to Drive and does not read the folder.
- `nXnqdZTbEuk4CPzJ` Log Content Performance: a Sheets append; no Drive read.
- `O6AUi9W6UxBxhH94` LinkedIn Distribution: inactive.
- `UL59ByPJJtOK7sBG` Draft Post on Demand: inactive.
- `wztp6KoiO5EuFQEB` Email Draft: no Drive read.
- `b1UkRo6XuymALAgb` Zara Layer 1 Signal Inbox (Drive watcher): inactive, and it watches a different folder.

## Notes and open points

- Once sections 1 to 3 are done, nothing in n8n reads `system_config.cleo_inspiration_folder_id`. The row can stay. If it is retired later, that is a separate change through content-engine.
- Most rows in `inspiration_drive_files` (54 of 57, latest 2026-10-28 at 12:01 UTC) carry the run prefix `drive-scan`, not `inspiration-sweep`. None of the n8n workflows checked here writes that prefix. It is probably part of the kept read or another job outside n8n, and this proposal leaves it alone.
- n8n's version history for Inspiration Sweep holds only the 2026-10-03 version, so the date the Drive lane was cut off could not be read from n8n.
- Whether any caller other than Content Pipeline invokes Newsletter Sweep was not searched across all workflows. Its only known caller is Content Pipeline.

## The ask

Answer each one yes or no:

1. Synthesis Engine (`ES32WlTsgnr63qO3`): remove the seven Drive and folder-config nodes in section 1 and wire Record Start to Drive Skip Empty?
2. Newsletter Sweep (`ZICpbmlXil11qMjs`): remove the five Drive and folder-config nodes in section 2 and wire Record Start to Drive Skip Empty?
3. Inspiration Sweep (`D4W5TF1sP9lE828c`): remove the fourteen dead Drive-lane nodes in section 3 and wire Record Start to Drive Skip Empty?
4. Content Pipeline (`DQVPdupeKAhocqdP`): no change. Confirm that briefs built from newsletters only are acceptable?
