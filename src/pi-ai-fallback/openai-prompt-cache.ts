// Copied from Pi's Responses helpers for compiled-binary hosts that have no
// on-disk `@earendil-works/pi-ai/dist/api`. Imports from `@earendil-works/pi-ai`
// go through Pi's extension alias / virtual module. Do not load this tree with
// createRequire: that bypasses the alias.
// @ts-nocheck
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
export function clampOpenAIPromptCacheKey(key) {
    if (key === undefined)
        return undefined;
    const chars = Array.from(key);
    if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH)
        return key;
    return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
// sourceMappingURL=openai-prompt-cache.js.map