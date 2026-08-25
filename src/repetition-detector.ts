const CHECK_INTERVAL_CHARS = 64;
const EXACT_MAX_PERIOD_CHARS = 4_096;
const EXACT_MIN_PERIOD_CHARS = 80;
const EXACT_TAIL_CHARS = EXACT_MAX_PERIOD_CHARS * 2;
const LONG_EXACT_PERIOD_CHARS = 400;
const LOW_NOVELTY_CHECK_INTERVAL_CHARS = 2_048;
const LOW_NOVELTY_MIN_CHARS = 48_000;
const LOW_NOVELTY_PREVIOUS_CHARS = 48_000;
const LOW_NOVELTY_RECENT_CHARS = 8_000;
const NEAR_DUPLICATE_MIN_CHARS = 2_000;
const NEAR_DUPLICATE_SIMILARITY = 0.92;
const NEAR_DUPLICATE_WINDOW_CHARS = 1_024;
const WORD_GRAM_SIZE = 5;

export type RepetitionContentKind = "text" | "thinking";
export type RepetitionDetectorKind = "exact" | "low-novelty" | "near-duplicate";

export type RepetitionDetection = {
    characterCount: number;
    cleanPrefixLength: number;
    kind: RepetitionDetectorKind;
    repeatPeriod?: number;
    repeatedCharacters: number;
};

export type RepetitionDetectorOptions = {
    contentKind: RepetitionContentKind;
    lowNoveltyThreshold?: number;
};

export class RepetitionDetector {
    private absoluteCharacterCount = 0;
    private analyzedCharacterCount = 0;
    private exactTail = "";
    private fenceCarry = "";
    private insideFence = false;
    private lowNoveltyText = "";
    private nextLowNoveltyCheckAt = LOW_NOVELTY_MIN_CHARS;
    private nearDuplicateComparisons = 0;
    private nearDuplicateStart = 0;
    private nextCheckAt = CHECK_INTERVAL_CHARS;
    private segmentStart = 0;
    private readonly contentKind: RepetitionContentKind;
    private readonly lowNoveltyThreshold: number;

    constructor(options: RepetitionDetectorOptions) {
        this.contentKind = options.contentKind;
        this.lowNoveltyThreshold = clampRatio(options.lowNoveltyThreshold ?? 0.85);
    }

    append(delta: string): RepetitionDetection | undefined {
        if (this.contentKind === "thinking") {
            return this.appendAnalyzed(delta);
        }
        return this.appendVisible(delta);
    }

    private appendVisible(delta: string): RepetitionDetection | undefined {
        const source = this.fenceCarry + delta;
        this.fenceCarry = "";
        let offset = 0;
        while (offset < source.length) {
            const fenceAt = source.indexOf("```", offset);
            if (fenceAt === -1) {
                const unresolved = trailingBackticks(source.slice(offset));
                const resolvedEnd = source.length - unresolved.length;
                const detection = this.appendVisibleSegment(source.slice(offset, resolvedEnd));
                this.fenceCarry = unresolved;
                return detection;
            }
            const detection = this.appendVisibleSegment(source.slice(offset, fenceAt));
            if (detection) {
                return detection;
            }
            this.absoluteCharacterCount += 3;
            this.insideFence = !this.insideFence;
            this.resetAnalyzedSegment();
            offset = fenceAt + 3;
        }
        return undefined;
    }

    private appendVisibleSegment(value: string): RepetitionDetection | undefined {
        if (this.insideFence) {
            this.absoluteCharacterCount += value.length;
            return undefined;
        }
        return this.appendAnalyzed(value);
    }

