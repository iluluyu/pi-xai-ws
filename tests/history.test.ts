import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    isResponsesThinkingSignature,
    limitContextImageBytes,
    sanitizeContextMessages,
} from "../src/history.ts";

describe("isResponsesThinkingSignature", () => {
    it("accepts a Responses reasoning item", () => {
        assert.equal(
            isResponsesThinkingSignature(JSON.stringify({ type: "reasoning", id: "rs_1" })),
            true,
        );
    });

    it("rejects Completions field names", () => {
        assert.equal(isResponsesThinkingSignature("reasoning_content"), false);
        assert.equal(isResponsesThinkingSignature("reasoning"), false);
        assert.equal(isResponsesThinkingSignature("reasoning_text"), false);
    });

    it("rejects arrays and invalid JSON", () => {
        assert.equal(isResponsesThinkingSignature("[]"), false);
        assert.equal(isResponsesThinkingSignature("{"), false);
    });
});

describe("sanitizeContextMessages", () => {
    it("strips legacy thinking signatures and keeps Responses ones", () => {
        const responsesSignature = JSON.stringify({ type: "reasoning", id: "rs_1" });
        const context = {
            systemPrompt: "sys",
            messages: [
                { role: "user", content: "hi" },
                {
                    role: "assistant",
                    api: "openai-responses",
                    provider: "xai",
                    model: "grok-4.6",
                    content: [
                        { type: "thinking", thinking: "old", thinkingSignature: "reasoning_content" },
                        { type: "thinking", thinking: "new", thinkingSignature: responsesSignature },
                        { type: "text", text: "hello" },
                    ],
                },
            ],
        };

        const sanitized = sanitizeContextMessages(context);
        const assistant = sanitized.messages[1] as {
            content: Array<{ type: string; thinkingSignature?: string }>;
        };

        assert.equal(assistant.content[0].thinkingSignature, undefined);
        assert.equal(assistant.content[1].thinkingSignature, responsesSignature);
        assert.equal(
            (context.messages[1] as { content: Array<{ thinkingSignature?: string }> }).content[0]
                .thinkingSignature,
            "reasoning_content",
        );
    });

    it("removes failed and aborted assistant attempts from provider context", () => {
        const context = {
            messages: [
                { role: "user", content: "start" },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "partial failure" }],
                    stopReason: "error",
                },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "partial abort" }],
                    stopReason: "aborted",
                },
                { role: "assistant", content: [{ type: "text", text: "complete" }], stopReason: "stop" },
                { role: "user", content: "continue" },
            ],
        };

        const sanitized = sanitizeContextMessages(context);

        assert.deepEqual(
            sanitized.messages.map((message) =>
                typeof message === "object" && message !== null && "role" in message
                    ? (message as { role: string }).role
                    : "unknown"
            ),
            ["user", "assistant", "user"],
        );
        assert.equal(context.messages.length, 5);
    });
});

describe("limitContextImageBytes", () => {
    it("keeps the newest screenshots and placeholders older ones", () => {
        const older = {
            role: "toolResult",
            content: [
                { type: "text", text: "first shot" },
                { type: "image", mimeType: "image/png", data: "A".repeat(100) },
            ],
        };
        const newer = {
            role: "toolResult",
            content: [
                { type: "text", text: "latest shot" },
                { type: "image", mimeType: "image/jpeg", data: "B".repeat(40) },
            ],
        };
        const context = { messages: [older, newer] };

        const limited = limitContextImageBytes(context, 50);
        const first = limited.messages[0] as {
            content: Array<{ type: string; text?: string; data?: string }>;
        };
        const second = limited.messages[1] as {
            content: Array<{ type: string; data?: string }>;
        };

        assert.deepEqual(first.content[1], {
            type: "text",
            text: "[omitted earlier screenshot: image/png]",
        });
        assert.equal(second.content[1]?.data, "B".repeat(40));
        assert.equal(
            (context.messages[0] as { content: Array<{ data?: string }> }).content[1]?.data,
            "A".repeat(100),
        );
    });

    it("always keeps the newest screenshot even when it exceeds the budget", () => {
        const context = {
            messages: [
                {
                    role: "toolResult",
                    content: [{ type: "image", mimeType: "image/png", data: "C".repeat(80) }],
                },
            ],
        };

        const limited = limitContextImageBytes(context, 20);
        const image = (limited.messages[0] as {
            content: Array<{ type: string; data?: string }>;
        }).content[0];
        assert.equal(image.type, "image");
        assert.equal(image.data, "C".repeat(80));
    });

    it("drops every older screenshot after the newest window fills", () => {
        const context = {
            messages: [
                {
                    role: "toolResult",
                    content: [{ type: "image", mimeType: "image/png", data: "D".repeat(10) }],
                },
                {
                    role: "toolResult",
                    content: [
                        { type: "image", mimeType: "image/png", data: "E".repeat(80) },
                        { type: "image", mimeType: "image/jpeg", data: "F".repeat(40) },
                    ],
                },
            ],
        };

        const limited = limitContextImageBytes(context, 50);
        const older = limited.messages[0] as { content: Array<{ type: string; text?: string }> };
        const newer = limited.messages[1] as {
            content: Array<{ type: string; data?: string; text?: string }>;
        };
        assert.deepEqual(older.content[0], {
            type: "text",
            text: "[omitted earlier screenshot: image/png]",
        });
        assert.deepEqual(newer.content[0], {
            type: "text",
            text: "[omitted earlier screenshot: image/png]",
        });
        assert.equal(newer.content[1]?.data, "F".repeat(40));
    });

    it("leaves contexts under the budget unchanged", () => {
        const context = {
            messages: [
                {
                    role: "user",
                    content: [{ type: "image", mimeType: "image/png", data: "D".repeat(10) }],
                },
            ],
        };
        assert.equal(limitContextImageBytes(context, 100), context);
    });
});
