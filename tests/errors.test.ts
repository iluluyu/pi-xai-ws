import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeXaiErrorMessage } from "../src/errors.ts";

describe("normalizeXaiErrorMessage", () => {
    it("maps xAI capacity wording to Pi's retryable overloaded vocabulary", () => {
        const currentMessage = "The model is currently at capacity due to high demand.";
        assert.equal(
            normalizeXaiErrorMessage(currentMessage),
            `Provider overloaded: ${currentMessage}`,
        );
        assert.equal(
            normalizeXaiErrorMessage("The service is unavailable due to high demand."),
            "Provider overloaded: The service is unavailable due to high demand.",
        );
        const transportMessage =
            "Error Code undefined: The model is currently at capacity due to high demand.";
        assert.equal(
            normalizeXaiErrorMessage(transportMessage),
            `Provider overloaded: ${transportMessage}`,
        );
    });

    it("maps xAI's hard socket limit to Pi's retryable WebSocket vocabulary", () => {
        const currentMessage =
            "Error Code websocket_connection_limit_reached: Responses websocket connection limit reached (25 minutes). Create a new websocket connection to continue.";
        assert.equal(
            normalizeXaiErrorMessage(currentMessage),
            `WebSocket error: ${currentMessage}`,
        );
        assert.equal(
            normalizeXaiErrorMessage(`WebSocket error: ${currentMessage}`),
            `WebSocket error: ${currentMessage}`,
        );
    });

    it("marks retryable socket failures without marking protocol failures", () => {
        assert.equal(
            normalizeXaiErrorMessage("read ECONNRESET", true),
            "WebSocket error: read ECONNRESET",
        );
        assert.equal(
            normalizeXaiErrorMessage("xAI WebSocket sent invalid JSON"),
            "xAI WebSocket sent invalid JSON",
        );
    });

    it("leaves normalized and unrelated errors unchanged", () => {
        const normalizedMessage =
            "Provider overloaded: The model is currently at capacity due to high demand.";
        assert.equal(normalizeXaiErrorMessage(normalizedMessage), normalizedMessage);
        assert.equal(normalizeXaiErrorMessage("Invalid API key"), "Invalid API key");
    });
});
