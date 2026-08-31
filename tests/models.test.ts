import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isXaiChatModel } from "../src/models.ts";

describe("isXaiChatModel", () => {
    it("treats xAI chat models as the happy path without an allowlist", () => {
        assert.equal(isXaiChatModel({ id: "grok-4.6", provider: "xai" }), true);
        assert.equal(isXaiChatModel({ id: "xai/grok-4.6", provider: "xai" }), true);
        assert.equal(isXaiChatModel({ id: "grok-5-future", provider: "xai" }), true);
        assert.equal(isXaiChatModel({ id: "some-other-model", provider: "xai" }), true);
    });

    it("excludes image-generation models and other providers", () => {
        assert.equal(isXaiChatModel({ id: "grok-2-image", provider: "xai" }), false);
        assert.equal(isXaiChatModel({ id: "grok-2-image-1212", provider: "xai" }), false);
        assert.equal(isXaiChatModel({ id: "xai/grok-2-image-1212", provider: "xai" }), false);
        assert.equal(isXaiChatModel({ id: "grok-4.6", provider: "openai" }), false);
        assert.equal(isXaiChatModel({ id: "grok-3", provider: "openrouter" }), false);
        assert.equal(isXaiChatModel(undefined), false);
        assert.equal(isXaiChatModel({ id: "", provider: "xai" }), false);
    });
});
