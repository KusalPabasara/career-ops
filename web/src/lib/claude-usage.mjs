/**
 * Return the billable/context tokens represented by a Claude Code usage event.
 *
 * Anthropic reports prompt-cache reads separately from ordinary input tokens.
 * Leaving that field out makes the rolling usage meter undercount exactly the
 * long, repeatedly-read prompts where caching has the largest effect.
 */
export function claudeUsageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;

  return [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ].reduce((total, key) => {
    const value = usage[key];
    return total + (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}
