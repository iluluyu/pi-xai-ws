import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createEmptyThinkingNudgeState,
    EMPTY_THINKING_NUDGE_CUSTOM_TYPE,
    EMPTY_THINKING_NUDGE_NOTIFY,
    EMPTY_THINKING_NUDGE_TEXT,
    isEmptyThinkingStop,
    isNoToolStop,
    registerEmptyThinkingNudge,
    shouldNudgeEmptyThinking,
    testNudgeForced,
} from "../src/empty-thinking.ts";

const previousTestNudge = process.env.PI_XAI_WS_TEST_NUDGE;

afterEach(() => {
    restoreEnv("PI_XAI_WS_TEST_NUDGE", previousTestNudge);
});


describe("isEmptyThinkingStop", () => {
    it("matches a completed thinking-only stop", () => {
        assert.equal(isEmptyThinkingStop(thinkingOnly()), true);
        assert.equal(isEmptyThinkingStop({
            ...thinkingOnly(),
            rawStopReason: "completed",
        }), true);
    });

    it("rejects text, tools, errors, and empty content", () => {
        assert.equal(isEmptyThinkingStop({
            ...thinkingOnly(),
            content: [
                { type: "thinking", thinking: "plan" },
                { type: "text", text: "I'll retry." },
            ],
        }), false);
        assert.equal(isEmptyThinkingStop({
            ...thinkingOnly(),
            content: [
                { type: "thinking", thinking: "plan" },
                { type: "toolCall", name: "bash" },
            ],
        }), false);
        assert.equal(isEmptyThinkingStop({
            ...thinkingOnly(),
            stopReason: "error",
        }), false);
        assert.equal(isEmptyThinkingStop({
            ...thinkingOnly(),
            rawStopReason: "incomplete.max_output_tokens",
        }), false);
        assert.equal(isEmptyThinkingStop({
            ...thinkingOnly(),
            content: [],
        }), false);
    });
});

describe("shouldNudgeEmptyThinking", () => {
    it("nudges a mid-loop Grok thinking-only stop once", () => {
        assert.equal(shouldNudgeEmptyThinking({
            alreadyNudged: false,
            message: thinkingOnly(),
            model: grokModel(),
            priorAssistantCount: 1,
        }), true);
    });

    it("does not nudge the first assistant of a run", () => {
        assert.equal(shouldNudgeEmptyThinking({
            alreadyNudged: false,
            message: thinkingOnly(),
            model: grokModel(),
            priorAssistantCount: 0,
        }), false);
    });

    it("does not nudge after the first recovery", () => {
        assert.equal(shouldNudgeEmptyThinking({
            alreadyNudged: true,
            message: thinkingOnly(),
            model: grokModel(),
            priorAssistantCount: 2,
        }), false);
    });

    it("does not nudge a normal text close", () => {
        assert.equal(shouldNudgeEmptyThinking({
            alreadyNudged: false,
            message: {
                content: [{ type: "text", text: "Done." }],
                role: "assistant",
                stopReason: "stop",
            },
            model: grokModel(),
            priorAssistantCount: 1,
        }), false);
    });

    it("force mode treats a mid-loop no-tool stop as a nudge", () => {
        assert.equal(shouldNudgeEmptyThinking({
            alreadyNudged: false,
            forceMidLoopStop: true,
            message: {
                content: [{ type: "text", text: "PXWS_NUDGE_BEFORE" }],
                role: "assistant",
                stopReason: "stop",
            },
            model: grokModel(),
            priorAssistantCount: 1,
        }), true);
        assert.equal(isNoToolStop({
            content: [{ type: "text", text: "PXWS_NUDGE_BEFORE" }],
            role: "assistant",
            stopReason: "stop",
        }), true);
    });
});

