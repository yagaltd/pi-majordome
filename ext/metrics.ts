/**
 * majordome text metrics — pure functions, no IO, no network. Bench-facing
 * measurement for the outputShape axis (shapebench): token estimate (chars/4,
 * cross-checked against a word-count estimator), Flesch reading ease, mean
 * sentence length, term-consistency ratio (STE-80% "one term per concept" —
 * stable vocabulary vs synonym churn), and a canned fact-retention check.
 * Deliberately NOT wired into the live extension — measurement only.
 *
 * Determinism contract: the syllable heuristic (vowel-group runs, silent
 * trailing e dropped except -le, minimum 1) defines the numbers. Fixture
 * expectations in shapebench are computed by THIS rule, not a dictionary.
 */

export function words(text: string): string[] {
	return text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
}

/** Canonical cheap proxy: ~4 chars per token, rounded up. */
export function estTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Cross-check estimator: ~1.3 tokens per word for English prose. */
export function estTokensWords(text: string): number {
	return Math.ceil(words(text).length * 1.3);
}

/** The two estimators agree within 2× — true for prose, false for non-prose
 * (symbol soup, one giant token). A disagreement means chars/4 is noise. */
export function tokenEstimatorsAgree(text: string): boolean {
	const a = estTokens(text);
	const b = estTokensWords(text);
	return a > 0 && b > 0 && a / b <= 2 && b / a <= 2;
}

export function sentences(text: string): string[] {
	return text
		.split(/[.!?]+(?:\s|$)/)
		.map((s) => s.trim())
		.filter((s) => words(s).length > 0);
}

/** Heuristic syllable count: [aeiouy]+ runs per word; silent trailing e
 * dropped (except the -le syllable as in "table"); minimum 1. */
export function syllables(word: string): number {
	const w = word.toLowerCase().replace(/[^a-z]/g, "");
	if (!w) return 0;
	const groups = w.match(/[aeiouy]+/g)?.length ?? 0;
	const silentE = w.endsWith("e") && groups > 1 && !w.endsWith("le");
	return Math.max(1, groups - (silentE ? 1 : 0));
}

/** Flesch reading ease = 206.835 − 1.015·(words/sentences) − 84.6·(syll/words).
 * Higher = easier. 0 when there is nothing to measure. */
export function fleschReadingEase(text: string): number {
	const ws = words(text);
	const ss = sentences(text);
	if (!ws.length || !ss.length) return 0;
	const syl = ws.reduce((n, w) => n + syllables(w), 0);
	return 206.835 - 1.015 * (ws.length / ss.length) - 84.6 * (syl / ws.length);
}

/** Mean words per sentence (sentence-fragment run-ons score high). */
export function avgSentenceLength(text: string): number {
	const ws = words(text);
	const ss = sentences(text);
	return ss.length ? ws.length / ss.length : 0;
}

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "was", "were", "be", "been",
	"it", "its", "as", "at", "by", "that", "this", "these", "those", "you", "your", "each", "after", "before",
	"again", "then", "now", "do", "does", "did", "not", "but", "from", "into", "when", "if",
]);

/** Term-consistency ratio (STE-80% "one term per concept"): share of content-
 * term occurrences (≥3 chars, non-stopword) covered by terms used ≥2×.
 * Stable vocabulary → high; synonym churn (parser/module/thing for one
 * concept, each used once) → 0. 0 when there are no content terms. */
export function termConsistency(text: string): number {
	const counts = new Map<string, number>();
	for (const w of words(text)) {
		const t = w.toLowerCase();
		if (t.length < 3 || STOPWORDS.has(t)) continue;
		counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	let total = 0;
	let stable = 0;
	for (const [t, c] of counts) {
		total += c;
		if (c >= 2) stable += c;
	}
	return total ? stable / total : 0;
}

/** Canned (deterministic, judge-free) fact retention: share of planted fact
 * phrases present as case-insensitive substrings. 0 facts → 1 (vacuous). */
export function factRetention(text: string, facts: string[]): number {
	if (!facts.length) return 1;
	const hay = text.toLowerCase();
	return facts.filter((f) => hay.includes(f.toLowerCase())).length / facts.length;
}
