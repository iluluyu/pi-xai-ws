import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    clearOmittedImages,
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
                    model: "grok-4.7",
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

    it("does not resurrect a previously omitted screenshot when a newer one arrives", () => {
        const sessionId = "image-sticky-session";
        clearOmittedImages(sessionId);
        const older = {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/png", data: "A".repeat(20) }],
        };
        const middle = {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/png", data: "B".repeat(20) }],
        };
        const newest = {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/jpeg", data: "C".repeat(20) }],
        };

        const first = limitContextImageBytes({ messages: [older, middle, newest] }, 40, sessionId);
        const firstOlder = first.messages[0] as { content: Array<{ type: string; text?: string }> };
        assert.equal(firstOlder.content[0]?.type, "text");

        const later = limitContextImageBytes({ messages: [older, middle] }, 40, sessionId);
        const laterOlder = later.messages[0] as { content: Array<{ type: string; text?: string; data?: string }> };
        const laterMiddle = later.messages[1] as { content: Array<{ type: string; data?: string }> };
        assert.deepEqual(laterOlder.content[0], {
            type: "text",
            text: "[omitted earlier screenshot: image/png]",
        });
        assert.equal(laterMiddle.content[0]?.data, "B".repeat(20));
        clearOmittedImages(sessionId);
    });

    it("still keeps the newest screenshot after it was omitted in an earlier window", () => {
        const sessionId = "image-newest-session";
        clearOmittedImages(sessionId);
        const older = {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/png", data: "A".repeat(40) }],
        };
        const newer = {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/jpeg", data: "B".repeat(20) }],
        };
        limitContextImageBytes({ messages: [older, newer] }, 30, sessionId);
        const onlyOlder = limitContextImageBytes({ messages: [older] }, 30, sessionId);
        const image = (onlyOlder.messages[0] as {
            content: Array<{ type: string; data?: string }>;
        }).content[0];
        assert.equal(image.type, "image");
        assert.equal(image.data, "A".repeat(40));
        clearOmittedImages(sessionId);
    });
});
