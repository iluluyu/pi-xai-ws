import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import type { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type {
    convertResponsesMessages,
    convertResponsesTools,
    processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";

const nativeRequire = createRequire(import.meta.url);

/**
 * Pi loads extensions as CJS and only aliases `@earendil-works/pi-ai` plus
 * `/compat`. The `/api/*` helpers this transport needs are not on that
 * surface, and their package exports have no `require` condition, so a
 * normal import aborts every session. Load `dist/api/<name>.js` from the
 * host CLI's node_modules instead. Realpath `process.argv[1]` so a `bin/pi`
 * symlink still reaches a nested pi-ai tree.
 */
export function resolvePiAiApiFile(name: string, fromPath = process.argv[1]): string {
    const fileName = `${name}.js`;
    const seen = new Set<string>();
    for (const seed of cliSeeds(fromPath)) {
        if (seen.has(seed)) {
            continue;
        }
        seen.add(seed);
        try {
            const roots = createRequire(seed).resolve.paths("@earendil-works/pi-ai") ?? [];
            for (const root of roots) {
                const apiPath = join(root, "@earendil-works", "pi-ai", "dist", "api", fileName);
                if (existsSync(apiPath)) {
                    return apiPath;
                }
            }
        } catch {
            // fromPath is not always a module filename.
        }
    }
    throw new Error(
        `Unable to locate @earendil-works/pi-ai dist/api/${fileName}` +
            ` (argv1=${process.argv[1] ?? ""}; fromPath=${fromPath ?? ""})`,
    );
}

function cliSeeds(fromPath: string | undefined): string[] {
    const seeds: string[] = [];
    if (fromPath) {
        seeds.push(fromPath);
        try {
            seeds.push(realpathSync(fromPath));
        } catch {
            // Keep the unresolved path.
        }
    }
    // node --test does not pass the Pi CLI as argv[1].
    seeds.push(fileURLToPath(import.meta.url));
    return seeds;
}

function loadPiAiApiModule(name: string): Record<string, unknown> {
    return nativeRequire(resolvePiAiApiFile(name)) as Record<string, unknown>;
}

const responsesShared = loadPiAiApiModule("openai-responses-shared");
const promptCache = loadPiAiApiModule("openai-prompt-cache");
const simpleOptions = loadPiAiApiModule("simple-options");

export const processResponsesStreamFn = responsesShared[
    "processResponsesStream"
] as typeof processResponsesStream;
export const convertResponsesMessagesFn = responsesShared[
    "convertResponsesMessages"
] as typeof convertResponsesMessages;
export const convertResponsesToolsFn = responsesShared[
    "convertResponsesTools"
] as typeof convertResponsesTools;
export const clampOpenAIPromptCacheKeyFn = promptCache[
    "clampOpenAIPromptCacheKey"
] as typeof clampOpenAIPromptCacheKey;
export const buildBaseOptionsFn = simpleOptions["buildBaseOptions"] as typeof buildBaseOptions;
