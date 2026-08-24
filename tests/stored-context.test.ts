import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeContextMessages } from "../src/history.ts";
import {
    estimateStoredRequestTokens,
    registerStoredContextSafety,
    setStoredContextSafetyActive,
} from "../src/stored-context.ts";

const previousStore = process.env.PI_XAI_WS_STORE;

afterEach(() => {
    restoreEnv("PI_XAI_WS_STORE", previousStore);
});

describe("estimateStoredRequestTokens", () => {
    it("uses reliable post-compaction usage plus trailing messages", () => {
        const messages = [
            assistantUsage(200_000, 50),
            { role: "compactionSummary", summary: "earlier work", timestamp: 100 },
            assistantUsage(250_000, 90),
            assistantUsage(0, 110, "error"),
            assistantUsage(20_000, 120),
            { role: "user", content: "x".repeat(400), timestamp: 130 },
        ];

        assert.equal(estimateStoredRequestTokens(messages, 0), 20_100);
    });

    it("does not trust retained pre-compaction assistant usage", () => {
        const messages = [
            { role: "compactionSummary", summary: "small summary", timestamp: 100 },
            assistantUsage(250_000, 90),
            { role: "user", content: "continue", timestamp: 110 },
        ];

        assert.equal(estimateStoredRequestTokens(messages, 0), 6);
    });

    it("detects Pi's converted compaction-summary message shape", () => {
        const summary = "The conversation history before this point was compacted into the following summary:\n\n<summary>\nsmall summary\n</summary>";
        const tokens = estimateStoredRequestTokens([
            { role: "user", content: [{ type: "text", text: summary }], timestamp: 100 },
            assistantUsage(250_000, 90),
            { role: "user", content: "continue", timestamp: 110 },
        ], 0);

        assert.ok(tokens < 100);
    });

    it("looks past a zero-usage provider error and counts its trailing content", () => {
        assert.equal(estimateStoredRequestTokens([
            assistantUsage(220_000, 10),
            {
                ...assistantUsage(0, 20, "error"),
                content: [{ type: "text", text: "x".repeat(400) }],
            },
        ], 0), 220_100);
    });

    it("uses nonzero provider-error usage as a conservative floor", () => {
        assert.equal(estimateStoredRequestTokens([
            assistantUsage(210_000, 10),
            assistantUsage(225_000, 20, "error"),
        ], 0), 225_000);
    });

    it("estimates the filtered provider context used by the live stream", () => {
        const context = sanitizeContextMessages({
            messages: [
                assistantUsage(210_000, 10),
                assistantUsage(225_000, 20, "error"),
            ],
        });

        assert.equal(estimateStoredRequestTokens(context.messages, 0), 210_000);
    });

    it("counts a large trailing tool result before the next stored request", () => {
        assert.equal(estimateStoredRequestTokens([
            assistantUsage(210_000, 10),
            {
                role: "toolResult",
                content: [{ type: "text", text: "x".repeat(160_000) }],
                timestamp: 20,
            },
        ], 0), 250_000);
    });

    it("estimates contexts without assistant usage instead of failing open", () => {
        assert.equal(estimateStoredRequestTokens([
            { role: "user", content: "x".repeat(880_000), timestamp: 10 },
        ], 0), 220_000);
    });

    it("includes system, tool, and hook additions in the prepared payload estimate", () => {
        assert.equal(estimateStoredRequestTokens([], 220_005), 220_005);
    });
});

describe("stored-response safety warning", () => {
    it("warns once when the request guard disables storage", () => {
        process.env.PI_XAI_WS_STORE = "1";
        const { ctx, handlers, notifications } = setupWarning("warning-session", true);

        handlers.get("session_start")?.({}, ctx);
        setStoredContextSafetyActive("warning-session", true);
        handlers.get("turn_end")?.({}, ctx);
        handlers.get("turn_end")?.({}, ctx);

        assert.deepEqual(notifications, [[
            "xAI's stored-response size limit is near. Using full-history requests until the context is compacted.",
            "warning",
        ]]);
    });

    it("waits for a UI before latching the warning", () => {
        process.env.PI_XAI_WS_STORE = "1";
        const { ctx, handlers, notifications } = setupWarning("late-ui-session", false);

        handlers.get("session_start")?.({}, ctx);
        setStoredContextSafetyActive("late-ui-session", true);
        handlers.get("turn_end")?.({}, ctx);
        ctx.hasUI = true;
        handlers.get("turn_end")?.({}, ctx);

        assert.equal(notifications.length, 1);
    });

    it("warns again after the guard becomes safe and later reactivates", () => {
        process.env.PI_XAI_WS_STORE = "1";
        const { ctx, handlers, notifications } = setupWarning("reactivated-session", true);

        handlers.get("session_start")?.({}, ctx);
        setStoredContextSafetyActive("reactivated-session", true);
        handlers.get("turn_end")?.({}, ctx);
        setStoredContextSafetyActive("reactivated-session", false);
        setStoredContextSafetyActive("reactivated-session", true);
        handlers.get("turn_end")?.({}, ctx);

        assert.equal(notifications.length, 2);
    });

    it("does not warn when stored responses are disabled", () => {
        process.env.PI_XAI_WS_STORE = "0";
        const { ctx, handlers, notifications } = setupWarning("disabled-session", true);

        handlers.get("session_start")?.({}, ctx);
        setStoredContextSafetyActive("disabled-session", true);
        handlers.get("turn_end")?.({}, ctx);

        assert.equal(notifications.length, 0);
    });
});

function assistantUsage(totalTokens: number, timestamp: number, stopReason = "stop") {
    return {
        role: "assistant",
        content: [],
        stopReason,
        timestamp,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            input: totalTokens,
            output: 0,
            totalTokens,
        },
    };
}

function setupWarning(sessionId: string, hasUI: boolean) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const notifications: Array<[string, string]> = [];
    const pi = {
        on: (name: string, handler: (...args: any[]) => unknown) => {
            handlers.set(name, handler);
        },
    } as unknown as ExtensionAPI;
    registerStoredContextSafety(pi);

    const ctx = {
        hasUI,
        model: { api: "openai-responses", provider: "xai" },
        sessionManager: { getSessionId: () => sessionId },
        ui: {
            notify: (message: string, level: string) => notifications.push([message, level]),
        },
    };
    return { ctx, handlers, notifications };
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
