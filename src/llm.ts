import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'
import type { Config } from './config.ts'
import { repairToSchema } from './repair.ts'
import { readUsage, NO_USAGE, type Meter, type Usage } from './meter.ts'

export interface Structured<T> {
  data: T | null
  // Why there is no data, when there is none: the run reports it rather than
  // reading an empty answer as "nothing to say".
  failure: 'refusal' | 'max_tokens' | 'unparsed' | null
  model: string
  // How many limits the answer overran and were repaired (src/repair.ts); counted by the run, never hidden.
  repairs?: number
}

export interface Llm {
  readonly model: string
  // The same model, its calls metered under another stage's name (src/meter.ts). A test's stand-in may leave it out.
  forStage?(stage: string): Llm
  structured<S extends z.ZodType>(args: {
    schema: S
    system: string
    content: Anthropic.ContentBlockParam[]
    maxTokens?: number
    // Cache the system prompt for the calls after this one: set by a stage that asks many times with one system prompt
    // in a run (the tagger). Below the model's minimum length it silently caches nothing; the meter shows which.
    cache?: boolean
  }): Promise<Structured<z.infer<S>>>
}

/** The stage-named view of a model, or the model itself when it has none (a test's stand-in). */
export function staged(llm: Llm, stage: string): Llm
export function staged(llm: Llm | null, stage: string): Llm | null
export function staged(llm: Llm | null, stage: string): Llm | null {
  return llm?.forStage ? llm.forStage(stage) : llm
}

// Every call's tokens go to the meter, under the stage it was made for, whether the answer was used or not: a refused,
// cut-off or unparsed answer was still billed, and a call that throws after the stream began is counted as failed.
export function anthropicLlm(cfg: Config, meter?: Meter, stage = 'unstaged'): Llm {
  if (!cfg.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  // logLevel off: the SDK's own warnings can print a raw stream chunk, which may be model text, into the public log.
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, logLevel: 'off' })
  return bound(client, cfg.TASTE_MODEL, meter, stage)
}

function bound(client: Anthropic, model: string, meter: Meter | undefined, stage: string): Llm {
  return {
    model,
    forStage: next => bound(client, model, meter, next),
    async structured({ schema, system, content, maxTokens = 16000, cache = false }) {
      // Streamed as raw events, read here: the SDK refuses a non-streaming call whose max_tokens could run past ten
      // minutes (the weekly distil asks for 32000), and its own reader enforces limits the API never sent
      // (src/repair.ts), so one tag too many used to throw away the card (2026-10-24), and it parses before the stop
      // reason can be read.
      const { schema: jsonSchema } = zodOutputFormat(schema)
      const events = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system,
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema: jsonSchema } },
        stream: true,
      })
      let text = ''
      let stop: string | null = null
      let served = model
      // message_start carries the input side, message_delta the output (cumulative, and any field it repeats wins).
      let usage: Usage = { ...NO_USAGE }
      try {
        for await (const ev of events) {
          if (ev.type === 'message_start') { served = ev.message.model; usage = { ...usage, ...readUsage(ev.message.usage) } }
          else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') text += ev.delta.text
          else if (ev.type === 'message_delta') { stop = ev.delta.stop_reason ?? stop; usage = { ...usage, ...readUsage(ev.usage) } }
        }
      } catch (err) {
        meter?.record(stage, served, usage, true)
        throw err
      }
      meter?.record(stage, served, usage, stop === 'refusal' || stop === 'max_tokens')
      // The stop reason first, always: a refused or cut-off answer is not data.
      if (stop === 'refusal') return { data: null, failure: 'refusal', model: served }
      if (stop === 'max_tokens') return { data: null, failure: 'max_tokens', model: served }
      let raw: unknown
      try { raw = JSON.parse(text) } catch { return { data: null, failure: 'unparsed', model: served } }
      const fixed = repairToSchema(schema, raw)
      if (!fixed) return { data: null, failure: 'unparsed', model: served }
      return { data: fixed.data, failure: null, model: served, repairs: fixed.repairs }
    },
  }
}
