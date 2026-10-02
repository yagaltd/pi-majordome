/**
 * pi-majordome docs digest — grounded doc generation.
 *
 * A "kind" is an instruction template with a {{digest}} placeholder:
 *   - built-ins: readme, changelog (shipped here)
 *   - custom: any ~/.pi/majordome/templates/<name>.md file — same shape,
 *     so HTML explanations, release emails, whatever need zero code.
 *
 * The digest is composed from the classified index (implementation and
 * documentation blocks, filtered since the doc's cursor when known) — every
 * line traces to a block, nothing is invented. The command layer sends
 * instruction+digest to the AGENT (pi.sendUserMessage); majordome never
 * writes docs itself.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shortTag } from "./core.ts";
import { majordomeDir, type Block } from "./store.ts";

export const DOC_INTENTS = new Set(["implementation", "documentation"]);

export const BUILTINS: Record<string, { instruction: string; cursorKey?: string }> = {
	readme: {
		cursorKey: "README",
		instruction:
			"[majordome docs · readme] Update README.md for this project based ONLY on the verified block digest below. Refresh features/usage sections the digest makes stale; do not invent features; keep the existing voice and structure.\n\nDigest:\n{{digest}}",
	},
	changelog: {
		cursorKey: "CHANGELOG",
		instruction:
			"[majordome docs · changelog] Append a new entry to CHANGELOG.md covering ONLY the work in the digest below — Keep a Changelog style, one bullet per block gist, today's date as the heading. Do not invent entries.\n\nDigest:\n{{digest}}",
	},
};

/** Doc-worthy blocks for a scope. scope: tag string, "all", or undefined =
 * current project (matched by session slug). since = ISO cursor. */
export function filterBlocks(blocks: Block[], scope: { tag?: string; slug?: string; since?: string }): Block[] {
	return blocks.filter(
		(b) =>
			DOC_INTENTS.has(b.intent ?? "") &&
			b.gist &&
			b.closedAt > (scope.since ?? "") &&
			(scope.all ||
				(scope.tag
					? shortTag(b.session).toLowerCase().includes(scope.tag.toLowerCase())
					: scope.slug
						? b.session === scope.slug
						: true)),
	);
}

export function digest(blocks: Block[]): string {
	return blocks
		.map(
			(b) =>
				`- [${shortTag(b.session)}:${b.firstTurn}] ${b.gist} (turns ${b.firstTurn}–${b.lastTurn}, ${b.intent ?? "?"})\n  first ask: "${b.head.slice(0, 90)}"`,
		)
		.join("\n");
}

export function templateDir(): string {
	return join(majordomeDir(), "templates");
}

/** All kinds: built-ins + custom template files (extension stripped). */
export function listKinds(): string[] {
	const custom = existsSync(templateDir())
		? readdirSync(templateDir()).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
		: [];
	return [...Object.keys(BUILTINS), ...custom];
}

/** Compose {instruction, digest} for a kind. Custom templates: the file IS the
 * instruction; {{digest}} is replaced. Returns null for unknown kinds. */
export function composeKind(kind: string, blocks: Block[]): { instruction: string; digest: string } | null {
	const d = digest(blocks);
	const builtin = BUILTINS[kind];
	if (builtin) return { instruction: builtin.instruction.replace("{{digest}}", d || "(no blocks in scope)"), digest: d };
	const f = join(templateDir(), `${kind}.md`);
	if (!existsSync(f)) return null;
	return { instruction: readFileSync(f, "utf8").replace("{{digest}}", d || "(no blocks in scope)"), digest: d };
}
