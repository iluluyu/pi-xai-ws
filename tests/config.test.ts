import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
    DEFAULT_MAX_STORED_CONTEXT_TOKENS,
    cacheAffinityEnabled,
    resolveMaxStoredContextTokens,
    resolveRequestLiveness,
    resolveWsUrl,
    storeResponsesEnabled,
} from "../src/config.ts";

function withConfigPath(run: (configPath: string) => void): void {
    const tmpRoot = join(process.cwd(), "tmp");
    mkdirSync(tmpRoot, { recursive: true });
    const configDir = mkdtempSync(join(tmpRoot, "pi-xai-ws-config-"));
    try {
        run(join(configDir, "pi-xai-ws.json"));
    } finally {
        rmSync(configDir, { force: true, recursive: true });
    }
}

describe("storeResponsesEnabled", () => {
    it("is off without a config file and accepts only boolean true", () => {
        const previous = process.env.PI_XAI_WS_STORE;
        try {
            delete process.env.PI_XAI_WS_STORE;
            withConfigPath((configPath) => {
                assert.equal(storeResponsesEnabled(configPath), false);
                writeFileSync(configPath, JSON.stringify({ storeResponses: false }));
                assert.equal(storeResponsesEnabled(configPath), false);
                for (const invalid of [
                    { storeResponses: "true" },
                    { storeResponses: 1 },
                    {},
                    [],
                    true,
                ]) {
                    writeFileSync(configPath, JSON.stringify(invalid));
                    assert.equal(storeResponsesEnabled(configPath), false);
                }
                writeFileSync(configPath, "not json");
                assert.equal(storeResponsesEnabled(configPath), false);
                writeFileSync(configPath, JSON.stringify({ storeResponses: true }));
                assert.equal(storeResponsesEnabled(configPath), true);
            });
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_STORE;
            } else {
                process.env.PI_XAI_WS_STORE = previous;
            }
        }
    });

    it("reads the default path from Pi's global agent directory", () => {
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousStore = process.env.PI_XAI_WS_STORE;
        try {
            delete process.env.PI_XAI_WS_STORE;
            withConfigPath((configPath) => {
                process.env.PI_CODING_AGENT_DIR = dirname(configPath);
                writeFileSync(configPath, JSON.stringify({ storeResponses: true }));
                assert.equal(storeResponsesEnabled(), true);
            });
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
            if (previousStore === undefined) {
                delete process.env.PI_XAI_WS_STORE;
            } else {
                process.env.PI_XAI_WS_STORE = previousStore;
            }
        }
    });

    it("lets an explicit environment value override the config file", () => {
        const previous = process.env.PI_XAI_WS_STORE;
        try {
            withConfigPath((configPath) => {
                writeFileSync(configPath, JSON.stringify({ storeResponses: true }));
                for (const value of ["", "0", "false", "no", "on", "yes"]) {
                    process.env.PI_XAI_WS_STORE = value;
                    assert.equal(storeResponsesEnabled(configPath), false);
                }
                for (const value of ["1", " 1 ", "true", "TRUE"]) {
                    process.env.PI_XAI_WS_STORE = value;
                    assert.equal(storeResponsesEnabled(configPath), true);
                }
            });
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_STORE;
            } else {
                process.env.PI_XAI_WS_STORE = previous;
            }
        }
    });
});

describe("resolveMaxStoredContextTokens", () => {
    it("uses a safe default and accepts positive integer overrides", () => {
        const previous = process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS;
        try {
            delete process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS;
            withConfigPath((configPath) => {
                assert.equal(
                    resolveMaxStoredContextTokens(configPath),
                    DEFAULT_MAX_STORED_CONTEXT_TOKENS,
                );
                writeFileSync(configPath, JSON.stringify({ maxStoredContextTokens: 180_000 }));
                assert.equal(resolveMaxStoredContextTokens(configPath), 180_000);
                process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS = "190000";
                assert.equal(resolveMaxStoredContextTokens(configPath), 190_000);
                for (const invalid of ["", "0", "-1", "1.5", "invalid"]) {
                    process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS = invalid;
                    assert.equal(resolveMaxStoredContextTokens(configPath), 180_000);
                }
                writeFileSync(configPath, JSON.stringify({ maxStoredContextTokens: 0 }));
                assert.equal(
                    resolveMaxStoredContextTokens(configPath),
                    DEFAULT_MAX_STORED_CONTEXT_TOKENS,
                );
            });
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS;
            } else {
                process.env.PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS = previous;
            }
        }
    });
});

describe("resolveRequestLiveness", () => {
    it("uses Pi's stream timeout unless the extension timeout is explicit", () => {
        const previousPing = process.env.PI_XAI_WS_PING_INTERVAL_MS;
        const previousLiveness = process.env.PI_XAI_WS_LIVENESS_TIMEOUT_MS;
        try {
            delete process.env.PI_XAI_WS_PING_INTERVAL_MS;
            delete process.env.PI_XAI_WS_LIVENESS_TIMEOUT_MS;
            assert.deepEqual(resolveRequestLiveness(300_000), {
                pingIntervalMs: 15_000,
                livenessTimeoutMs: 285_000,
            });
            assert.deepEqual(resolveRequestLiveness(10_000), {
                pingIntervalMs: 5_000,
                livenessTimeoutMs: 5_000,
            });
            process.env.PI_XAI_WS_LIVENESS_TIMEOUT_MS = "45000";
            assert.deepEqual(resolveRequestLiveness(300_000), {
                pingIntervalMs: 15_000,
                livenessTimeoutMs: 45_000,
            });
        } finally {
            if (previousPing === undefined) {
                delete process.env.PI_XAI_WS_PING_INTERVAL_MS;
            } else {
                process.env.PI_XAI_WS_PING_INTERVAL_MS = previousPing;
            }
            if (previousLiveness === undefined) {
                delete process.env.PI_XAI_WS_LIVENESS_TIMEOUT_MS;
            } else {
                process.env.PI_XAI_WS_LIVENESS_TIMEOUT_MS = previousLiveness;
            }
        }
    });
});

describe("cacheAffinityEnabled", () => {
    it("is on unless retention is none", () => {
        assert.equal(cacheAffinityEnabled(undefined), true);
        assert.equal(cacheAffinityEnabled("short"), true);
        assert.equal(cacheAffinityEnabled("none"), false);
    });
});

describe("resolveWsUrl", () => {
    it("derives the official socket from api.x.ai and refuses a proxy host", () => {
        const previous = process.env.PI_XAI_WS_URL;
        delete process.env.PI_XAI_WS_URL;
        try {
            assert.equal(resolveWsUrl(), "wss://api.x.ai/v1/responses");
            assert.equal(resolveWsUrl("https://api.x.ai/v1"), "wss://api.x.ai/v1/responses");
            assert.throws(
                () => resolveWsUrl("https://proxy.example/v1"),
                /Set PI_XAI_WS_URL/,
            );
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_URL;
            } else {
                process.env.PI_XAI_WS_URL = previous;
            }
        }
    });

    it("lets an explicit URL override a non-xAI baseUrl", () => {
        const previous = process.env.PI_XAI_WS_URL;
        process.env.PI_XAI_WS_URL = "wss://proxy.example/v1/responses";
        try {
            assert.equal(resolveWsUrl("https://proxy.example/v1"), "wss://proxy.example/v1/responses");
        } finally {
            if (previous === undefined) {
                delete process.env.PI_XAI_WS_URL;
            } else {
                process.env.PI_XAI_WS_URL = previous;
            }
        }
    });
});
