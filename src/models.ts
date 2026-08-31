export type ModelLike = {
    id?: unknown;
    provider?: unknown;
};

/**
 * Non-chat xAI models. New Grok chat ids stay on the happy path unless they
 * match this list.
 */
const EXCLUDED_XAI_MODEL_ID_PATTERN = /(?:^|\/)grok-2-image(?:-|$)/i;

export function isXaiChatModel(model?: ModelLike): boolean {
    if (model?.provider !== "xai" || typeof model.id !== "string" || model.id.trim() === "") {
        return false;
    }
    return !EXCLUDED_XAI_MODEL_ID_PATTERN.test(model.id);
}
