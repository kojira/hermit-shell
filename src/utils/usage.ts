type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
};

/** Preserve Anthropic counters and expose an OpenAI-compatible aggregate that
 * Pi's openai-completions provider can account for without losing cache data. */
export function convertUsage(usage: AnthropicUsage | undefined) {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const read = usage?.cache_read_input_tokens ?? 0;
  const write = usage?.cache_creation_input_tokens ?? 0;
  return {
    ...usage,
    prompt_tokens: input + read + write,
    completion_tokens: output,
    total_tokens: input + read + write + output,
    prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
  };
}
