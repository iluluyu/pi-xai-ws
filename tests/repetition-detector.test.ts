import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    RepetitionDetector,
    type RepetitionDetection,
} from "../src/repetition-detector.ts";

describe("RepetitionDetector", () => {
    it("detects a repeated 1,583-character block before 8,192 characters", () => {
        const block = makeBlock(1_583, "recorded incident regression ");
        const generated = block.repeat(36);
        const detection = feed(new RepetitionDetector({ contentKind: "thinking" }), generated);

        assert.ok(detection);
        assert.equal(detection.kind, "exact");
        assert.ok(detection.characterCount <= 8_192);
        assert.ok((generated.length - detection.characterCount) / generated.length >= 0.8);
    });

    it("detects short repeated phrases and alternating long blocks", () => {
        const phrase = "repeat the same short phrase with no useful progress ";
        const short = feed(
            new RepetitionDetector({ contentKind: "thinking" }),
            phrase.repeat(80),
        );
        assert.equal(short?.kind, "exact");

        const left = makeBlock(520, "left branch analysis ");
        const right = makeBlock(610, "right branch analysis ");
        const alternating = feed(
            new RepetitionDetector({ contentKind: "thinking" }),
            `${left}${right}`.repeat(5),
        );
        assert.equal(alternating?.kind, "exact");
    });

    it("detects repeated prose with changing counters and timestamps", () => {
        const detector = new RepetitionDetector({ contentKind: "thinking" });
        let detection: RepetitionDetection | undefined;
        for (let index = 1; index <= 20 && !detection; index += 1) {
            const prose = [
                `${index}. Review the implementation boundary and inspect the current state carefully.`,
                `At 2026-08-24 22:${String(index).padStart(2, "0")}:00 verify the transport lifecycle and retry decision.`,
                "Preserve completed work, compare the evidence, and continue with the next concrete action.",
                "Check the same invariants again because the generation has not made meaningful progress.",
            ].join(" ");
            detection = feed(detector, prose);
        }

        assert.ok(detection);
        assert.equal(detection.kind, "near-duplicate");
    });

    it("uses the low-novelty backstop for a non-adjacent repeated tail", () => {
        const detector = new RepetitionDetector({ contentKind: "thinking" });
        const paragraphs: string[] = [];
        let unique = "";
        for (let index = 0; unique.length < 52_000; index += 1) {
            paragraphs.push(
                `Evaluate ${alphabetic(index)} with distinct evidence, impact, constraints, and follow-up.`,
            );
            unique = paragraphs.join("\n");
        }
        const repeatedTail = unique.slice(12_000, 20_000);
        const detection = feed(detector, unique + repeatedTail);

        assert.ok(detection);
        assert.equal(detection.kind, "low-novelty");
    });

    it("weights repeated gram occurrences rather than only distinct grams", () => {
        const detector = new RepetitionDetector({ contentKind: "thinking" });
        const boilerplate = Array.from(
            { length: 50 },
            (_value, index) => `stable${alphabetic(index)}`,
        ).join(" ");
        let generated = "";
        for (let index = 0; generated.length < 80_000; index += 1) {
            generated += `${boilerplate} changing${alphabetic(index)}. `;
        }

        const detection = feed(detector, generated);
        assert.ok(detection);
        assert.equal(detection.kind, "low-novelty");
    });

    it("does not trigger on ordinary long reasoning within the stream budget", () => {
        const detector = new RepetitionDetector({ contentKind: "thinking" });
        const paragraphs: string[] = [];
        for (let index = 0; index < 2_000; index += 1) {
            const unique = alphabetic(index);
            paragraphs.push(
                `Investigate ${unique} with a distinct premise, evidence path, consequence, and next action.`,
            );
        }
        const startedAt = performance.now();
        assert.equal(feed(detector, paragraphs.join("\n")), undefined);
        assert.ok(performance.now() - startedAt < 4_000);
    });

    it("skips repeated fenced code in visible output", () => {
        const detector = new RepetitionDetector({ contentKind: "text" });
        const code = "```ts\nconst repeatedValue = calculateRepeatedValue();\n```\n".repeat(100);
        assert.equal(feed(detector, code), undefined);
    });

    it("resumes visible-output detection after a closed code fence", () => {
        const detector = new RepetitionDetector({ contentKind: "text" });
        const code = "```ts\nconst sample = usefulExample();\n```\n";
        const repeatedProse = makeBlock(600, "visible repeated conclusion ").repeat(4);
        const detection = feed(detector, code + repeatedProse);

        assert.ok(detection);
        assert.equal(detection.kind, "exact");
        assert.ok(detection.cleanPrefixLength >= code.length);
    });
});

function alphabetic(value: number): string {
    let result = "";
    let remaining = value;
    do {
        result = String.fromCharCode(97 + remaining % 26) + result;
        remaining = Math.floor(remaining / 26);
    } while (remaining > 0);
    return `token${result}`;
}

function feed(
    detector: RepetitionDetector,
    value: string,
): RepetitionDetection | undefined {
    for (let offset = 0; offset < value.length; offset += 37) {
        const detection = detector.append(value.slice(offset, offset + 37));
        if (detection) {
            return detection;
        }
    }
    return undefined;
}

function makeBlock(length: number, seed: string): string {
    let value = "";
    let index = 0;
    while (value.length < length) {
        value += `${seed}${alphabetic(index)} describes a different detail. `;
        index += 1;
    }
    return value.slice(0, length);
}
