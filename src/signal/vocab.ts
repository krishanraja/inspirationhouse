// The words a taste signal may use. Krish, 2026-10-27: his long-form feedback should become "really robust metadata
// tags that are going to be really valuable over time to draw patterns from". A tag is only countable across weeks if
// the same thing is always called the same thing, so the vocabulary is fixed here, in code, and grows by a pull request
// he merges: the model picks a slug below or says `other` with a short label, and the run counts the `other`s so the
// next slug to add is plain. Pure.
//
// A dimension is one of the ledger's craft layers (content-engine's taste_layers), so a signal joins to the whys and
// claims of the same layer, plus two that are not craft: `subject` (what a thing is about; anti-echo, readers never
// see it as taste) and `workflow` (how he wants the system to work with him, which much of his feedback is about).

export const VOCAB_REV = 'vocab-v1'

export const FORM_DIMENSIONS = ['opening', 'structure', 'breakdown', 'proof', 'tone', 'close', 'packaging',
  'length', 'editing', 'camerawork', 'graphics', 'production', 'stage_format'] as const
export const DIMENSIONS = [...FORM_DIMENSIONS, 'subject', 'workflow'] as const
export type Dimension = typeof DIMENSIONS[number]
export type SignalKind = 'form' | 'subject' | 'workflow'

