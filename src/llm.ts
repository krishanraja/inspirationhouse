import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'
import type { Config } from './config.ts'

export interface Structured<T> {
  data: T | null
  // Why there is no data, when there is none: the run reports it rather than
  // reading an empty answer as "nothing to say".
  failure: 'refusal' | 'max_tokens' | 'unparsed' | null
  model: string
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
      // Streamed: the SDK refuses a non-streaming call whose max_tokens could run past ten minutes (the weekly distil
      // asks for 32000), and finalMessage() still parses the structured output.
      let res
      try {
        res = await client.messages.stream({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }],
          output_config: { format: zodOutputFormat(schema) },
        }).finalMessage()
      } catch (err) {
        // An answer that breaks the schema fails that one item, never the whole run: the SDK throws while parsing
        // (2026-10-24, a seventh organisation where six were allowed stopped the daily run). Anything else still throws.
        if (/Failed to parse structured output/.test((err as Error)?.message ?? '')) return { data: null, failure: 'unparsed', model }
        throw err
      }
      // The stop reason first, always: a refused or cut-off answer is not data.
      if (res.stop_reason === 'refusal') return { data: null, failure: 'refusal', model: res.model }
      if (res.stop_reason === 'max_tokens') return { data: null, failure: 'max_tokens', model: res.model }
      if (res.parsed_output == null) return { data: null, failure: 'unparsed', model: res.model }
      return { data: res.parsed_output, failure: null, model: res.model }
    },
  }
}
