/**
 * Lifecycle fixtures generator (v2.4 bench-before-build) — deterministic
 * synthetic session transcripts with PLANTED ground-truth lifecycle states:
 *
 *   valid (default) | superseded | failed | speculative
 *
 * Corpus (14 tiny sessions, 13 planted turns):
 *   4 supersession chains — session A claims X, later session B contradicts
 *                           with Y → A planted superseded, B valid
 *   3 tried-and-failed     — "tried X, it failed / reverted" → failed
 *   4 never-contradicted   — valid controls (2 sessions × 2 plants; the two
 *                           plants in one session live in DIFFERENT blocks —
 *                           the generator asserts that)
 *   2 speculative          — hedged future talk → speculative
 *
 * Plus a hardcoded SANITY section with 2 REAL historical pairs from this
 * repo (markmap→termaid renderer switch; /majordome dashboard→dash rename).
 * Sanity pairs carry no fixture files — they document ground truth and are
 * excluded from numeric grading.
 *
 * Output layout under the target dir:
 *   sessions/<slug>/<fake-ts>.jsonl   pi session transcripts (message lines)
 *   fixtures_manifest.json            {ref → expectedStatus} + supersession
 *                                     pairs + recall probe definitions
 *
 * Determinism: no randomness, no clocks in transcript content (file names are
 * fixed fake timestamps). Manifest turnRefs are resolved against the REAL
 * boundary detector (ext/core.ts detectBoundaries) so blockFirstTurn is what
 * ingestion will actually produce — the generator self-validates: every plant
 * must land in exactly one block, and a block must never hold two plants with
 * different expected statuses.
 *
 *   npx tsx tools/gen_lifecycle_fixtures.ts [targetDir]   (default bench/lifecycle_fixtures)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectBoundaries, parseSession } from "../ext/core.ts";

export type LifecycleStatus = "valid" | "superseded" | "failed" | "speculative";

interface Turn {
	role: "user" | "assistant";
	text: string;
}

interface PlantSpec {
	turn: number; // 1-based user-turn number in the transcript
	expectedStatus: LifecycleStatus;
	label: string;
}

interface SessionSpec {
	slug: string;
	turns: Turn[];
	plants: PlantSpec[];
}

export interface PlantEntry {
	ref: string; // "<slug>@t<turn>"
	sessionSlug: string;
	turn: number; // user-turn number in the transcript
	blockFirstTurn: number; // resolved against detectBoundaries — the ingest key
	blockLastTurn: number;
	expectedStatus: LifecycleStatus;
	label: string;
}

export interface SupersessionPair {
	id: string;
	topic: string;
	older: string; // plant ref, expectedStatus superseded
	newer: string; // plant ref, expectedStatus valid
}

export interface LifecycleManifest {
	name: "lifecycle-fixtures";
	version: string;
	corpus: string;
	sessions: { slug: string; file: string; userTurns: number; blocks: number }[];
	plants: PlantEntry[];
	supersessionPairs: SupersessionPair[];
	recallProbes: {
		neutral: { id: string; query: string; excludedRefs: string[]; expectValidRefs: string[] }[];
		failureIntent: { id: string; query: string; requiredRefs: string[] }[];
	};
	sanity: {
		note: string;
		realPairs: {
			id: string;
			topic: string;
			olderClaim: string;
			newerClaim: string;
			olderExpected: LifecycleStatus;
			newerExpected: LifecycleStatus;
			evidence: string;
		}[];
	};
	generatedAt: string;
}

// ── the synthetic corpus (hand-written, deterministic) ──────────────────────
// Project: larkspur-exporter (synthetic). Assistant acks are terse and
// on-topic so block vocabulary stays where it belongs.

const u = (text: string): Turn => ({ role: "user", text });
const a = (text: string): Turn => ({ role: "assistant", text });

const SESSIONS: SessionSpec[] = [
	// ── chain 1: docs preview renderer (webview superseded by static-html) ──
	{
		slug: "lcb01",
		turns: [
			u("for the larkspur-exporter docs site we should render code previews with the webview panel, it gives live syntax highlighting"),
			a("noted — webview panel as the docs preview renderer."),
			u("confirmed: the webview panel is the docs preview renderer for larkspur-exporter, wiring it into the preview pipeline"),
			a("wiring the webview renderer into the preview pipeline."),
			u("the preview pipeline embeds the webview panel behind the docs feature flag"),
			a("webview embeds gated behind the docs flag."),
			u("webview previews ship with the next larkspur-exporter release"),
			a("webview previews scheduled for the release."),
		],
		plants: [{ turn: 3, expectedStatus: "superseded", label: "webview panel as docs preview renderer" }],
	},
	{
		slug: "lcb02",
		turns: [
			u("update on the docs previews: the webview panel broke sandboxing, larkspur-exporter switched code previews to the static-html renderer"),
			a("switching the preview renderer to static-html."),
			u("static-html renderer is the docs preview path now, the webview renderer is out"),
			a("static-html confirmed as the preview path; webview dropped."),
			u("the preview pipeline builds static-html templates, no live embeds"),
			a("preview pipeline now emits static-html only."),
			u("ship the static-html previews in this release"),
			a("static-html previews going out with the release."),
		],
		plants: [{ turn: 3, expectedStatus: "valid", label: "static-html renderer (supersedes webview)" }],
	},

	// ── chain 2: config format (settings.yaml superseded by settings.toml) ──
	{
		slug: "lcb03",
		turns: [
			u("moving larkspur-exporter config into settings.yaml so the presets stay readable"),
			a("config home is settings.yaml now."),
			u("decision: settings.yaml is the larkspur-exporter config format, all keys migrate there"),
			a("all config keys migrate to settings.yaml."),
			u("the loader will parse settings.yaml on startup"),
			a("startup parses settings.yaml."),
			u("document that settings.yaml is the single config file"),
			a("docs updated for the yaml config file."),
		],
		plants: [{ turn: 3, expectedStatus: "superseded", label: "settings.yaml as config format" }],
	},
	{
		slug: "lcb04",
		turns: [
			u("we dropped settings.yaml — the yaml indent bugs keep biting, larkspur-exporter config is settings.toml now"),
			a("config format is settings.toml; yaml retired."),
			u("settings.toml is the config file, the yaml loader is removed"),
			a("toml loader in, yaml loader removed."),
			u("keep settings.toml strict: unknown keys error out"),
			a("strict toml parsing, unknown keys rejected."),
			u("note in the readme that config lives in settings.toml"),
			a("readme points at settings.toml."),
		],
		plants: [{ turn: 2, expectedStatus: "valid", label: "settings.toml (supersedes settings.yaml)" }],
	},

	// ── chain 3: retry policy (fixed 2s delay superseded by exp backoff) ────
	{
		slug: "lcb05",
		turns: [
			u("for the webhook delivery worker let's retry failed posts 5 times with a fixed 2s delay"),
			a("webhook retries: 5 attempts, fixed 2s delay."),
			u("decision: the webhook retry policy is 5 attempts at fixed 2s delay"),
			a("fixed-delay retry policy locked in."),
			u("the delivery worker applies the fixed 2s retry schedule on every 5xx"),
			a("5xx responses follow the fixed retry schedule."),
			u("document the fixed-delay webhook retries for on-call"),
			a("on-call notes cover the fixed-delay retries."),
		],
		plants: [{ turn: 3, expectedStatus: "superseded", label: "5 attempts fixed 2s delay webhook retries" }],
	},
	{
		slug: "lcb06",
		turns: [
			u("the fixed-delay retries hammer the webhook receivers — larkspur-exporter moved to exponential backoff, 3 attempts"),
			a("retry policy now exponential backoff, 3 attempts."),
			u("exponential backoff with jitter is the webhook retry policy, fixed delay is wrong for receivers"),
			a("backoff-with-jitter adopted; fixed delay replaced."),
			u("cap the backoff at 30s so deliveries still land same-minute"),
			a("backoff capped at 30s."),
			u("update the worker config to the backoff schedule"),
			a("worker runs the backoff schedule."),
		],
		plants: [{ turn: 2, expectedStatus: "valid", label: "exponential backoff (supersedes fixed delay)" }],
	},

	// ── chain 4: test harness (legacy-runner superseded by vitest) ──────────
	{
		slug: "lcb07",
		turns: [
			u("integration tests for larkspur-exporter run through the legacy-runner harness, it already knows the fixture layout"),
			a("integration tests on the legacy-runner harness."),
			u("keep the legacy-runner harness as the integration test runner"),
			a("legacy-runner stays the integration runner."),
			u("the ci job invokes legacy-runner with the fixtures directory"),
			a("ci wired to legacy-runner + fixtures."),
			u("add a make target that wraps legacy-runner"),
			a("make target added around legacy-runner."),
		],
		plants: [{ turn: 2, expectedStatus: "superseded", label: "legacy-runner as integration harness" }],
	},
	{
		slug: "lcb08",
		turns: [
			u("legacy-runner is retired — larkspur-exporter integration tests run on the vitest harness now"),
			a("integration tests migrated to vitest."),
			u("vitest is the integration test harness, legacy-runner is deleted"),
			a("vitest confirmed; legacy-runner removed from the repo."),
			u("the ci job runs vitest with the fixtures directory"),
			a("ci invokes vitest against fixtures."),
			u("drop the legacy-runner make target"),
			a("legacy target dropped."),
		],
		plants: [{ turn: 2, expectedStatus: "valid", label: "vitest harness (supersedes legacy-runner)" }],
	},

	// ── tried-and-failed ────────────────────────────────────────────────────
	{
		slug: "lcb09",
		turns: [
			u("let's try redis as the cache layer for the export pipeline"),
			a("attempting redis as the cache layer."),
			u("tried the redis cache layer — it failed under load, timeouts everywhere, and we reverted to the in-memory lru cache"),
			a("redis attempt failed and was reverted; in-memory lru cache is back."),
			u("the in-memory lru cache stays until we understand the redis timeout spike"),
			a("lru cache retained; redis parked."),
		],
		plants: [{ turn: 2, expectedStatus: "failed", label: "redis cache layer — failed under load, reverted to lru" }],
	},
	{
		slug: "lcb10",
		turns: [
			u("for embedding external dashboards, try the full-page iframe approach"),
			a("trying the full-page iframe embed."),
			u("the iframe embed attempt failed — it broke csp on every portal page, so we reverted it"),
			a("iframe embed reverted after the csp breakage."),
			u("portal pages go back to server-side widgets until the csp story is solved"),
			a("server-side widgets restored on the portal."),
		],
		plants: [{ turn: 2, expectedStatus: "failed", label: "full-page iframe embed — broke csp, reverted" }],
	},
	{
		slug: "lcb11",
		turns: [
			u("attempt the schema migration with in-place alter scripts this time"),
			a("attempting in-place alter scripts for the migration."),
			u("the in-place alter scripts failed halfway and corrupted the staging index — we rolled back to the dump-and-restore migration"),
			a("in-place migration failed, rolled back; dump-and-restore is the migration path again."),
			u("keep the dump-and-restore migration as the documented procedure"),
			a("dump-and-restore documented as the migration procedure."),
		],
		plants: [{ turn: 2, expectedStatus: "failed", label: "in-place alter scripts — failed, rolled back to dump-and-restore" }],
	},

	// ── never-contradicted valid controls (2 sessions × 2 plants) ───────────
	// The two plants per session sit in DIFFERENT blocks (generator asserts).
	{
		slug: "lcb12",
		turns: [
			u("larkspur-exporter cli login uses the device-code grant, users approve in the browser"),
			a("device-code grant for cli login."),
			u("confirmed: cli auth is the device-code grant with a 15-minute polling window"),
			a("device-code grant, 15-minute polling window confirmed."),
			u("the refresh flow after device-code approval reuses the stored token"),
			a("refresh reuses the stored token."),
			u("document the device-code login steps for the cli readme"),
			a("cli readme documents device-code login."),
			u("for deploys: the staging cluster in the west region takes the rollout first"),
			a("deploys roll out to the west staging cluster first."),
			u("deploy order is staging cluster, then the east production region"),
			a("deploy order: staging, then east production."),
			u("the rollout scripts promote the same artifact through both regions"),
			a("rollout promotes one artifact across regions."),
			u("note the deploy regions in the ops runbook"),
			a("ops runbook lists the deploy regions."),
		],
		plants: [
			{ turn: 3, expectedStatus: "valid", label: "device-code grant for cli login (control)" },
			{ turn: 6, expectedStatus: "valid", label: "staging then east production deploy order (control)" },
		],
	},
	{
		slug: "lcb13",
		turns: [
			u("structured logs go through the pino pipeline, json lines to stdout"),
			a("logging via the pino pipeline, json to stdout."),
			u("decision: the pino pipeline is the structured logging path, redact request ids at the sink"),
			a("pino pipeline confirmed with request-id redaction."),
			u("the log pipeline adds a level gate for debug noise"),
			a("level gate added to the log pipeline."),
			u("document the pino pipeline flags in the runbook"),
			a("runbook documents the pino flags."),
			u("outbound calls in the gateway layer use the undici client with a ten-second timeout"),
			a("gateway uses undici, 10s timeout."),
			u("keep the undici client as the single http path, no per-route fetch"),
			a("undici is the single http path."),
			u("the gateway retries only idempotent calls through the undici pool"),
			a("idempotent gateway calls retry via the undici pool."),
			u("add the undici timeout to the ops dashboard"),
			a("dashboard shows the undici timeout."),
		],
		plants: [
			{ turn: 3, expectedStatus: "valid", label: "pino pipeline for structured logs (control)" },
			{ turn: 6, expectedStatus: "valid", label: "undici client with 10s timeout (control)" },
		],
	},

	// ── speculative (hedged future talk, 2 plants, one session) ─────────────
	{
		slug: "lcb14",
		turns: [
			u("maybe someday we could add a plugin system to larkspur-exporter"),
			a("noted as a maybe: a plugin system."),
			u("a plugin system might be worth exploring after the roadmap settles, no commitment"),
			a("plugin system stays speculative — no commitment."),
			u("another idea we might consider down the road is a rust rewrite of the parser core"),
			a("rust rewrite filed under might-consider."),
			u("no plans yet, just ideas floating: the plugin system and the rust rewrite"),
			a("both remain open ideas, nothing planned."),
		],
		plants: [
			{ turn: 2, expectedStatus: "speculative", label: "maybe plugin system (hedged future)" },
			{ turn: 3, expectedStatus: "speculative", label: "might-consider rust rewrite (hedged future)" },
		],
	},
];

// ── REAL historical sanity pairs (hardcoded, excluded from grading) ─────────

export const REAL_SANITY_PAIRS: LifecycleManifest["sanity"]["realPairs"] = [
	{
		id: "real-markmap-termaid",
		topic: "session-map renderer",
		olderClaim: "session map rendered as a markmap mindmap",
		newerClaim: "map display moved to the zero-dep termaid pane renderer — 'markmap dropped'",
		olderExpected: "superseded",
		newerExpected: "valid",
		evidence: "docs/OVERVIEW.md:246 ('markmap dropped: … termaid'); bench/resume_probes.json probe res-invalidated-markmap (query markmap, gold termaid)",
	},
	{
		id: "real-dashboard-dash",
		topic: "/majordome dashboard command name",
		olderClaim: "the /majordome dashboard command",
		newerClaim: "'dashboard moves to /majordome dash' — command renamed, /majordome orch kept as alias",
		olderExpected: "superseded",
		newerExpected: "valid",
		evidence: "commit 1ad0a3c 'naming consistency: bare /majordome = the orchestrator … dashboard moves to /majordome dash'; index.ts:367 (cmd === \"dash\")",
	},
];

// ── recall probes (leak checks + failure-intent checks) ─────────────────────
// Neutral queries: blocks whose ground-truth status is failed/superseded must
// NOT appear in the ranked recall results (default recall excludes them).
// Failure-intent queries: failed blocks MUST appear.

const RECALL_PROBES: LifecycleManifest["recallProbes"] = {
	neutral: [
		{ id: "neut-renderer", query: "which renderer renders the docs previews?", excludedRefs: ["lcb01@t3"], expectValidRefs: ["lcb02@t3"] },
		{ id: "neut-config", query: "where does the config file live?", excludedRefs: ["lcb03@t3"], expectValidRefs: ["lcb04@t2"] },
		{ id: "neut-retry", query: "how does the webhook retry policy work?", excludedRefs: ["lcb05@t3"], expectValidRefs: ["lcb06@t2"] },
		{ id: "neut-harness", query: "how do the integration tests run?", excludedRefs: ["lcb07@t2"], expectValidRefs: ["lcb08@t2"] },
		{ id: "neut-cache", query: "what cache layer is in place for the export pipeline?", excludedRefs: ["lcb09@t2"], expectValidRefs: [] },
		{ id: "neut-embed", query: "how do portal pages embed external dashboards?", excludedRefs: ["lcb10@t2"], expectValidRefs: [] },
		{ id: "neut-migrate", query: "how do we run schema migrations?", excludedRefs: ["lcb11@t2"], expectValidRefs: [] },
		{ id: "neut-login", query: "how does cli login work?", excludedRefs: [], expectValidRefs: ["lcb12@t3"] },
		{ id: "neut-http", query: "what http client do outbound gateway calls use?", excludedRefs: [], expectValidRefs: ["lcb13@t6"] },
	],
	failureIntent: [
		{ id: "fail-tried", query: "what did we try that failed?", requiredRefs: ["lcb09@t2", "lcb10@t2", "lcb11@t2"] },
		{ id: "fail-reverted", query: "which approaches did we revert?", requiredRefs: ["lcb09@t2", "lcb10@t2", "lcb11@t2"] },
		{ id: "fail-iframe", query: "did the iframe embed attempt go wrong?", requiredRefs: ["lcb10@t2"] },
		{ id: "fail-migrate", query: "show me the wrong path we took with the schema migration", requiredRefs: ["lcb11@t2"] },
	],
};

// ── generation + self-validation ────────────────────────────────────────────

function transcriptLines(spec: SessionSpec): string {
	return spec.turns
		.map((t) => JSON.stringify({ type: "message", message: { role: t.role, content: [{ type: "text", text: t.text }] } }))
		.join("\n") + "\n";
}

/** Generate the corpus into targetDir. Returns the validated manifest. */
export function generateLifecycleFixtures(targetDir: string): LifecycleManifest {
	const sessionsDir = join(targetDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });

	const plants: PlantEntry[] = [];
	const sessionRows: LifecycleManifest["sessions"] = [];

	for (let s = 0; s < SESSIONS.length; s++) {
		const spec = SESSIONS[s];
		const dir = join(sessionsDir, spec.slug);
		mkdirSync(dir, { recursive: true });
		// fixed fake timestamp → deterministic file name + mtime-independent
		const file = `2026-01-15T09-${String(s).padStart(2, "0")}-00-000Z.jsonl`;
		const path = join(dir, file);
		writeFileSync(path, transcriptLines(spec));

		// self-validation against the REAL parser + boundary detector: the
		// manifest must reference the blocks ingestion will actually produce.
		const turns = parseSession(path);
		if (turns.length !== spec.turns.filter((t) => t.role === "user").length) {
			throw new Error(`fixture ${spec.slug}: parser kept ${turns.length} turns, expected ${spec.turns.filter((t) => t.role === "user").length} (wrapper/skip rules changed?)`);
		}
		const bounds = detectBoundaries(turns);
		const blocks = bounds.map((first, i) => ({ first, end: i + 1 < bounds.length ? bounds[i + 1] - 1 : turns.length }));
		const byPlant = spec.plants.map((p) => {
			const blk = blocks.find((b) => p.turn >= b.first && p.turn <= b.end);
			if (!blk) throw new Error(`fixture ${spec.slug}: plant t${p.turn} not inside any block (bounds ${bounds.join(",")})`);
			return { ...p, blockFirstTurn: blk.first, blockLastTurn: blk.end };
		});
		// a block must never hold two plants with DIFFERENT expected statuses
		for (let i = 0; i < byPlant.length; i++) {
			for (let j = i + 1; j < byPlant.length; j++) {
				if (byPlant[i].blockFirstTurn === byPlant[j].blockFirstTurn && byPlant[i].expectedStatus !== byPlant[j].expectedStatus) {
					throw new Error(`fixture ${spec.slug}: block@${byPlant[i].blockFirstTurn} holds conflicting plants (${byPlant[i].expectedStatus} vs ${byPlant[j].expectedStatus}) — fix the transcript`);
				}
			}
		}
		for (const p of byPlant) {
			plants.push({
				ref: `${spec.slug}@t${p.turn}`,
				sessionSlug: spec.slug,
				turn: p.turn,
				blockFirstTurn: p.blockFirstTurn,
				blockLastTurn: p.blockLastTurn,
				expectedStatus: p.expectedStatus,
				label: p.label,
			});
		}
		sessionRows.push({ slug: spec.slug, file: `sessions/${spec.slug}/${file}`, userTurns: turns.length, blocks: bounds.length });
	}

	// cross-checks: every probe ref exists; every pair member exists
	const refs = new Set(plants.map((p) => p.ref));
	for (const q of [...RECALL_PROBES.neutral, ...RECALL_PROBES.failureIntent]) {
		const list = [...("excludedRefs" in q ? (q as any).excludedRefs ?? [] : []), ...("requiredRefs" in q ? (q as any).requiredRefs : []), ...((q as any).expectValidRefs ?? [])];
		for (const r of list) if (!refs.has(r)) throw new Error(`probe ${q.id}: unknown ref ${r}`);
	}

	const manifest: LifecycleManifest = {
		name: "lifecycle-fixtures",
		version: "v2.4-bench-before-build",
		corpus: "synthetic larkspur-exporter sessions with planted lifecycle ground truth (deterministic)",
		sessions: sessionRows,
		plants,
		supersessionPairs: [
			{ id: "ss-renderer", topic: "docs preview renderer", older: "lcb01@t3", newer: "lcb02@t3" },
			{ id: "ss-config", topic: "config format", older: "lcb03@t3", newer: "lcb04@t2" },
			{ id: "ss-retry", topic: "webhook retry policy", older: "lcb05@t3", newer: "lcb06@t2" },
			{ id: "ss-harness", topic: "integration test harness", older: "lcb07@t2", newer: "lcb08@t2" },
		],
		recallProbes: RECALL_PROBES,
		sanity: {
			note: "REAL historical pairs from this repo — hardcoded ground truth, no fixture files, excluded from numeric grading",
			realPairs: REAL_SANITY_PAIRS,
		},
		generatedAt: new Date().toISOString(),
	};

	// pair sanity: older must be planted superseded, newer valid
	for (const pair of manifest.supersessionPairs) {
		const older = plants.find((p) => p.ref === pair.older);
		const newer = plants.find((p) => p.ref === pair.newer);
		if (!older || !newer) throw new Error(`pair ${pair.id}: missing member`);
		if (older.expectedStatus !== "superseded" || newer.expectedStatus !== "valid") throw new Error(`pair ${pair.id}: statuses must be older=superseded newer=valid`);
	}

	writeFileSync(join(targetDir, "fixtures_manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
	return manifest;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const target = process.argv[2] || join(import.meta.dirname ?? "tools", "..", "bench", "lifecycle_fixtures");
	const manifest = generateLifecycleFixtures(target);
	const counts = manifest.plants.reduce<Record<string, number>>((m, p) => ({ ...m, [p.expectedStatus]: (m[p.expectedStatus] ?? 0) + 1 }), {});
	console.log(`lifecycle fixtures → ${target}`);
	console.log(`sessions: ${manifest.sessions.length}, plants: ${manifest.plants.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")})`);
	console.log(`supersession pairs: ${manifest.supersessionPairs.length}, recall probes: ${manifest.recallProbes.neutral.length} neutral / ${manifest.recallProbes.failureIntent.length} failure-intent`);
	console.log(`sanity real pairs: ${manifest.sanity.realPairs.map((p) => p.id).join(", ")}`);
	console.log(`manifest: ${join(target, "fixtures_manifest.json")}`);
}
