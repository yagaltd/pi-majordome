/**
 * Governance-seed checks (v1.x): judgment trail roundtrip (isolated file),
 * codex ensure, doc-stamp presence in builtin instructions.
 * Run: npx tsx ext/selfcheck-governance.ts
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trail, trailFile } from "./trail.ts";
import { BUILTINS } from "./docs.ts";
import { ensureCodex, codexFile, CODEX } from "./codex.ts";

let fails = 0;
function check(name: string, ok: boolean) {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
	if (!ok) fails++;
}

// ── trail roundtrip in an isolated file ─────────────────────────────────
process.env.MAJORDOME_TRAIL_FILE = join(mkdtempSync(join(tmpdir(), "mjdx-")), "trails.jsonl");
trail("selfcheck", { ok: true, n: 1 });
trail("selfcheck", { ok: false });
const lines = readFileSync(trailFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("trail: two lines appended", lines.length === 2);
check("trail: schema (t/j/v present)", lines.every((l) => typeof l.t === "string" && typeof l.j === "string" && typeof l.v === "number"));
check("trail: payload roundtrip", lines[0].ok === true && lines[1].ok === false);
check("trail: metadata only (no content keys)", Object.keys(lines[0]).every((k) => ["t", "j", "v", "ok", "n"].includes(k)));

// ── codex ensure ────────────────────────────────────────────────────────
rmSync(codexFile(), { force: true });
const f = ensureCodex();
const first = readFileSync(f, "utf8");
ensureCodex();
check("codex: created on first ensure", existsSync(f));
check("codex: existing file wins (idempotent)", readFileSync(f, "utf8") === first);
check("codex: invariants present", ["MUST search before write", "NEVER rewrite", "FAIL OPEN", "human-only"].every((s) => CODEX.includes(s)));

// ── doc stamps ──────────────────────────────────────────────────────────
check("docs: readme builtin stamps generated_by", BUILTINS.readme.instruction.includes("generated_by: majordome"));
check("docs: changelog builtin stamps stale_after", BUILTINS.changelog.instruction.includes("stale_after"));
check("docs: verified is human-only", BUILTINS.readme.instruction.includes("NEVER add a `verified:`"));

process.exit(fails ? 1 : 0);
