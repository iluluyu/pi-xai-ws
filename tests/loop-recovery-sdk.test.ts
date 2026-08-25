import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxThinking,
} from "@earendil-works/pi-ai/providers/faux";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
    LOOP_RECOVERY_MARKER,
    registerLoopRecovery,
} from "../src/loop-recovery.ts";

it("runs sanitization, compaction, and recovery through Pi's real extension lifecycle", {
    timeout: 5_000,
}, async () => {
    const tmpRoot = join(process.cwd(), "tmp");
    mkdirSync(tmpRoot, { recursive: true });
    const agentDir = mkdtempSync(join(tmpRoot, "pi-xai-ws-loop-sdk-"));
    const cwd = process.cwd();
    const repeated = makeBlock(1_583);
    const faux = fauxProvider({
        api: "openai-responses",
        provider: "xai",
        models: [{
            contextWindow: 100_000,
            id: "grok-loop-test",
            maxTokens: 20_000,
            reasoning: true,
        }],
        tokensPerSecond: 1_000_000,
    });
    faux.setResponses([
        fauxAssistantMessage(fauxThinking(repeated.repeat(8))),
        fauxAssistantMessage("Compacted state with the user goal and next concrete action."),
        fauxAssistantMessage("RECOVERY_COMPLETE"),
    ]);
    const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const sessionManager = SessionManager.inMemory(cwd);
    for (let index = 0; index < 30; index += 1) {
        sessionManager.appendMessage({
            content: `Earlier context ${index}: preserve repository state and constraints.`,
            role: "user",
            timestamp: Date.now() + index,
        });
    }
    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, keepRecentTokens: 100, reserveTokens: 100 },
        retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
        agentDir,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        cwd,
        extensionFactories: [registerLoopRecovery],
        promptsOverride: () => ({ prompts: [], diagnostics: [] }),
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
        agentDir,
        cwd,
        model: faux.getModel(),
        modelRuntime,
        noTools: "all",
        resourceLoader,
        sessionManager,
        settingsManager,
        thinkingLevel: "high",
    });
    const eventTypes: string[] = [];
    const assistantEnds: Array<{
        content: unknown;
        stopReason: string;
    }> = [];
    let settledCount = 0;
    let resolveRecoverySettled!: () => void;
    const recoverySettled = new Promise<void>((resolve) => {
        resolveRecoverySettled = resolve;
    });
    session.subscribe((event) => {
        eventTypes.push(event.type);
        if (event.type === "message_end" && event.message.role === "assistant") {
            assistantEnds.push({
                content: event.message.content,
                stopReason: event.message.stopReason,
            });
        }
        if (event.type === "agent_settled") {
            settledCount += 1;
            if (settledCount === 2) {
                resolveRecoverySettled();
            }
        }
    });

    try {
        await session.prompt("Continue the implementation.");
        await recoverySettled;

        assert.equal(faux.state.callCount, 3);
        assert.equal(assistantEnds[0]?.stopReason, "aborted");
        const sanitized = assistantEnds[0]?.content as Array<Record<string, unknown>>;
        assert.equal(sanitized.length, 1);
        assert.equal(sanitized[0]?.type, "thinking");
        assert.ok(String(sanitized[0]?.thinking).endsWith(LOOP_RECOVERY_MARKER));
        assert.ok(String(sanitized[0]?.thinking).length < 200);
        assert.deepEqual(assistantEnds.at(-1), {
            content: [{ text: "RECOVERY_COMPLETE", type: "text" }],
            stopReason: "stop",
        });
        const firstSettled = eventTypes.indexOf("agent_settled");
        const compactionStart = eventTypes.indexOf("compaction_start");
        const compactionEnd = eventTypes.indexOf("compaction_end");
        const secondAgentStart = eventTypes.lastIndexOf("agent_start");
        assert.ok(firstSettled >= 0 && firstSettled < compactionStart);
        assert.ok(compactionStart < compactionEnd);
        assert.ok(compactionEnd < secondAgentStart);
        assert.ok(sessionManager.getBranch().some((entry) => entry.type === "compaction"));
        assert.ok(sessionManager.getBranch().some((entry) => entry.type === "custom_message"));
    } finally {
        session.dispose();
        rmSync(agentDir, { force: true, recursive: true });
    }
});

function makeBlock(length: number): string {
    let value = "";
    let index = 0;
    while (value.length < length) {
        value += `Distinct planning block ${index}: inspect lifecycle state, preserve completed work, and take the next concrete action. `;
        index += 1;
    }
    return value.slice(0, length);
}
