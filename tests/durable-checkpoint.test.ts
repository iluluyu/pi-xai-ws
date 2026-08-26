import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    DURABLE_CHECKPOINT_TTL_MS,
    readDurableCheckpoint,
    removeDurableCheckpoint,
    resetDurableCheckpointSweepForTests,
    resolveContinuationsDir,
    sweepDurableCheckpoints,
    writeDurableCheckpoint,
} from "../src/durable-checkpoint.ts";

const digest = `sha256:${"ab".repeat(32)}`;
const state = {
    coveredInputDigest: digest,
    coveredItemCount: 4,
    responseId: "resp_1",
};

const previousSessionsDir = process.env.PI_XAI_WS_SESSIONS_DIR;

afterEach(() => {
    if (previousSessionsDir === undefined) {
        delete process.env.PI_XAI_WS_SESSIONS_DIR;
    } else {
        process.env.PI_XAI_WS_SESSIONS_DIR = previousSessionsDir;
    }
});

describe("durable checkpoints", () => {
    it("round-trips a checkpoint for the same transport key", () => {
        writeDurableCheckpoint("session-a", "transport-a", state);
        assert.deepEqual(readDurableCheckpoint("session-a", "transport-a"), state);
        const path = join(resolveContinuationsDir(), "session-a.json");
        assert.equal(JSON.parse(readFileSync(path, "utf8")).transportFingerprint.length, 64);
        assert.doesNotMatch(readFileSync(path, "utf8"), /transport-a|Bearer|Authorization/i);
    });

    it("ignores and deletes a checkpoint for a different transport key", () => {
        writeDurableCheckpoint("session-a", "transport-a", state);
        assert.equal(readDurableCheckpoint("session-a", "transport-b"), undefined);
        assert.equal(existsSync(join(resolveContinuationsDir(), "session-a.json")), false);
    });

    it("ignores and deletes an expired checkpoint", () => {
        writeDurableCheckpoint("session-a", "transport-a", state);
        const path = join(resolveContinuationsDir(), "session-a.json");
        const record = JSON.parse(readFileSync(path, "utf8")) as { storedAt: string };
        record.storedAt = new Date(Date.now() - DURABLE_CHECKPOINT_TTL_MS - 1000).toISOString();
        writeFileSync(path, `${JSON.stringify(record)}\n`);
        assert.equal(readDurableCheckpoint("session-a", "transport-a"), undefined);
        assert.equal(existsSync(path), false);
    });

    it("does not persist an unsafe session id", () => {
        writeDurableCheckpoint("../escape", "transport-a", state);
        assert.equal(readDurableCheckpoint("../escape", "transport-a"), undefined);
        assert.equal(existsSync(join(resolveContinuationsDir(), "../escape.json")), false);
    });

    it("removeDurableCheckpoint deletes the sidecar", () => {
        writeDurableCheckpoint("session-a", "transport-a", state);
        removeDurableCheckpoint("session-a");
        assert.equal(existsSync(join(resolveContinuationsDir(), "session-a.json")), false);
    });

    it("sweep deletes expired and orphaned files and keeps live sessions", () => {
        const tmpRoot = join(process.cwd(), "tmp");
        mkdirSync(tmpRoot, { recursive: true });
        const sessionsDir = mkdtempSync(join(tmpRoot, "pi-xai-ws-sessions-"));
        process.env.PI_XAI_WS_SESSIONS_DIR = sessionsDir;
        mkdirSync(join(sessionsDir, "cwd"));
        writeFileSync(
            join(sessionsDir, "cwd", "2026-01-01T00-00-00-000Z_session-keep.jsonl"),
            "",
        );

        writeDurableCheckpoint("session-keep", "transport-a", state);
        writeDurableCheckpoint("session-gone", "transport-a", state);
        writeDurableCheckpoint("session-old", "transport-a", state);
        const oldPath = join(resolveContinuationsDir(), "session-old.json");
        const oldRecord = JSON.parse(readFileSync(oldPath, "utf8")) as { storedAt: string };
        oldRecord.storedAt = new Date(Date.now() - DURABLE_CHECKPOINT_TTL_MS - 1000).toISOString();
        writeFileSync(oldPath, `${JSON.stringify(oldRecord)}\n`);

        try {
            resetDurableCheckpointSweepForTests();
            sweepDurableCheckpoints("session-skip");
            assert.equal(existsSync(join(resolveContinuationsDir(), "session-keep.json")), true);
            assert.equal(existsSync(join(resolveContinuationsDir(), "session-gone.json")), false);
            assert.equal(existsSync(oldPath), false);
        } finally {
            rmSync(sessionsDir, { force: true, recursive: true });
        }
    });

    it("sweep skips the active session id", () => {
        const tmpRoot = join(process.cwd(), "tmp");
        mkdirSync(tmpRoot, { recursive: true });
        const sessionsDir = mkdtempSync(join(tmpRoot, "pi-xai-ws-sessions-"));
        process.env.PI_XAI_WS_SESSIONS_DIR = sessionsDir;
        writeDurableCheckpoint("session-active", "transport-a", state);
        try {
            resetDurableCheckpointSweepForTests();
            sweepDurableCheckpoints("session-active");
            assert.equal(existsSync(join(resolveContinuationsDir(), "session-active.json")), true);
        } finally {
            rmSync(sessionsDir, { force: true, recursive: true });
        }
    });
});
