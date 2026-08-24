import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerXaiProvider } from "./provider.ts";
import { registerStoredContextSafety } from "./stored-context.ts";
import { streamXaiResponsesWs } from "./stream.ts";

export default function (pi: ExtensionAPI) {
    registerXaiProvider(pi, streamXaiResponsesWs);
    registerStoredContextSafety(pi);
}
