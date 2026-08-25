import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    LOOP_RECOVERY_COMPACTION_INSTRUCTIONS,
    LOOP_RECOVERY_CUSTOM_TYPE,
    LOOP_RECOVERY_MARKER,
    LOOP_RECOVERY_NOTIFY,
    LOOP_RECOVERY_TEXT,
    registerLoopRecovery,
    sanitizeRepetitiveAssistant,
    type LoopRecoveryPending,
} from "../src/loop-recovery.ts";

describe("sanitizeRepetitiveAssistant", () => {
    it("keeps a bounded unsigned prefix and drops later content", () => {
        const message = assistantMessage(1, [
            { thinking: "safe prefix repeated repeated", thinkingSignature: "secret", type: "thinking" },
            { text: "must not survive", textSignature: "signed", type: "text" },
        ]);
        message.responseId = "response-private";
        const pending: LoopRecoveryPending = {
            automaticRecovery: true,
            cleanPrefix: "safe prefix",
            contentIndex: 0,
            contentKind: "thinking",
            detection: {
                characterCount: 1_200,
                cleanPrefixLength: 11,
                kind: "exact",
                repeatPeriod: 500,
                repeatedCharacters: 1_000,
            },
        };

        const sanitized = sanitizeRepetitiveAssistant(message, pending);

        assert.deepEqual(sanitized.content, [{
            thinking: `safe prefix\n\n${LOOP_RECOVERY_MARKER}`,
            type: "thinking",
        }]);
        assert.equal(sanitized.responseId, undefined);
    });
});

describe("registerLoopRecovery", () => {
    it("aborts once, sanitizes, compacts, and queues one hidden recovery turn", () => {
        const harness = setupRecovery();
        const message = streamLoop(harness, 1);

        assert.equal(harness.aborts.length, 1);
        assert.deepEqual(harness.notifications[0], [LOOP_RECOVERY_NOTIFY, "warning"]);

        const replacement = emitFirst(harness.handlers, "message_end", { message }, harness.ctx) as {
            message: AssistantMessage;
        };
        const replacementBlock = replacement.message.content[0];
        const originalBlock = message.content[0];
        assert.ok(replacementBlock?.type === "thinking");
        assert.ok(originalBlock?.type === "thinking");
        assert.ok(replacementBlock.thinking.includes(LOOP_RECOVERY_MARKER));
        assert.ok(replacementBlock.thinking.length < originalBlock.thinking.length);

        emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);
        assert.equal(harness.compactions.length, 1);
        assert.equal(
            harness.compactions[0]?.customInstructions,
            LOOP_RECOVERY_COMPACTION_INSTRUCTIONS,
        );
        assert.equal(harness.messages.length, 0);

        harness.compactions[0]?.onComplete?.({});
        assert.deepEqual(harness.messages, [{
            content: LOOP_RECOVERY_TEXT,
            customType: LOOP_RECOVERY_CUSTOM_TYPE,
            deliverAs: "steer",
            display: false,
            triggerTurn: true,
        }]);
    });

    it("settles without another compaction when a second loop occurs soon", () => {
        const harness = setupRecovery();
        const first = streamLoop(harness, 1);
        const firstReplacement = emitFirst(
            harness.handlers,
            "message_end",
            { message: first },
            harness.ctx,
        ) as { message: AssistantMessage };
        emitFirst(harness.handlers, "turn_end", { message: firstReplacement.message }, harness.ctx);
        harness.compactions[0]?.onComplete?.({});

        const second = streamLoop(harness, 2);
        const secondReplacement = emitFirst(
            harness.handlers,
            "message_end",
            { message: second },
            harness.ctx,
        ) as { message: AssistantMessage };
        emitFirst(harness.handlers, "turn_end", { message: secondReplacement.message }, harness.ctx);

        assert.equal(harness.aborts.length, 2);
        assert.equal(harness.compactions.length, 1);
        assert.deepEqual(harness.notifications.at(-1), [
            "Stopped repetitive Grok output. Automatic recovery is paused because another loop occurred recently.",
            "error",
        ]);
    });

    it("reports the per-session limit separately from the cooldown", () => {
        const originalNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        try {
            const harness = setupRecovery();
            for (let timestamp = 1; timestamp <= 2; timestamp += 1) {
                const message = streamLoop(harness, timestamp);
                const replacement = emitFirst(
                    harness.handlers,
                    "message_end",
                    { message },
                    harness.ctx,
                ) as { message: AssistantMessage };
                emitFirst(
                    harness.handlers,
                    "turn_end",
                    { message: replacement.message },
                    harness.ctx,
                );
                harness.compactions.at(-1)?.onComplete?.({});
                now += 11 * 60_000;
            }

            const third = streamLoop(harness, 3);
            const replacement = emitFirst(
                harness.handlers,
                "message_end",
                { message: third },
                harness.ctx,
            ) as { message: AssistantMessage };
            emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);

            assert.equal(harness.compactions.length, 2);
            assert.deepEqual(harness.notifications.at(-1), [
                "Stopped repetitive Grok output. This session has reached its automatic recovery limit.",
                "error",
            ]);
        } finally {
            Date.now = originalNow;
        }
    });

    it("continues when Pi reports that compacting would be a no-op", () => {
        const harness = setupRecovery();
        const message = streamLoop(harness, 1);
        const replacement = emitFirst(
            harness.handlers,
            "message_end",
            { message },
            harness.ctx,
        ) as { message: AssistantMessage };
        emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);
        harness.compactions[0]?.onError?.(new Error("Nothing to compact (session too small)"));

        assert.equal(harness.notifications.length, 1);
        assert.deepEqual(harness.messages, [{
            content: LOOP_RECOVERY_TEXT,
            customType: LOOP_RECOVERY_CUSTOM_TYPE,
            deliverAs: "steer",
            display: false,
            triggerTurn: true,
        }]);
    });

    it("does not queue recovery after compaction fails", () => {
        const harness = setupRecovery();
        const message = streamLoop(harness, 1);
        const replacement = emitFirst(
            harness.handlers,
            "message_end",
            { message },
            harness.ctx,
        ) as { message: AssistantMessage };
        emitFirst(harness.handlers, "turn_end", { message: replacement.message }, harness.ctx);
        harness.compactions[0]?.onError?.(new Error("summary unavailable"));

        assert.equal(harness.messages.length, 0);
        assert.deepEqual(harness.notifications.at(-1), [
            "Repetitive-output recovery failed: summary unavailable",
            "error",
        ]);
    });

    it("ignores another provider", () => {
        const harness = setupRecovery({ id: "gpt-5.6-sol", provider: "openai-codex" });
        streamLoop(harness, 1);
        assert.equal(harness.aborts.length, 0);
        assert.equal(harness.compactions.length, 0);
    });
});

