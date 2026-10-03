/**
 * docs ingest adapter (v2.2) — md+frontmatter sources become index blocks so
 * retrieval spans chats AND curated documents (ADRs, specs, notes).
 *
 * Sources: ~/.config/pi-majordome/docs-sources.json → { "paths": [...] }
 * (files or dirs of *.md). Empty/absent = no-op. Synthesized blocks use
 * session `doc:<basename>` so /majordome forget/export treat them normally;
 * re-ingest replaces that path's blocks (idempotent). No dims — the bm25 arm
 * serves them (dims need the chat vocab; v2.3+ can induce).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tokens } from "./core.ts";
import { appendBlock, loadBlocks, rewriteBlocks, type Block } from "./store.ts";

export function sourcesFile(): string {
	return process.env.MAJORDOME_DOCS_SOURCES?.trim() || join(homedir(), ".config", "pi-majordome", "docs-sources.json");
}

function listMd(p: string): string[] {
	if (!existsSync(p)) return [];
	if (statSync(p).isFile()) return p.endsWith(".md") ? [p] : [];
	return readdirSync(p).filter((f) => f.endsWith(".md")).map((f) => join(p, f));
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string; bodyStart: number } {
	if (!text.startsWith("---")) return { meta: {}, body: text, bodyStart: 0 };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { meta: {}, body: text, bodyStart: 0 };
	const meta: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	const body = text.slice(end + 4);
	const bodyStart = text.slice(0, end + 4).split("\n").length;
	return { meta, body, bodyStart };
}

/** Ingest all configured sources. Returns {files, blocks} actually stored. */
export function ingestDocs(): { files: number; blocks: number } {
	let paths: string[] = [];
	const f = sourcesFile();
	if (existsSync(f)) {
		try {
			paths = JSON.parse(readFileSync(f, "utf8")).paths ?? [];
		} catch {
			return { files: 0, blocks: 0 };
		}
	}
	const files = paths.flatMap(listMd);
	let stored = 0;
	for (const file of files) {
		const base = file.split("/").pop()!.replace(/\.md$/, "");
		const session = `doc:${base}`;
		const raw = readFileSync(file, "utf8");
		const { meta, body, bodyStart } = parseFrontmatter(raw);
		const lines = body.split("\n");
		const mtime = statSync(file).mtime.toISOString();
		// sections split at ## headings; a leading pre-## chunk is section 0
		const sections: { start: number; end: number; title: string }[] = [];
		let cur = { start: 0, title: String(meta.title ?? base) };
		lines.forEach((l, i) => {
			if (/^## /.test(l)) {
				sections.push({ ...cur, end: i - 1 });
				cur = { start: i, title: l.replace(/^##\s*/, "").trim() };
			}
		});
		sections.push({ ...cur, end: lines.length - 1 });
		const kept = loadBlocks().filter((b) => b.session !== session);
		rewriteBlocks(kept);
		sections.forEach((sec, idx) => {
			const text = lines.slice(sec.start, sec.end + 1).join("\n").trim();
			if (!text || text.replace(/#/g, "").trim().length < 20) return;
			const absStart = bodyStart + sec.start;
			const b: Block = {
				id: `${session}:${absStart}`,
				session,
				sessionFile: file,
				firstTurn: absStart,
				lastTurn: bodyStart + sec.end,
				gist: idx === 0 && meta.description ? meta.description : `${sec.title} — ${text.split("\n").find((l) => l && !l.startsWith("#"))?.slice(0, 140) ?? sec.title}`,
				intent: "documentation",
				dims: {},
				tokensHybrid: [...tokens(text)],
				head: `[doc] ${meta.title ?? base} § ${sec.title}`,
				closedAt: mtime,
			};
			appendBlock(b);
			stored++;
		});
	}
	return { files: files.length, blocks: stored };
}
