const XAI_CAPACITY_ERROR_PATTERN =
    /\b(?:currently at capacity|due to high demand|temporarily unavailable|currently degraded)\b/i;
const XAI_CONNECTION_LIMIT_ERROR_PATTERN = /\bwebsocket_connection_limit_reached\b/i;

export function normalizeXaiErrorMessage(
    message: string,
    retryableWebSocket = false,
): string {
    if (
        (retryableWebSocket || XAI_CONNECTION_LIMIT_ERROR_PATTERN.test(message)) &&
        !/\bwebsocket\s+error\b/i.test(message)
    ) {
        return `WebSocket error: ${message}`;
    }
    if (/\boverloaded\b/i.test(message) || !XAI_CAPACITY_ERROR_PATTERN.test(message)) {
        return message;
    }
    return `Provider overloaded: ${message}`;
}
