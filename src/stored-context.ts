import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveMaxStoredContextTokens, storeResponsesEnabled } from "./config.ts";

const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const ESTIMATED_IMAGE_CHARS = 4_800;
const safetyActiveSessions = new Set<string>();
const warnedSessions = new Set<string>();

type MessageRecord = {
    command?: unknown;
    content?: unknown;
    output?: unknown;
    role?: unknown;
    stopReason?: unknown;
    summary?: unknown;
    timestamp?: unknown;
    usage?: {
        cacheRead?: unknown;
        cacheWrite?: unknown;
        input?: unknown;
        output?: unknown;
        totalTokens?: unknown;
    };
};

export function estimateStoredRequestTokens(
    messages: readonly unknown[],
    preparedPayloadTokens: number,
): number {
    const conversationTokens = estimateContextTokens(messages);
    // Unsliced create JSON includes the full local prefix, tools, and encrypted
    // reasoning. max() with that figure trips the store guard during
    // continuation, when xAI would store usage plus trailing items. Ignore the
    // payload size only after a successful assistant has reported usage. With
    // no usage yet, keep the larger of the message estimate and the payload so
    // a first stored request still sees tools, images, and hook-only input.
    if (hasReliableUsage(messages)) {
        return conversationTokens;
    }
    return Math.max(conversationTokens, finiteNonnegative(preparedPayloadTokens));
}

export function setStoredContextSafetyActive(sessionId: string | undefined, active: boolean): void {
    const key = sessionId?.trim();
    if (!key) {
        return;
    }
    if (active) {
        safetyActiveSessions.add(key);
    } else {
        safetyActiveSessions.delete(key);
        warnedSessions.delete(key);
    }
}

export function registerStoredContextSafety(pi: ExtensionAPI): void {
    const clearSession = (_event: unknown, ctx: ExtensionContext) => {
        const sessionId = ctx.sessionManager.getSessionId();
        safetyActiveSessions.delete(sessionId);
        warnedSessions.delete(sessionId);
    };
    pi.on("session_start", clearSession);
    pi.on("session_shutdown", clearSession);

    pi.on("turn_end", (_event, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const applies = storeResponsesEnabled() &&
            ctx.model?.provider === "xai" &&
            ctx.model.api === "openai-responses" &&
            safetyActiveSessions.has(sessionId);
        if (!applies || warnedSessions.has(sessionId) || !ctx.hasUI) {
            return;
        }

        ctx.ui.notify(
            "xAI's stored-response size limit is near. Using full-history requests until the context is compacted.",
            "warning",
        );
        warnedSessions.add(sessionId);
    });
}

function estimateContextTokens(messages: readonly unknown[]): number {
    const compactionIndex = findLatestCompactionIndex(messages);
    const usageInfo = findLatestReliableUsage(messages, compactionIndex);
    const startIndex = usageInfo?.index ?? (compactionIndex >= 0 ? compactionIndex : 0);
    let tokens = usageInfo?.tokens ?? 0;
    for (let index = startIndex + (usageInfo ? 1 : 0); index < messages.length; index += 1) {
        tokens += estimateMessageTokens(messages[index]);
    }
    return Math.max(tokens, latestUsageFloor(messages, compactionIndex));
}

function hasReliableUsage(messages: readonly unknown[]): boolean {
    return findLatestReliableUsage(messages, findLatestCompactionIndex(messages)) !== undefined;
}

function findLatestCompactionIndex(messages: readonly unknown[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (isCompactionMessage(asMessage(messages[index]))) {
            return index;
        }
    }
    return -1;
}

function findLatestReliableUsage(
    messages: readonly unknown[],
    compactionIndex: number,
): { index: number; tokens: number } | undefined {
    const compactionTimestamp = compactionIndex >= 0
        ? finiteNonnegative(asMessage(messages[compactionIndex])?.timestamp)
        : 0;

    for (let index = messages.length - 1; index > compactionIndex; index -= 1) {
        const message = asMessage(messages[index]);
        if (message?.role !== "assistant" ||
            message.stopReason === "aborted" ||
            message.stopReason === "error") {
            continue;
        }
        if (!isAfterCompaction(message, compactionIndex, compactionTimestamp)) {
            continue;
        }
        const tokens = usageTokens(message);
        if (tokens > 0) {
            return { index, tokens };
        }
    }
    return undefined;
}