describe("testNudgeForced", () => {
    it("honors PI_XAI_WS_TEST_NUDGE before the agent-dir file", () => {
        process.env.PI_XAI_WS_TEST_NUDGE = "1";
        assert.equal(testNudgeForced("/no/such/dir"), true);
        process.env.PI_XAI_WS_TEST_NUDGE = "0";
        assert.equal(testNudgeForced("/no/such/dir"), false);
    });
});

describe("registerEmptyThinkingNudge", () => {
    it("queues one hidden steer after a mid-loop thinking-only stop", () => {
        const { ctx, handlers, messages, notifications } = setupNudge();
        handlers.get("agent_start")?.({}, ctx);
        handlers.get("turn_end")?.({
            message: {
                content: [{ type: "toolCall", name: "bash" }],
                role: "assistant",
                stopReason: "toolUse",
            },
        }, ctx);
        handlers.get("turn_end")?.({ message: thinkingOnly() }, ctx);
        handlers.get("turn_end")?.({ message: thinkingOnly() }, ctx);

        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0], {
            deliverAs: "steer",
            triggerTurn: true,
            customType: EMPTY_THINKING_NUDGE_CUSTOM_TYPE,
            content: EMPTY_THINKING_NUDGE_TEXT,
            display: false,
        });
        assert.deepEqual(notifications, [[EMPTY_THINKING_NUDGE_NOTIFY, "warning"]]);
    });

    it("resets the once-flag on the next agent run", () => {
        const { ctx, handlers, messages } = setupNudge();
        handlers.get("agent_start")?.({}, ctx);
        handlers.get("turn_end")?.({
            message: {
                content: [{ type: "toolCall", name: "bash" }],
                role: "assistant",
                stopReason: "toolUse",
            },
        }, ctx);
        handlers.get("turn_end")?.({ message: thinkingOnly() }, ctx);
        handlers.get("agent_start")?.({}, ctx);
        handlers.get("turn_end")?.({
            message: {
                content: [{ type: "toolCall", name: "read" }],
                role: "assistant",
                stopReason: "toolUse",
            },
        }, ctx);
        handlers.get("turn_end")?.({ message: thinkingOnly() }, ctx);

        assert.equal(messages.length, 2);
    });

    it("does not nudge a non-Grok model", () => {
        const { ctx, handlers, messages } = setupNudge({
            id: "gpt-5.6-sol",
            provider: "openai-codex",
        });
        handlers.get("agent_start")?.({}, ctx);
        handlers.get("turn_end")?.({
            message: {
                content: [{ type: "toolCall", name: "bash" }],
                role: "assistant",
                stopReason: "toolUse",
            },
        }, ctx);
        handlers.get("turn_end")?.({ message: thinkingOnly() }, ctx);
        assert.equal(messages.length, 0);
    });
});

describe("createEmptyThinkingNudgeState", () => {
    it("starts unnudged with no prior assistants", () => {
        assert.deepEqual(createEmptyThinkingNudgeState(), {
            alreadyNudged: false,
            priorAssistantCount: 0,
        });
    });
});

function thinkingOnly() {
    return {
        content: [{ thinking: "review the helper", type: "thinking" }],
        role: "assistant",
        stopReason: "stop",
    };
}

function grokModel() {
    return { id: "grok-4.6", provider: "xai" };
}

function setupNudge(model = grokModel()) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const messages: Array<Record<string, unknown>> = [];
    const notifications: Array<[string, string]> = [];
    const pi = {
        on: (name: string, handler: (...args: any[]) => unknown) => {
            handlers.set(name, handler);
        },
        sendMessage: (
            message: Record<string, unknown>,
            options?: Record<string, unknown>,
        ) => {
            messages.push({ ...options, ...message });
        },
    } as unknown as ExtensionAPI;
    registerEmptyThinkingNudge(pi);
    const ctx = {
        hasUI: true,
        model,
        sessionManager: { getSessionId: () => "empty-thinking-session" },
        ui: {
            notify: (message: string, level: string) => notifications.push([message, level]),
        },
    };
    return { ctx, handlers, messages, notifications };
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
