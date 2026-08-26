import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "node:test";
import { resetDurableCheckpointSweepForTests } from "../src/durable-checkpoint.ts";

process.env.PI_XAI_WS_STORE = "0";

const tmpRoot = join(process.cwd(), "tmp");
mkdirSync(tmpRoot, { recursive: true });
const continuationsDir = mkdtempSync(join(tmpRoot, "pi-xai-ws-cont-"));
process.env.PI_XAI_WS_CONTINUATIONS_DIR = continuationsDir;

afterEach(() => {
    resetDurableCheckpointSweepForTests();
    try {
        for (const name of readdirSync(continuationsDir)) {
            rmSync(join(continuationsDir, name), { force: true });
        }
    } catch {
        // The temp directory is owned by this test process.
    }
});
