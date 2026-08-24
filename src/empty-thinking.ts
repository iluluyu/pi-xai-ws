import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const EMPTY_THINKING_NUDGE_CUSTOM_TYPE = "pi-xai-ws-empty-thinking";
export const EMPTY_THINKING_TEST_NUDGE_FILENAME = "pi-xai-ws.test-nudge";
export const EMPTY_THINKING_NUDGE_TEXT =
    "Your previous reply had only thinking and no user-visible text or tool calls. Continue the work. Do not reconstruct the thinking. Take the next concrete action or write the user-facing result.";
export const EMPTY_THINKING_NUDGE_NOTIFY =
    "Grok stopped without a reply or tool call. Continuing this turn.";

export type AssistantLike = {
    content?: unknown;
    rawStopReason?: unknown;
    role?: unknown;
    stopReason?: unknown;
};

export type ModelLike = {
    id?: unknown;
    provider?: unknown;
};

export type EmptyThinkingNudgeState = {
    alreadyNudged: boolean;
    priorAssistantCount: number;
};

export type EmptyThinkingNudgeInput = {
    alreadyNudged: boolean;
    forceMidLoopStop?: boolean;
    message: AssistantLike;
    model?: ModelLike;
    priorAssistantCount: number;
};

type SessionState = EmptyThinkingNudgeState;

export function createEmptyThinkingNudgeState(): EmptyThinkingNudgeState {
    return { alreadyNudged: false, priorAssistantCount: 0 };
}

export function isGrokModel(model?: ModelLike): boolean {
    if (model?.provider !== "xai" || typeof model.id !== "string") {
        return false;
    }
    return model.id.startsWith("grok") || model.id.includes("/grok");
}

export function isEmptyThinkingStop(message: AssistantLike): boolean {
    if (!isCompletedStop(message) || message.role !== "assistant") {
        return false;
    }
    const content = message.content;
    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }
    let hasThinking = false;
    for (const part of content) {
        if (!isRecord(part) || part.type !== "thinking") {
            return false;
        }
        hasThinking = true;
    }
    return hasThinking;
}

export function isNoToolStop(message: AssistantLike): boolean {
    if (!isCompletedStop(message) || message.role !== "assistant") {
        return false;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return false;
    }
    return content.every((part) => !isRecord(part) || part.type !== "toolCall");
}

export function shouldNudgeEmptyThinking(input: EmptyThinkingNudgeInput): boolean {
    if (input.alreadyNudged || !isGrokModel(input.model) || input.priorAssistantCount < 1) {
        return false;
    }
    if (input.forceMidLoopStop) {
        return isNoToolStop(input.message);
    }
    return isEmptyThinkingStop(input.message);
}

export function testNudgeForced(agentDir = resolveAgentDir()): boolean {
    const envValue = process.env.PI_XAI_WS_TEST_NUDGE;
    if (envValue !== undefined) {
        const normalized = envValue.trim().toLowerCase();
        return normalized === "1" || normalized === "true";
    }
    if (agentDir === undefined) {
        return false;
    }
    try {
        return existsSync(join(agentDir, EMPTY_THINKING_TEST_NUDGE_FILENAME));
    } catch {
        return false;
    }
}

export function registerEmptyThinkingNudge(pi: ExtensionAPI): void {
    const sessions = new Map<string, SessionState>();

    const clearSession = (_event: unknown, ctx: ExtensionContext) => {
        sessions.delete(sessionKey(ctx));
    };

    pi.on("session_start", clearSession);
    pi.on("session_shutdown", clearSession);
    pi.on("agent_start", (_event, ctx) => {
        sessions.set(sessionKey(ctx), createEmptyThinkingNudgeState());
    });

    pi.on("turn_end", (event, ctx) => {
        const key = sessionKey(ctx);
        const state = sessions.get(key) ?? createEmptyThinkingNudgeState();
        const message = isRecord(event) ? event.message : undefined;
        const shouldNudge = shouldNudgeEmptyThinking({
            alreadyNudged: state.alreadyNudged,
            forceMidLoopStop: testNudgeForced(),
            message: isRecord(message) ? message : {},
            model: ctx.model,
            priorAssistantCount: state.priorAssistantCount,
        });
        if (isRecord(message) && message.role === "assistant") {
            state.priorAssistantCount += 1;
        }
        if (shouldNudge) {
            state.alreadyNudged = true;
            sendEmptyThinkingNudge(pi, ctx);
        }
        sessions.set(key, state);
    });
}

function sendEmptyThinkingNudge(pi: ExtensionAPI, ctx: ExtensionContext): void {
    try {
        pi.sendMessage({
            content: EMPTY_THINKING_NUDGE_TEXT,
            customType: EMPTY_THINKING_NUDGE_CUSTOM_TYPE,
            display: false,
        }, {
            deliverAs: "steer",
            triggerTurn: true,
        });
    } catch (error) {
        if (process.env.PI_XAI_WS_DEBUG === "1") {
            const reason = error instanceof Error ? error.message : "unknown";
            process.stderr.write(`[pi-xai-ws] empty-thinking nudge failed: ${reason}\n`);
        }
        return;
    }
    if (process.env.PI_XAI_WS_DEBUG === "1") {
        process.stderr.write("[pi-xai-ws] empty-thinking nudge queued deliverAs=steer\n");
    }
    if (ctx.hasUI) {
        ctx.ui.notify(EMPTY_THINKING_NUDGE_NOTIFY, "warning");
    }
}

function isCompletedStop(message: AssistantLike): boolean {
    if (message.stopReason !== "stop") {
        return false;
    }
    return message.rawStopReason === undefined || message.rawStopReason === "completed";
}

function sessionKey(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionId();
}

function resolveAgentDir(): string | undefined {
    try {
        return getAgentDir();
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
