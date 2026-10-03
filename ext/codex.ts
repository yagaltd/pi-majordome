/**
 * majordome codex — the push layer (v1.x governance seed).
 *
 * Invariants any session driving majordome MUST hold. Shipped as a file so it
 * is human-editable: the file at codexFile() wins over the default once it
 * exists (ensureCodex writes the default on first run only — never overwrites).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CODEX = `# majordome codex — invariants (push layer)

- MUST search before write: check the index (/majordome recall) before creating docs, skills, or claiming novelty.
- NEVER rewrite session JSONL files — the record is append-only truth; projections (index, map, docs) are derived and rebuildable.
- NEVER index raw messages; blocks and gists only. The index describes, never contains.
- Judges are soft: they inform; the agent decides.
- FAIL OPEN: missing keys, failed judges, absent files degrade to no-recall — never to errors surfaced at the user.
- NEVER forge "verified:" stamps — human-only. Machine output stamps "generated_by: majordome".
`;

export function codexFile(): string {
	return join(homedir(), ".config", "pi-majordome", "codex.md");
}

/** Write the default codex on first run; an existing file always wins. */
export function ensureCodex(): string {
	const f = codexFile();
	if (!existsSync(f)) {
		mkdirSync(join(homedir(), ".config", "pi-majordome"), { recursive: true });
		writeFileSync(f, CODEX);
	}
	return f;
}
