import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContinuationState } from "./continuation.ts";

export const DURABLE_CHECKPOINT_VERSION = 1;
export const DURABLE_CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

type DurableCheckpointRecord = {
    coveredInputDigest: string;
    coveredItemCount: number;
    responseId: string;
    sessionId: string;
    storedAt: string;
    transportFingerprint: string;
    version: number;
};

let swept = false;

export function resetDurableCheckpointSweepForTests(): void {
    swept = false;
}

export function resolveContinuationsDir(): string {
    const override = process.env.PI_XAI_WS_CONTINUATIONS_DIR?.trim();
    if (override) {
        return override;
    }
    return join(getAgentDir(), "pi-xai-ws", "continuations");
}

export function resolveSessionsDir(): string {
    const override = process.env.PI_XAI_WS_SESSIONS_DIR?.trim();
    if (override) {
        return override;
    }
    return join(getAgentDir(), "sessions");
}

export function readDurableCheckpoint(
    sessionId: string,
    transportKey: string,
): ContinuationState | undefined {
    const path = checkpointPath(sessionId);
    if (!path) {
        return undefined;
    }
    const record = readRecord(path);
    if (!record) {
        removeFile(path);
        return undefined;
    }
    if (
        record.sessionId !== sessionId ||
        record.transportFingerprint !== fingerprint(transportKey) ||
        isExpired(record)
    ) {
        removeFile(path);
        return undefined;
    }
    return {
        coveredInputDigest: record.coveredInputDigest,
        coveredItemCount: record.coveredItemCount,
        responseId: record.responseId,
    };
}

export function writeDurableCheckpoint(
    sessionId: string,
    transportKey: string,
    state: ContinuationState,
): void {
    const path = checkpointPath(sessionId);
    if (!path) {
        return;
    }
    const dir = resolveContinuationsDir();
    mkdirSync(dir, { recursive: true });
    const record: DurableCheckpointRecord = {
        coveredInputDigest: state.coveredInputDigest,
        coveredItemCount: state.coveredItemCount,
        responseId: state.responseId,
        sessionId,
        storedAt: new Date().toISOString(),
        transportFingerprint: fingerprint(transportKey),
        version: DURABLE_CHECKPOINT_VERSION,
    };
    const tmpPath = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(tmpPath, `${JSON.stringify(record)}\n`);
        renameSync(tmpPath, path);
    } catch (error) {
        removeFile(tmpPath);
        throw error;
    }
}

export function removeDurableCheckpoint(sessionId: string): void {
    const path = checkpointPath(sessionId);
    if (path) {
        removeFile(path);
    }
}

export function sweepDurableCheckpoints(skipSessionId?: string): void {
    if (swept) {
        return;
    }
    swept = true;
    const dir = resolveContinuationsDir();
    if (!existsSync(dir)) {
        return;
    }
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    const sessionsDir = resolveSessionsDir();
    const sessionsDirExists = existsSync(sessionsDir);
    for (const name of names) {
        if (!name.endsWith(".json")) {
            continue;
        }
        const sessionId = name.slice(0, -".json".length);
        if (sessionId === skipSessionId) {
            continue;
        }
        const path = join(dir, name);
        const record = readRecord(path);
        if (!record || isExpired(record) || (sessionsDirExists && !hasSessionJsonl(sessionsDir, sessionId))) {
            removeFile(path);
        }
    }
}

function checkpointPath(sessionId: string): string | undefined {
    const trimmed = sessionId.trim();
    if (!SESSION_ID_PATTERN.test(trimmed)) {
        return undefined;
    }
    return join(resolveContinuationsDir(), `${trimmed}.json`);
}

function fingerprint(transportKey: string): string {
    return createHash("sha256").update(transportKey).digest("hex");
}

function isExpired(record: DurableCheckpointRecord): boolean {
    const storedAtMs = Date.parse(record.storedAt);
    return !Number.isFinite(storedAtMs) || Date.now() - storedAtMs > DURABLE_CHECKPOINT_TTL_MS;
}

function readRecord(path: string): DurableCheckpointRecord | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return asRecord(parsed);
    } catch {
        return undefined;
    }
}

function asRecord(value: unknown): DurableCheckpointRecord | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== DURABLE_CHECKPOINT_VERSION) {
        return undefined;
    }
    if (typeof record.sessionId !== "string" || !SESSION_ID_PATTERN.test(record.sessionId)) {
        return undefined;
    }
    if (typeof record.responseId !== "string" || record.responseId.trim() === "") {
        return undefined;
    }
    if (
        typeof record.coveredItemCount !== "number" ||
        !Number.isSafeInteger(record.coveredItemCount) ||
        record.coveredItemCount < 0
    ) {
        return undefined;
    }
    if (
        typeof record.coveredInputDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/i.test(record.coveredInputDigest)
    ) {
        return undefined;
    }
    if (
        typeof record.transportFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/i.test(record.transportFingerprint)
    ) {
        return undefined;
    }
    if (typeof record.storedAt !== "string" || !Number.isFinite(Date.parse(record.storedAt))) {
        return undefined;
    }
    return {
        coveredInputDigest: record.coveredInputDigest,
        coveredItemCount: record.coveredItemCount,
        responseId: record.responseId.trim(),
        sessionId: record.sessionId,
        storedAt: record.storedAt,
        transportFingerprint: record.transportFingerprint.toLowerCase(),
        version: DURABLE_CHECKPOINT_VERSION,
    };
}

function hasSessionJsonl(sessionsDir: string, sessionId: string): boolean {
    const suffix = `_${sessionId}.jsonl`;
    const exact = `${sessionId}.jsonl`;
    try {
        const entries = readdirSync(sessionsDir, { recursive: true, encoding: "utf8" });
        return entries.some((entry) => {
            const base = String(entry).split(/[/\\]/).pop() ?? "";
            return base === exact || base.endsWith(suffix);
        });
    } catch {
        return true;
    }
}

function removeFile(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // Missing or unreadable files are already unusable.
    }
}