/** Every slug, by dimension, with what it means: the model reads the meaning, the ledger keeps the slug. */
export const VOCAB: Record<Dimension, Record<string, string>> = {
  opening: {
    provocative_hook: 'a bold or slightly alarming first claim',
    curiosity_gap: 'an opening that makes you need to know more',
    first_person_surprise: 'opens on something that surprised the speaker',
    striking_image: 'opens on a strong visual or image',
    plain_declarative: 'states the point plainly, no wind-up',
    concrete_stake: 'ties the opening to what is at stake for a named audience',
  },
  structure: {
    one_idea: 'one idea per piece or per frame',
    investigation: 'framed as an investigation or a test',
    head_to_head: 'compares two concrete options side by side',
    named_technique: 'packages the idea as a named, repeatable method',
    simple_test: 'a short decision test the viewer can use',
    format_variety: 'mixes formats rather than repeating one',
    model_layout: 'a post or piece layout he wants to copy',
  },
  breakdown: {
    plain_before_jargon: 'the plain version before any insider term',
    concrete_example: 'a concrete example carries the point',
    relatable_analogy: 'an everyday image or analogy makes it relatable',
    step_by_step: 'a complex thing unpacked step by step',
    separate_motives: 'each party\'s motive unpacked on its own',
    follow_the_money: 'who pays and who profits is traced',
    so_what_for_leaders: 'says what a leader can do differently now',
    clear_referents: 'no vague "it" or "the company"; always clear who or what',
    no_assumed_knowledge: 'assumes nothing the viewer may not know',
  },
  proof: {
    named_specifics: 'names the real company, person or figure',
    named_number: 'a specific number backs the claim',
    fair_comparison: 'compares like with like',
    sound_test: 'a test with a real control',
    accurate_claim: 'says exactly what the evidence says, no more',
    bold_near_term_call: 'a confident near-term call over a hedged far one',
    sources_by_format: 'cites sources fully long-form, lightly in short formats',
  },
  tone: {
    sounds_like_him: 'reads like he talks',
    easy_to_say: 'easy to say aloud, no decoding',
    sincere: 'honest and sincere, even when serious',
    relatable_expert: 'expert but relatable',
    dry_aside: 'short dry asides tied to true details',
    punchy_line: 'the key line lands hard',
    no_hype: 'no hype or cheap provocation',
    not_negative: 'not needlessly negative',
    no_choppy_sentences: 'no robotic run of short sentences',
    plain_words: 'plain words, no jargon or shorthand',
  },
  close: {
    specific_action: 'the next step comes from this piece\'s own evidence',
    numbered_actions: 'ends with a short numbered list of actions',
    durable_rule: 'ends on a rule that will not date',
    single_pointer: 'one line pointing to the full piece, nothing after',
    new_takeaway: 'a takeaway not already given in an earlier piece',
    surprise_last: 'saves the surprise for the end',
    real_choice: 'ends on a real choice for the viewer',
  },
  packaging: {
    plain_title: 'a plain title that says what it is',
    imperative_title: 'a short title that tells you what to do',
    names_specifics: 'the title names the real company or figure',
    title_as_card: 'the title can double as a chapter or title card',
    curiosity_title: 'a title that makes you want to know more',
    format_fit_cover: 'cover words fitted to each format',
    reuse_picked_words: 'cover reuses words he already picked',
    stranger_reads_instantly: 'a stranger gets it at a glance',
    no_false_impression: 'title and thumbnail imply nothing untrue',
  },
  length: {
    short_and_punchy: 'short, lands quickly',
    room_to_explain: 'long enough to explain and give the consequence',
    fits_format: 'length fitted to the format',
    dense_per_second: 'more information per second when it is fast',
  },
  editing: {
    tight_craft: 'tightly crafted, rewards rewatching',
    pace: 'pace and rhythm of the cut',
    invisible_fix: 'fixes nobody notices',
    synced_captions: 'captions and lip sync stay exact',
    minimal_cuts: 'cut only for a real flaw, not a slip',
  },
  camerawork: {
    movement: 'enough movement on screen',
    treated_background: 'a treated, considered background',
    close_talking_head: 'a close talking-head shot',
    framing: 'framing and angles',
  },
  graphics: {
    visuals_carry_meaning: 'the visuals carry most of the explanation',
    adds_beyond_voice: 'on-screen text adds what the voice does not say',
    analogy_on_screen: 'every spoken analogy shown on screen',
    clean_subtitles: 'clean, styled subtitles',
    motion_design: 'deliberate motion design',
    simple_chart: 'a simple chart makes a dense thing clear',
    clarity: 'an image that is instantly clear',
    consistent_tokens: 'the same fonts and visual tokens as the published piece',
  },
  production: {
    clean_light: 'clean, even light',
    moody_light: 'warm or moody light',
    clean_sound: 'clean sound, no stray noise',
    polished_finish: 'a polished finish',
    simple_setup: 'a simple setup over flashy production',
  },
  stage_format: {
    conversation: 'a conversation',
    panel: 'a panel',
    keynote: 'a keynote',
    podcast: 'a podcast',
    workshop: 'a workshop',
  },
  subject: {
    topic: 'what it is about; the label names the topic in two to five words',
  },
  workflow: {
    one_question_at_a_time: 'one question at a time',
    decisions_up_front: 'his decisions gathered up front, before slow steps',
    his_words_are_his: 'what he types is read as his view, never asked back',
    reuse_his_feedback: 'his past feedback reused, not lost',
    no_wasted_spend: 'no paid call where a free one does the job',
    story_first: 'story and script settled before production',
    finish_the_job: 'one session finishes the job',
    stable_references: 'references that do not break when things move',
    save_for_later: 'kept for a later or bigger piece',
  },
}

/** What a dimension's signals are: craft, a subject, or how he works. */
export function kindOf(d: Dimension): SignalKind {
  return d === 'subject' ? 'subject' : d === 'workflow' ? 'workflow' : 'form'
}

export const isDimension = (v: unknown): v is Dimension => typeof v === 'string' && (DIMENSIONS as readonly string[]).includes(v)

/**
 * The slug for what the model returned: `<dimension>.<attribute>` when the attribute is in the vocabulary (with or
 * without its dimension in front), else `<dimension>.other`. A subject is always `subject.topic`.
 */
export function slugOf(d: Dimension, attribute: string): string {
  if (d === 'subject') return 'subject.topic'
  const a = attribute.trim().toLowerCase().replace(/^[a-z_]+\./, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return a in VOCAB[d] ? `${d}.${a}` : `${d}.other`
}

/** The vocabulary as the prompt shows it. */
export function vocabLines(): string[] {
  return DIMENSIONS.map(d => `${d}: ${Object.entries(VOCAB[d]).map(([a, m]) => `${a} (${m})`).join('; ')}`)
}