    private appendAnalyzed(delta: string): RepetitionDetection | undefined {
        let remaining = delta;
        while (remaining.length > 0) {
            const untilCheck = Math.max(1, this.nextCheckAt - this.analyzedCharacterCount);
            const part = remaining.slice(0, untilCheck);
            remaining = remaining.slice(part.length);
            this.appendUnchecked(part);
            if (this.analyzedCharacterCount < this.nextCheckAt) {
                continue;
            }
            this.nextCheckAt += CHECK_INTERVAL_CHARS;
            const detection = this.detect();
            if (detection) {
                return detection;
            }
        }
        return undefined;
    }

    private appendUnchecked(delta: string): void {
        this.absoluteCharacterCount += delta.length;
        this.analyzedCharacterCount += delta.length;
        this.exactTail = keepTail(this.exactTail + delta, EXACT_TAIL_CHARS);
        this.lowNoveltyText = keepTail(
            this.lowNoveltyText + delta,
            LOW_NOVELTY_PREVIOUS_CHARS + LOW_NOVELTY_RECENT_CHARS,
        );
    }

    private detect(): RepetitionDetection | undefined {
        const frequentDetection = this.detectExact() ?? this.detectNearDuplicate();
        if (frequentDetection || this.analyzedCharacterCount < this.nextLowNoveltyCheckAt) {
            return frequentDetection;
        }
        this.nextLowNoveltyCheckAt = this.analyzedCharacterCount +
            LOW_NOVELTY_CHECK_INTERVAL_CHARS;
        return this.detectLowNovelty();
    }

    private detectExact(): RepetitionDetection | undefined {
        const reversed = reverseCodeUnits(this.exactTail);
        const z = zArray(reversed);
        const maxPeriod = Math.min(EXACT_MAX_PERIOD_CHARS, Math.floor(reversed.length / 2));
        for (let period = EXACT_MIN_PERIOD_CHARS; period <= maxPeriod; period += 1) {
            const copies = period >= LONG_EXACT_PERIOD_CHARS ? 2 : 3;
            const repeatedCharacters = period * copies;
            if (repeatedCharacters > reversed.length || z[period]! < period * (copies - 1)) {
                continue;
            }
            return {
                characterCount: this.absoluteCharacterCount,
                cleanPrefixLength: Math.max(
                    this.segmentStart,
                    this.segmentStart + this.analyzedCharacterCount - repeatedCharacters,
                ),
                kind: "exact",
                repeatPeriod: period,
                repeatedCharacters,
            };
        }
        return undefined;
    }

    private detectNearDuplicate(): RepetitionDetection | undefined {
        const pairChars = NEAR_DUPLICATE_WINDOW_CHARS * 2;
        if (this.lowNoveltyText.length < pairChars) {
            return undefined;
        }
        const pair = this.lowNoveltyText.slice(-pairChars);
        const previous = wordGramSet(pair.slice(0, NEAR_DUPLICATE_WINDOW_CHARS));
        const recent = wordGramSet(pair.slice(NEAR_DUPLICATE_WINDOW_CHARS));
        const similarity = jaccard(previous, recent);
        if (similarity < NEAR_DUPLICATE_SIMILARITY) {
            this.resetNearDuplicateSeries();
            return undefined;
        }
        if (this.nearDuplicateComparisons === 0) {
            this.nearDuplicateStart = this.analyzedCharacterCount - pairChars;
        }
        this.nearDuplicateComparisons += 1;
        const repeatedCharacters = this.analyzedCharacterCount -
            (this.nearDuplicateStart + NEAR_DUPLICATE_WINDOW_CHARS);
        if (this.nearDuplicateComparisons < 3 || repeatedCharacters < NEAR_DUPLICATE_MIN_CHARS) {
            return undefined;
        }
        return {
            characterCount: this.absoluteCharacterCount,
            cleanPrefixLength: Math.max(
                this.segmentStart,
                this.segmentStart + this.analyzedCharacterCount - repeatedCharacters,
            ),
            kind: "near-duplicate",
            repeatedCharacters,
        };
    }

