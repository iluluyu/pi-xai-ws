import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingBlock = {
    type: "thinking";
    thinking?: string;
    thinkingSignature?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isResponsesThinkingSignature(signature: string): boolean {
    if (!signature.startsWith("{")) {
        return false;
    }
    try {
        const parsed = JSON.parse(signature) as unknown;
        return isRecord(parsed);
    } catch {
        return false;
    }
}

function sanitizeContentBlock(block: unknown): unknown {
    if (!isRecord(block) || block.type !== "thinking") {
        return block;
    }
    const thinking = block as ThinkingBlock;
    if (!thinking.thinkingSignature || isResponsesThinkingSignature(thinking.thinkingSignature)) {
        return block;
    }
    const { thinkingSignature: _dropped, ...rest } = thinking;
    return rest;
}

function isFailedAssistantMessage(message: unknown): boolean {
    return isRecord(message) &&
        message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted");
}

function sanitizeMessage(message: unknown): unknown {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
        return message;
    }
    return {
        ...message,
        content: message.content.map(sanitizeContentBlock),
    };
}

export function sanitizeContextMessages<T extends { messages: readonly unknown[] }>(context: T): T {
    return {
        ...context,
        messages: context.messages
            .filter((message) => !isFailedAssistantMessage(message))
            .map(sanitizeMessage),
    };
}

type ImageRef = {
    blockIndex: number;
    bytes: number;
    key: string;
    messageIndex: number;
};

const omittedImageKeysBySession = new Map<string, Set<string>>();

export function clearOmittedImages(sessionId: string | undefined): void {
    const key = sessionId?.trim();
    if (key) {
        omittedImageKeysBySession.delete(key);
    }
}

export function registerImageOmissionTracking(pi: ExtensionAPI): void {
    const clearSession = (_event: unknown, ctx: ExtensionContext) => {
        clearOmittedImages(ctx.sessionManager.getSessionId());
    };
    pi.on("session_start", clearSession);
    pi.on("session_shutdown", clearSession);
}

function imageBytes(block: Record<string, unknown>): number {
    return typeof block.data === "string" ? block.data.length : 0;
}

function omittedImageText(block: Record<string, unknown>): string {
    const mime = typeof block.mimeType === "string" && block.mimeType.trim() !== ""
        ? block.mimeType
        : "image";
    return `[omitted earlier screenshot: ${mime}]`;
}

function imageKey(block: Record<string, unknown>): string {
    const data = typeof block.data === "string" ? block.data : "";
    return createHash("sha256").update(data).digest("hex");
}

function omittedSet(sessionId: string | undefined): Set<string> | undefined {
    const key = sessionId?.trim();
    if (!key) {
        return undefined;
    }
    let omitted = omittedImageKeysBySession.get(key);
    if (!omitted) {
        omitted = new Set<string>();
        omittedImageKeysBySession.set(key, omitted);
    }
    return omitted;
}

/**
 * Keep the newest screenshots and replace older image bytes with a short
 * placeholder. xAI's Responses WebSocket closes with 1006 when a full-history
 * request carries tens of megabytes of screenshot data. Once a screenshot is
 * omitted for a session, later calls keep it omitted so the wire prefix does
 * not resurrect an older image when a new shot arrives.
 */
export function limitContextImageBytes<T extends { messages: readonly unknown[] }>(
    context: T,
    maxImageBytes: number,
    sessionId?: string,
): T {
    if (!Number.isFinite(maxImageBytes) || maxImageBytes <= 0) {
        return context;
    }

    const images: ImageRef[] = [];
    for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex += 1) {
        const message = context.messages[messageIndex];
        if (!isRecord(message) || !Array.isArray(message.content)) {
            continue;
        }
        message.content.forEach((block, blockIndex) => {
            if (!isRecord(block) || block.type !== "image") {
                return;
            }
            const bytes = imageBytes(block);
            if (bytes > 0) {
                images.push({ blockIndex, bytes, key: imageKey(block), messageIndex });
            }
        });
    }
    if (images.length === 0) {
        return context;
    }

    const omitted = omittedSet(sessionId);
    let keptBytes = 0;
    let dropping = false;
    const drop = new Set<string>();
    for (let index = images.length - 1; index >= 0; index -= 1) {
        const image = images[index];
        const sticky = Boolean(omitted?.has(image.key) && keptBytes > 0);
        if (!dropping && !sticky && (keptBytes === 0 || keptBytes + image.bytes <= maxImageBytes)) {
            keptBytes += image.bytes;
            continue;
        }
        if (!sticky) {
            dropping = true;
        }
        drop.add(`${image.messageIndex}:${image.blockIndex}`);
        omitted?.add(image.key);
    }
    if (drop.size === 0) {
        return context;
    }

    const messages = context.messages.map((message, messageIndex) => {
        if (!isRecord(message) || !Array.isArray(message.content)) {
            return message;
        }
        let changed = false;
        const content = message.content.map((block, blockIndex) => {
            if (!drop.has(`${messageIndex}:${blockIndex}`) || !isRecord(block)) {
                return block;
            }
            changed = true;
            return { type: "text", text: omittedImageText(block) };
        });
        return changed ? { ...message, content } : message;
    });

    if (process.env.PI_XAI_WS_DEBUG === "1") {
        process.stderr.write(
            `[pi-xai-ws] omitted ${drop.size} earlier screenshot(s) to stay under ${maxImageBytes} image bytes\n`,
        );
    }

    return { ...context, messages };
}