function assistantMessage(timestamp: number, content: AssistantMessage["content"] = []): AssistantMessage {
    return {
        api: "openai-responses",
        content,
        model: "grok-4.6",
        provider: "xai",
        role: "assistant",
        stopReason: "aborted",
        timestamp,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}

function emitFirst(
    handlers: Map<string, Array<(...args: any[]) => unknown>>,
    name: string,
    ...args: any[]
): unknown {
    return handlers.get(name)?.[0]?.(...args);
}

function setupRecovery(model = { id: "grok-4.6", provider: "xai" }) {
    const aborts: boolean[] = [];
    const compactions: Array<{
        customInstructions?: string;
        onComplete?: (result: unknown) => void;
        onError?: (error: Error) => void;
    }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const messages: Array<Record<string, unknown>> = [];
    const notifications: Array<[string, string]> = [];
    const pi = {
        on: (name: string, handler: (...args: any[]) => unknown) => {
            const current = handlers.get(name) ?? [];
            current.push(handler);
            handlers.set(name, current);
        },
        sendMessage: (
            message: Record<string, unknown>,
            options?: Record<string, unknown>,
        ) => messages.push({ ...message, ...options }),
    } as unknown as ExtensionAPI;
    registerLoopRecovery(pi);
    const ctx = {
        abort: () => aborts.push(true),
        compact: (options: typeof compactions[number]) => compactions.push(options),
        hasUI: true,
        model,
        sessionManager: { getSessionId: () => "loop-recovery-session" },
        ui: {
            notify: (message: string, level: string) => notifications.push([message, level]),
        },
    };
    emitFirst(handlers, "agent_start", {}, ctx);
    emitFirst(handlers, "turn_start", {}, ctx);
    return { aborts, compactions, ctx, handlers, messages, notifications };
}

function streamLoop(
    harness: ReturnType<typeof setupRecovery>,
    timestamp: number,
): AssistantMessage {
    emitFirst(harness.handlers, "agent_start", {}, harness.ctx);
    emitFirst(harness.handlers, "turn_start", {}, harness.ctx);
    const message = assistantMessage(timestamp, [{ thinking: "", type: "thinking" }]);
    const block = makeBlock(600).repeat(5);
    for (let offset = 0; offset < block.length && harness.aborts.length < timestamp; offset += 41) {
        const delta = block.slice(offset, offset + 41);
        const content = message.content[0];
        if (content?.type === "thinking") {
            content.thinking += delta;
        }
        emitFirst(harness.handlers, "message_update", {
            assistantMessageEvent: {
                contentIndex: 0,
                delta,
                partial: message,
                type: "thinking_delta",
            },
            message,
        }, harness.ctx);
    }
    return message;
}

function makeBlock(length: number): string {
    let value = "";
    let index = 0;
    while (value.length < length) {
        value += `Inspect boundary token${String.fromCharCode(97 + index % 26)} and preserve the next concrete action. `;
        index += 1;
    }
    return value.slice(0, length);
}
