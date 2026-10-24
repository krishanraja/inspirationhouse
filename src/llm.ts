import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'
import type { Config } from './config.ts'
import { repairToSchema } from './repair.ts'

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
  structured<S extends z.ZodType>(args: {
    schema: S
    system: string
    content: Anthropic.ContentBlockParam[]
    maxTokens?: number
  }): Promise<Structured<z.infer<S>>>
}

export function anthropicLlm(cfg: Config): Llm {
  if (!cfg.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY })
  const model = cfg.TASTE_MODEL
  return {
    model,
    async structured({ schema, system, content, maxTokens = 16000 }) {
      // Streamed as raw events, read here: the SDK refuses a non-streaming call whose max_tokens could run past ten
      // minutes (the weekly distil asks for 32000), and its own reader enforces limits the API never sent
      // (src/repair.ts), so one tag too many used to throw away the card (2026-10-24), and it parses before the stop
      // reason can be read.
      const { schema: jsonSchema } = zodOutputFormat(schema)
      const events = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema: jsonSchema } },
        stream: true,
      })
      let text = ''
      let stop: string | null = null
      let served = model
      for await (const ev of events) {
        if (ev.type === 'message_start') served = ev.message.model
        else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') text += ev.delta.text
        else if (ev.type === 'message_delta') stop = ev.delta.stop_reason ?? stop
      }
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