function latestUsageFloor(messages: readonly unknown[], compactionIndex: number): number {
    const compactionTimestamp = compactionIndex >= 0
        ? finiteNonnegative(asMessage(messages[compactionIndex])?.timestamp)
        : 0;
    for (let index = messages.length - 1; index > compactionIndex; index -= 1) {
        const message = asMessage(messages[index]);
        if (message?.role !== "assistant" ||
            !isAfterCompaction(message, compactionIndex, compactionTimestamp)) {
            continue;
        }
        const tokens = usageTokens(message);
        if (tokens > 0) {
            return tokens;
        }
    }
    return 0;
}

function isAfterCompaction(
    message: MessageRecord,
    compactionIndex: number,
    compactionTimestamp: number,
): boolean {
    if (compactionIndex < 0) {
        return true;
    }
    const timestamp = finiteNonnegative(message.timestamp);
    return compactionTimestamp > 0 && timestamp > compactionTimestamp;
}

function isCompactionMessage(message: MessageRecord | undefined): boolean {
    if (message?.role === "compactionSummary") {
        return true;
    }
    if (message?.role !== "user") {
        return false;
    }
    const content = message.content;
    if (typeof content === "string") {
        return content.startsWith(COMPACTION_SUMMARY_PREFIX);
    }
    if (!Array.isArray(content)) {
        return false;
    }
    const first = content[0];
    return typeof first === "object" && first !== null &&
        (first as Record<string, unknown>).type === "text" &&
        typeof (first as Record<string, unknown>).text === "string" &&
        ((first as Record<string, unknown>).text as string).startsWith(COMPACTION_SUMMARY_PREFIX);
}

function usageTokens(message: MessageRecord): number {
    const totalTokens = finiteNonnegative(message.usage?.totalTokens);
    if (totalTokens > 0) {
        return totalTokens;
    }
    return finiteNonnegative(message.usage?.input) +
        finiteNonnegative(message.usage?.output) +
        finiteNonnegative(message.usage?.cacheRead) +
        finiteNonnegative(message.usage?.cacheWrite);
}

function estimateMessageTokens(value: unknown): number {
    const message = asMessage(value);
    if (!message) {
        return 0;
    }

    let chars = 0;
    switch (message.role) {
        case "user":
        case "custom":
        case "toolResult":
            chars = contentChars(message.content);
            break;
        case "assistant":
            chars = assistantContentChars(message.content);
            break;
        case "bashExecution":
            chars = stringLength(message.command) + stringLength(message.output);
            break;
        case "branchSummary":
        case "compactionSummary":
            chars = stringLength(message.summary);
            break;
    }
    return Math.ceil(chars / 4);
}

function contentChars(content: unknown): number {
    if (typeof content === "string") {
        return content.length;
    }
    if (!Array.isArray(content)) {
        return 0;
    }
    return content.reduce((chars, block) => {
        if (typeof block === "object" && block !== null) {
            const item = block as Record<string, unknown>;
            if (item.type === "text" && typeof item.text === "string") {
                return chars + item.text.length;
            }
            if (item.type === "image") {
                return chars + ESTIMATED_IMAGE_CHARS;
            }
        }
        return chars;
    }, 0);
}

function assistantContentChars(content: unknown): number {
    if (!Array.isArray(content)) {
        return stringLength(content);
    }
    return content.reduce((chars, block) => {
        if (typeof block !== "object" || block === null) {
            return chars;
        }
        const item = block as Record<string, unknown>;
        if (item.type === "text") {
            return chars + stringLength(item.text);
        }
        if (item.type === "thinking") {
            return chars + stringLength(item.thinking);
        }
        if (item.type === "toolCall") {
            return chars + stringLength(item.name) + JSON.stringify(item.arguments ?? {}).length;
        }
        return chars;
    }, 0);
}

function asMessage(value: unknown): MessageRecord | undefined {
    return typeof value === "object" && value !== null
        ? value as MessageRecord
        : undefined;
}

function finiteNonnegative(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, value)
        : 0;
}

function stringLength(value: unknown): number {
    return typeof value === "string" ? value.length : 0;
}