    private detectLowNovelty(): RepetitionDetection | undefined {
        if (
            this.analyzedCharacterCount <= LOW_NOVELTY_MIN_CHARS ||
            this.lowNoveltyText.length < LOW_NOVELTY_RECENT_CHARS * 2
        ) {
            return undefined;
        }
        const split = this.lowNoveltyText.length - LOW_NOVELTY_RECENT_CHARS;
        const previous = wordGramSet(this.lowNoveltyText.slice(0, split));
        const recent = wordGrams(this.lowNoveltyText.slice(split));
        if (recent.length === 0) {
            return undefined;
        }
        let seen = 0;
        for (const gram of recent) {
            if (previous.has(gram)) {
                seen += 1;
            }
        }
        if (seen / recent.length < this.lowNoveltyThreshold) {
            return undefined;
        }
        return {
            characterCount: this.absoluteCharacterCount,
            cleanPrefixLength: Math.max(
                this.segmentStart,
                this.segmentStart + this.analyzedCharacterCount - LOW_NOVELTY_RECENT_CHARS,
            ),
            kind: "low-novelty",
            repeatedCharacters: LOW_NOVELTY_RECENT_CHARS,
        };
    }

    private resetAnalyzedSegment(): void {
        this.analyzedCharacterCount = 0;
        this.exactTail = "";
        this.lowNoveltyText = "";
        this.nextCheckAt = CHECK_INTERVAL_CHARS;
        this.nextLowNoveltyCheckAt = LOW_NOVELTY_MIN_CHARS;
        this.segmentStart = this.absoluteCharacterCount;
        this.resetNearDuplicateSeries();
    }

    private resetNearDuplicateSeries(): void {
        this.nearDuplicateComparisons = 0;
        this.nearDuplicateStart = 0;
    }
}

function clampRatio(value: number): number {
    if (!Number.isFinite(value)) {
        return 0.85;
    }
    return Math.min(1, Math.max(0, value));
}

function jaccard(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) {
        return 0;
    }
    let intersection = 0;
    for (const value of left) {
        if (right.has(value)) {
            intersection += 1;
        }
    }
    return intersection / (left.size + right.size - intersection);
}

function keepTail(value: string, maxChars: number): string {
    return value.length <= maxChars ? value : value.slice(-maxChars);
}

function normalizeForComparison(value: string): string[] {
    const normalized = value
        .toLowerCase()
        .replace(/^\s*\d+[.)]\s+/gm, " ")
        .replace(/\b\d+(?::\d+)*(?:[./-]\d+)*\b/g, " <number> ")
        .replace(/\s+/g, " ")
        .trim();
    return normalized.match(/[\p{L}\p{N}_<>-]+/gu) ?? [];
}

function reverseCodeUnits(value: string): string {
    let reversed = "";
    for (let index = value.length - 1; index >= 0; index -= 1) {
        reversed += value[index];
    }
    return reversed;
}

function trailingBackticks(value: string): string {
    const match = value.match(/`{1,2}$/);
    return match?.[0] ?? "";
}

function wordGrams(value: string): string[] {
    const words = normalizeForComparison(value);
    const grams: string[] = [];
    for (let index = 0; index + WORD_GRAM_SIZE <= words.length; index += 1) {
        grams.push(words.slice(index, index + WORD_GRAM_SIZE).join("\u0000"));
    }
    return grams;
}

function wordGramSet(value: string): Set<string> {
    return new Set(wordGrams(value));
}

function zArray(value: string): Uint32Array {
    const z = new Uint32Array(value.length);
    let left = 0;
    let right = 0;
    for (let index = 1; index < value.length; index += 1) {
        if (index <= right) {
            z[index] = Math.min(right - index + 1, z[index - left]!);
        }
        while (
            index + z[index]! < value.length &&
            value[z[index]!] === value[index + z[index]!]
        ) {
            z[index] += 1;
        }
        if (index + z[index]! - 1 > right) {
            left = index;
            right = index + z[index]! - 1;
        }
    }
    return z;
}
