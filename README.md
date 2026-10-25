# Inspiration House

The taste ledger. It turns what Krish saves and judges into a record of **why** he likes it, asks him to confirm the patterns, and gives the confirmed ones to the systems that write and produce for him, so their output gets closer to his taste every week.

It is headless: no UI of its own and nothing to host. It runs on GitHub Actions, keeps its state in the Mindmaker OS Supabase project, and is read by two consumers:

- **content-engine** reads approved claims while drafting and revising (never while judging or ranking).
- **ai-harness**'s `krish-voice` and `krish-design` skills read them from a file each, which arrives only by a pull request Krish merges (`pnpm engine harness`).
- **Control Center** shows the Inspiration page (one card per thing saved in Drive), and its Visibility scorer reads the cards he routed to "A room or stage to go for" as the kind of room he wants. An answer with that route counts as visibility-lane evidence here, whichever folder the card came from.

It also reads what **content-watcher** leaves behind. When Krish pastes a link into the box on the Inspiration board, Control Center queues it (`content_watch_requests`), content-watcher on one of his home computers fetches the post, files its media into his Drive folder and reads it into text (`content_reads`, one reading per file, found by the file's sha256). This engine then makes the card, links the request to it, and tags it from that reading.

## How it works

| Stage | When | What |
|---|---|---|
| collect | daily | Reads, never writes, the places Krish's taste already lands: content-engine's taste files (learnings, title verdicts, golden and rejected lines, style references), idea triage, visibility decisions, creator moves, drive-scan's artifacts, the What I like sheet, both Drive folders, the Instagram workbook in Cold Ideas (each post as an observation, each theme as a machine inference; context, never proof), and his answers on the Inspiration page. Whatever he typed on a card is his words; an answer that is only taps is his action. An answer he takes back or changes stops counting: each run withdraws the page's older versions and the claims citing them are recounted. The Instagram workbook is read whole too: a post's version no longer in the workbook (an edit, or a re-uploaded workbook, whose new file id gives every post a new version) is withdrawn, so each post stands once; a read that finds no rows withdraws nothing. |
| tag | daily | Settles each card's kind (`src/tag/kinds.ts`): a video, an image, a feed that keeps itself fresh, a research corpus, an idea or script, or another document. The file settles it when it can, the model reads a document it cannot, and a kind Krish sets on the page is never overwritten. A video's guesses are about its script, narrative or production style, an image's about its clarity; a clear opinion about AI rides on any card as its topic; a corpus or an idea names the piece on the slate it likely serves (a guess he confirms). A feed is never asked anything and goes to no model: its posts are read row by row (collect). Neither a feed nor a corpus gives taste evidence. Then gives each Drive item a card: a thumbnail, guessed tags, guessed one-tap answers, and facets (platform, format, source, creator, people, organisations, topics), with what the file name proves kept as fact (`src/tag/hints.ts`). A video is watched: eight frames spread across it and its words transcribed on the runner (`src/tag/watch.ts`, ffmpeg and faster-whisper), the words kept on the card. Whether the words were heard (`words`, `silent`, `too_big` for a file over the 150 MB fetch cap, or `failed` with its class) is kept on the card's facets with its tries. A run in which a try fails is a failed run; an unheard video is tried again on the next run, up to three tries (`HEAR_TRIES`), and a try on a card already tagged only writes the hearing, with no model call, unless it heard words. Words heard once stay on the card and are never heard again: a card tagged again takes only its frames, and when the model call fails after the words were heard, the next run tags the card from them. Tagging starts no new card after 12 minutes, so explaining and the run's record always run inside the job's hour. A card tagged under an older revision (`TAG_PROMPT_REV`) is tagged again, and so is a card he told how to read (read_as, or a note for Claude) after it was tagged, once. Only cards whose file is in Drive that run are tagged. One card's model error fails that card only. A guess stays a guess until he answers. A file content-watcher has already read is never downloaded or watched here: it is tagged from that reading (up to 30,000 characters of it, given to the model as data, never as instructions) and Drive's thumbnail, its words become the card's transcript, and the card says it was read that way (`facets.read_from`, `facets.read_rev`). A reading that could not hear a video counts as one of its three tries, so the card stops coming back after the third run. A reading that does not say whether it heard a video counts it as heard only when it has a section of the words said (`## Words (...)`). A file with no reading is watched as before. |
| link | daily, and the cards job | Links each pasted link to the card its media became (`src/tag/links.ts`). Drive gives each file's sha256, and the request lists the sha256 of every file content-watcher filed, so the files are matched by that hash (in either case) and their cards by Drive id. The request's card is the card of the first file, in the request's order, that has one; the request then points at it (`item_id`) and the card carries the link (`facets.link`: the request, the link, its platform, the author and date when the reading says them, when he pasted it, and how many files the post had). A request linked before its reading arrived gets the author and date on a later run, once it points at its reading; what a card already says is never overwritten. A carousel is one card: every other slide's card points at it (`facets.part_of`, with its place in the post), Control Center hides those, and the tagger never sends them to the model. A card another post already took is never taken again: when the same post is pasted under a second address, or a single picture is already a slide of another post, the second request points at that post's card and changes nothing on it. The note he typed when he pasted the link becomes the card's "why he saved it" only when the card has none; the card still asks its question, and the note counts as his words from the moment he pasted it. Until he answers the card, the note follows his request: when he pastes the link again with a new note, the card takes the new one, and after his Undo on the page, which empties "why he saved it", his note comes back on the next run. A card he has answered is never changed by a note. A second run changes nothing. The logs carry only how many requests were linked, slides folded and notes kept. |
| explain | daily | Turns each piece of his evidence into one to three candidate whys, each tagged form (craft) or subject. Each piece is read once (`explained_at`), even when it gives no why; withdrawn evidence is never read. |
| distil | weekly | Groups whys into claims. The model drafts; code checks every citation; the database counts the support. |
| propose | weekly | Puts at most three claims a week to Krish through the existing learning-proposals door. He decides; the engine never does. |
| harness | daily | Renders the approved form rules into `skills/krish-voice/references/approved-taste.md` and `skills/krish-design/references/approved-taste.md` and, when they differ from ai-harness `main`, opens or refreshes one pull request there (branch `taste/approved-rules`). An open pull request that already holds the set is left alone, a rule he reworded carries only his words, and a set he closed without merging is never proposed again (its hash is in the pull request's body). Nothing reaches those skills until Krish merges it (Ruling, Krish, 2026-10-24: rules arrive by PR). |
| score | weekly | Computes the scoreboard. The moat metric is corrections per published piece: lower means the output needed him less. |

## Rules it keeps

- **Never writes to Drive.** Google scopes are read-only, checked in CI.
- **His words are his.** A claim can quote him only verbatim, enforced by the database. A tapped suggestion is recorded as his endorsement, never as his words.
- **Taste shapes form, never subject** (anti-echo). Readers only see `taste_profile_form`.
- **A model answer is read here, never by the SDK.** The API never receives a schema's length or count limits, so an answer that runs over one is repaired and counted (`src/repair.ts`), never thrown away; an answer that is the wrong shape still fails that one item.
- **Numbers are computed, never emitted by a model.** Support, confidence and every score come from SQL.
- **Silence is not feedback.** An unanswered proposal stays proposed, and a quiet week scores as no reading, never zero.
- **This repository is public.** Nothing Krish said is committed or logged; logs carry counts only (`src/log.ts`). Fixtures are synthetic.

## The schema

`supabase/migrations/20261104090000_taste_ledger.sql` lives in **content-engine**, which owns content DDL, and is applied with the Supabase MCP `apply_migration`, never `db push`.

## Running it

```bash
pnpm install
pnpm test && pnpm typecheck
pnpm engine daily --dry-run --preview    # read-only; a readable preview goes to preview/, which is gitignored
pnpm engine weekly --dry-run --preview
```

A dry run refuses every write. Without `DATABASE_URL` it reads through the Supabase Management API (`SUPABASE_ACCESS_TOKEN`).

## Turning it on

1. Apply the taste ledger migration (content-engine PR).
2. Add repository secrets: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `HARNESS_SYNC_TOKEN` (a fine-grained token with contents and pull request write on `krishanraja/ai-harness` only), and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` holding the service account's whole JSON key file (or the bare PEM, with `GOOGLE_SERVICE_ACCOUNT_EMAIL` beside it). Share both Drive folders and the What I like sheet with the service account as Viewer.
3. Run each workflow once by hand with `dry_run` on and `use_model` off: it proves every source is reachable and costs nothing. Then run it with both off for the first real run, and `use_model` on when it should tag and explain.
4. Set the repository variable `TASTE_ENABLED` to `true`. Until then the schedules do nothing.

### The cards job

`pnpm -s engine cards [--dry-run] [--no-model]` (workflow `taste-cards.yml`, run by hand or by Control Center's knock, which starts it when a pasted link has been filed or read and has no card yet) is the quick path for a pasted link. It makes the missing cards, links the requests, and tags at most 10 linked cards, from their reading only, in a job of at most 15 minutes with no ffmpeg and no Python. Its 10 places go only to linked cards whose reading has arrived, so newer cards still waiting never crowd out an older one that is ready. A linked card whose reading has not arrived yet is left for the daily job and counted as `waiting_for_reading`. The daily job does the same linking, so a link never depends on the knock.

Runs are recorded in `content_engine_runs` as `taste_daily`, `taste_weekly`, `taste_harness` and `taste_cards`, where Control Center's done-check reads them.

Karakeep, the bookmark app this repository was first rebuilt from, is preserved in history at commit `cb395e1`.
