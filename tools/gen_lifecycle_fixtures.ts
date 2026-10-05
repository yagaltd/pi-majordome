/**
 * Lifecycle fixtures generator (v2.4 bench-before-build; v2.5 IR + LongMemEval
 * + scale; v2.6 @slug hard-scope corpus) — deterministic synthetic session
 * transcripts with PLANTED ground-truth lifecycle states:
 *
 *   valid (default) | superseded | failed | speculative
 *
 * Corpus (18 tiny sessions, 15 planted turns):
 *   4 supersession chains — session A claims X, later session B contradicts
 *                           with Y → A planted superseded, B valid
 *   3 tried-and-failed     — "tried X, it failed / reverted" → failed
 *   4 never-contradicted   — valid controls (2 sessions × 2 plants; the two
 *                           plants in one session live in DIFFERENT blocks —
 *                           the generator asserts that)
 *   2 speculative          — hedged future talk → speculative
 *   4 cross-slug distractor sessions (v2.6) — a SECOND project (slugs
 *                           other-project, other-project-ui/api/labs): plain
 *                           valid decisions with overlapping generic
 *                           vocabulary (renderer, config, pipeline) but
 *                           disjoint specifics (kestrel vs larkspur), so
 *                           @slug hard-scope probes have topically-similar
 *                           cross-slug blocks to NOT bleed into. Template
 *                           discipline mirrors the filler: no hedge/attempt/
 *                           outcome/reversal tokens → they never trip
 *                           consolidation (they stay valid and can never act
 *                           as a superseding "newer" side).
 *
 * v2.5 LongMemEval ability probes (2-4 each):
 *   temporal    — the expected answer is the OLD (superseded) block
 *                 ("what did we decide before the X switch?"); routed via
 *                 TEMPORAL_INTENT_RE: include superseded, never failed
 *   aggregation — the answer spans TWO valid blocks from DIFFERENT sessions
 *                 (the federated per-session top-3 round-robin is the
 *                 mechanism); both refs must appear in top-k
 *   abstention  — topics that DO NOT exist in the corpus; expected: zero hits
 *                 above the score floor (generator asserts the probe shares
 *                 zero tokens with the whole corpus)
 *
 * v2.5 scale knob: --scale N emits N deterministic filler sessions (index-
 * driven template rotation — no randomness, no clocks) around the planted
 * corpus as plausible-but-unrelated engineering distractors. Default 0 keeps
 * the small corpus byte-identical.
 *
 * v2.6 @slug hard-scope probes — scoped queries name a slug with the @ sigil
 * ("@lcb02 which renderer renders the docs previews?") and must rank ONLY
 * that slug's blocks: 0 cross-slug leaks (no larkspur↔kestrel bleed, even
 * against the topically-similar other-project renderer block) and ≥1 expected
 * ref per scoped probe. An UNscoped query on the same other-project topic
 * must NOT hard-exclude the main blocks (no @token = no hard scope; priors
 * still rank).
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
import { detectBoundaries, parseSession, tokens } from "../ext/core.ts";
import { FAILURE_INTENT_RE, TEMPORAL_INTENT_RE } from "../ext/router.ts";

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
	temporalProbes: { id: string; query: string; expectedOldRefs: string[] }[];
	aggregationProbes: { id: string; query: string; expectedRefs: string[]; sessions: [string, string] }[];
	abstentionProbes: { id: string; query: string; topic: string }[];
	slugProbes: {
		scopedMain: { id: string; query: string; scope: string; expectedRefs: string[] }[];
		scopedOther: { id: string; query: string; scope: string; expectedRefs: string[] }[];
		unscopedOtherTopic: { id: string; query: string; expectMainRefs: string[] }[];
	};
	otherProject: { note: string; sessions: { slug: string; file: string; userTurns: number; blocks: number }[] };
	scale: number;
	filler: { count: number; turnsPerSession: number; slugs: string[]; otherCount: number; otherSlugs: string[] };
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

// ── cross-slug distractor project (v2.6) — the OTHER repo ────────────────────
// Product: kestrel-dashboard (synthetic). Four sessions across four slugs (a
// slug per session keeps block ids unique — init keys blocks by slug:turn).
// Template discipline: plain valid decisions, NO hedge/attempt/outcome/reversal
// tokens (consolidation never reassigns them and they can never supersede a
// larkspur block), and shared GENERIC vocabulary (renderer, config, pipeline,
// cache) with disjoint specifics — exactly the topically-similar-but-other-repo
// corpus that @slug hard scope must not bleed into.
const OTHER_SESSIONS: SessionSpec[] = [
	{
		slug: "other-project",
		turns: [
			u("kestrel-dashboard renders its landing widgets through the canvas painter, smooth animation on every tile"),
			a("canvas painter owns the landing widgets."),
			u("decision: the canvas painter is the widget renderer for kestrel-dashboard, registered in the paint loop"),
			a("canvas painter locked in as the widget renderer."),
			u("confirmed: widget rendering goes through the canvas painter pipeline, tiles repaint on data ticks"),
			a("widget rendering pipeline confirmed: canvas painter, repaint on ticks."),
			u("the paint loop batches widget frames so the dashboard stays smooth"),
			a("paint loop batches widget frames."),
			u("separate track: access controls move into config profiles, one profile per space"),
			a("access controls home in config profiles."),
			u("decision: config profiles feed the access rules, one profile per space"),
			a("config profiles feed the access rules, one per space."),
			u("profile edits hot-reload the affected rules without a restart"),
			a("profile edits hot-reload their rules."),
			u("document the config profile format in the team handbook"),
			a("handbook documents the config profile format."),
		],
		plants: [
			{ turn: 3, expectedStatus: "valid", label: "canvas painter widget rendering pipeline (other-project)" },
			{ turn: 6, expectedStatus: "valid", label: "config profiles feed access rules (other-project)" },
		],
	},
	{
		slug: "other-project-ui",
		turns: [
			u("kestrel-dashboard palettes read from design tokens, one palette per workspace"),
			a("palettes read from design tokens."),
			u("the palette compiler emits css variables from the token set"),
			a("palette compiler emits css variables."),
			u("chart tooltips share the palette tokens so colors stay consistent"),
			a("tooltips inherit palette colors."),
			u("high-contrast mode flips the palette without touching the tokens"),
			a("high-contrast flips the palette, tokens untouched."),
			u("the palette picker previews skins live on the gallery page"),
			a("palette picker previews skins live."),
			u("ship the palette compiler with the next kestrel release"),
			a("palette compiler ships next release."),
			u("tooltips delay 300ms so cursor sweeps stay quiet"),
			a("tooltip delay set to 300ms."),
			u("note the token naming rules in the design guide"),
			a("design guide notes token naming."),
		],
		plants: [],
	},
	{
		slug: "other-project-api",
		turns: [
			u("the kestrel sync client queues edits locally when the network drops"),
			a("edits queue locally offline."),
			u("decision: the sync client replays the queue in order once connectivity returns"),
			a("queue replays in order on reconnect."),
			u("each queued edit carries an idempotency key so replays never duplicate"),
			a("idempotency keys guard replays."),
			u("the queue drains with backoff when the server sheds load"),
			a("queue drains with backoff under load-shedding."),
			u("conflicts resolve last-writer-wins per field, never per record"),
			a("conflicts resolve per field."),
			u("the sync client batches queue frames to save battery on mobile"),
			a("queue frames batch to save battery."),
			u("log the queue depth so support can diagnose stuck devices"),
			a("queue depth logged for support."),
			u("document the replay order guarantees in the api guide"),
			a("api guide documents replay guarantees."),
		],
		plants: [],
	},
	{
		slug: "other-project-labs",
		turns: [
			u("kestrel labs sketched a standup digest that condenses each member's week"),
			a("standup digest sketched."),
			u("the digest drafts from activity threads, members edit before it sends"),
			a("digest drafts from threads, editable."),
			u("release trains roll every second tuesday, curated by the rotating captain"),
			a("release trains roll on tuesdays."),
			u("a train car holds merged work that passed the canary soak"),
			a("train cars hold canary-passed work."),
			u("the captain curates the train manifest from the merged queue"),
			a("captain curates the train manifest."),
			u("missed trains slide to the next slot, never force-shipped"),
			a("missed trains slide to the next slot."),
			u("labs notes stay internal until the digest proves useful"),
			a("labs notes stay internal for now."),
			u("write the train captain rotation into the team playbook"),
			a("playbook covers the captain rotation."),
		],
		plants: [],
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
		{ id: "neut-render2", query: "how are preview documents displayed?", excludedRefs: ["lcb01@t3"], expectValidRefs: ["lcb02@t3"] },
		{ id: "neut-cache2", query: "is there any caching on exports?", excludedRefs: ["lcb09@t2"], expectValidRefs: [] },
		{ id: "neut-login2", query: "authentication flow for the cli", excludedRefs: [], expectValidRefs: ["lcb12@t3"] },
		{ id: "neut-http2", query: "which library handles outbound gateway requests?", excludedRefs: [], expectValidRefs: ["lcb13@t6"] },
		{ id: "neut-embed2", query: "external dashboards inside portal pages — supported?", excludedRefs: ["lcb10@t2"], expectValidRefs: [] },
	],
	failureIntent: [
		{ id: "fail-tried", query: "what did we try that failed?", requiredRefs: ["lcb09@t2", "lcb10@t2", "lcb11@t2"] },
		{ id: "fail-reverted", query: "which approaches did we revert?", requiredRefs: ["lcb09@t2", "lcb10@t2", "lcb11@t2"] },
		{ id: "fail-iframe", query: "did the iframe embed attempt go wrong?", requiredRefs: ["lcb10@t2"] },
		{ id: "fail-migrate", query: "show me the wrong path we took with the schema migration", requiredRefs: ["lcb11@t2"] },
		{ id: "fail-deadend", query: "which attempts turned out to be dead ends?", requiredRefs: ["lcb09@t2", "lcb10@t2", "lcb11@t2"] },
		{ id: "fail-brittle", query: "which attempt proved brittle on export caching?", requiredRefs: ["lcb09@t2"] },
		{ id: "fail-flop", query: "which experiment flopped on the embeds?", requiredRefs: ["lcb10@t2"] },
		{ id: "fail-abandon", query: "what did we abandon during the migration work?", requiredRefs: ["lcb11@t2"] },
	],
};

// ── v2.6 @slug hard-scope probes ─────────────────────────────────────────────
// SCOPED queries carry @slug and must rank ONLY that slug's blocks: 0
// cross-slug leaks (the other-project renderer/config blocks are topically
// similar on purpose — that is the bleed the hard scope exists to stop) and
// ≥1 expected ref per probe. UNSCOPED same-topic queries must keep main
// blocks ranked: no @token = no hard scope, priors still do the ranking.
const SLUG_PROBES: LifecycleManifest["slugProbes"] = {
	scopedMain: [
		{ id: "slug-renderer", query: "@lcb02 which renderer renders the docs previews?", scope: "lcb02", expectedRefs: ["lcb02@t3"] },
		{ id: "slug-config", query: "@lcb04 where does the config file live?", scope: "lcb04", expectedRefs: ["lcb04@t2"] },
	],
	scopedOther: [
		{ id: "slug-other", query: "@other-project how does the widget renderer pipeline work?", scope: "other-project", expectedRefs: ["other-project@t3", "other-project@t6"] },
		{ id: "slug-other-case", query: "@Other-Project which config profiles feed the dashboards?", scope: "other-project", expectedRefs: ["other-project@t6"] },
	],
	unscopedOtherTopic: [
		{ id: "slug-unscoped", query: "how does the widget renderer pipeline work for the kestrel dashboards?", expectMainRefs: ["lcb02@t3"] },
	],
};

// ── v2.5 LongMemEval ability probes ──────────────────────────────────────────
// TEMPORAL: the expected answer is the OLD (superseded) generation. Queries
// deliberately avoid failure vocabulary (failures stay failure-intent-only)
// and carry TEMPORAL_INTENT_RE markers so routing includes + prefers the
// superseded block. Gate: ≥1 specific old ref appears in the ranked results.
const TEMPORAL_PROBES: LifecycleManifest["temporalProbes"] = [
	{ id: "temp-renderer", query: "what did we decide before the static-html renderer switch?", expectedOldRefs: ["lcb01@t3"] },
	{ id: "temp-config", query: "which config format did we use previously?", expectedOldRefs: ["lcb03@t3"] },
	{ id: "temp-retry", query: "what was the webhook retry policy before the backoff change?", expectedOldRefs: ["lcb05@t3"] },
	{ id: "temp-harness", query: "what's the history of the integration test harness?", expectedOldRefs: ["lcb07@t2"] },
];

// AGGREGATION: the answer spans two valid blocks from DIFFERENT sessions —
// exactly what the federated per-session top-3 round-robin merge exists for.
// Gate: BOTH refs appear in top-k (k pre-registered in the bench).
const AGGREGATION_PROBES: LifecycleManifest["aggregationProbes"] = [
	{ id: "agg-auth-logging", query: "how do cli login and the log pipeline work?", expectedRefs: ["lcb12@t3", "lcb13@t3"], sessions: ["lcb12", "lcb13"] },
	{ id: "agg-config-retry", query: "what did we settle for the config format and the webhook retry policy?", expectedRefs: ["lcb04@t2", "lcb06@t2"], sessions: ["lcb04", "lcb06"] },
	{ id: "agg-preview-tests", query: "which preview renderer ships, and what runs the integration tests?", expectedRefs: ["lcb02@t3", "lcb08@t2"], sessions: ["lcb02", "lcb08"] },
];

// ABSTENTION: topics that DO NOT exist anywhere in the corpus. Expected: zero
// ranked hits above the score floor. The generator asserts zero token overlap
// with the whole corpus (planted + filler) — any hit is definitionally false.
const ABSTENTION_PROBES: LifecycleManifest["abstentionProbes"] = [
	{ id: "abs-kubernetes", query: "anything about kubernetes?", topic: "kubernetes orchestration (absent)" },
	{ id: "abs-billing", query: "did billing invoices surface anywhere?", topic: "billing / invoicing (absent)" },
	{ id: "abs-darktheme", query: "was the dark theme ever discussed?", topic: "dark theme (absent)" },
	{ id: "abs-websocket", query: "any mention of websocket presence?", topic: "websocket presence channels (absent)" },
];

// ── scale knob: deterministic filler sessions (v2.5) ─────────────────────────// Index-driven template rotation — NO randomness, NO clocks. Plausible-but-
// unrelated engineering turns act as retrieval distractors around the planted
// corpus. Vocabulary rules (asserted below):
//   · no hedge/attempt/outcome/reversal tokens → filler blocks stay valid and
//     are never paired by consolidation (kept in sync with ext/consolidate.ts)
//   · no temporal/failure/abstention vocabulary → routing intents and the
//     abstention gate stay clean at scale
const FILLER_TOPICS: string[][] = [
	// cron scheduler
	["the nightly cron job should run in each tenant's timezone, not a global midnight", "nightly cron will follow tenant timezones.", "stagger the scheduler starts so the batch window never piles up", "scheduler starts are staggered.", "missed cron runs appear in the morning counters", "missed runs counted for the morning report.", "give the cron console a dry tick button for testing", "dry tick button on the cron console."],
	// rate limiter
	["gate the search endpoint with a token bucket limiter", "token bucket limiter guards the search endpoint.", "burst traffic gets a short grace window from the throttle", "throttle allows short bursts.", "when the quota is exhausted the api replies with a plain backpressure notice", "exhausted quota answers with backpressure.", "per-tenant ceilings live in the plan table", "ceilings keyed per tenant in the plan table."],
	// avatar uploads
	["profile avatars upload straight to object storage", "avatars land in object storage.", "generate a thumbnail at upload time, sized for cards and lists", "thumbnails generated on upload.", "strip location metadata from every avatar", "avatar metadata stripped.", "fall back to the initial monogram when no avatar exists", "monogram fallback for missing avatars."],
	// digest email
	["the weekly digest email summarizes unread activity per workspace", "weekly digest covers unread workspace activity.", "digest recipients can pause it from the preferences pane", "digest pausable from preferences.", "the smtp provider notifies bounces through a callback", "bounce callbacks handled.", "unsubscribe takes effect immediately, never on the next send", "unsubscribes apply immediately."],
	// typo tolerance
	["search should tolerate one typo per word on product names", "one-typo tolerance for product names.", "the fuzzy matcher scores candidates with a cheap distance heuristic", "fuzzy matcher uses a cheap distance heuristic.", "synonym pairs come from a curated list, not mined guesses", "synonyms curated, not mined.", "typo tolerance stays off for part numbers", "part numbers keep exact matching."],
	// onboarding
	["new workspaces get a first-run checklist with five steps", "five-step first-run checklist.", "the checklist skeleton stays visible until every step is complete", "checklist visible until complete.", "skip the wizard for invited teammates, they inherit setup", "invited teammates skip the wizard.", "onboarding progress persists across devices", "onboarding progress synced."],
	// audit trail
	["admin actions write to an append-only audit ledger", "audit ledger is append-only.", "each ledger row carries the actor, the object, and a content hash", "ledger rows carry actor, object, hash.", "the audit view paginates by month", "audit view paginated monthly.", "tamper detection re-hashes the chain nightly", "nightly re-hash guards the chain."],
	// gradual ramp
	["new features reach cohorts through a gradual ramp", "features ramp out by cohort.", "start cohorts at five percent, then widen twice daily", "ramp starts at five percent.", "a kill toggle yanks a feature from every cohort instantly", "kill toggle yanks features from every cohort.", "cohort assignment sticks per account, not per request", "cohort assignment sticky per account."],
	// receipts
	["paying accounts get a downloadable pdf receipt", "pdf receipts for paying accounts.", "the receipt footer carries the legal entity and vat id", "footer lists entity and vat id.", "receipts use a fixed layout so the printer-friendly version stays clean", "fixed layout for printer-friendly receipts.", "email the receipt within a minute of payment", "receipts emailed within a minute."],
	// push notifications
	["mobile push badges clear when the inbox opens", "push badges clear on inbox open.", "silent pushes refresh widgets without a banner", "silent pushes refresh widgets quietly.", "deeplinks from a push land on the exact thread", "push deeplinks land on the thread.", "quiet hours mute handset alerts overnight", "quiet hours mute overnight alerts."],
	// translations
	["the interface carries locales for five languages at launch", "five locales at launch.", "plural rules come from the locale data, never hardcoded", "plurals from locale data.", "the glossary keeps product names untranslated", "glossary protects product names.", "rtl layouts mirror the sidebar and breadcrumbs", "rtl mirrors sidebar and breadcrumbs."],
	// api spec
	["publish an openapi spec generated from the route table", "openapi spec generated from routes.", "codegen clients refresh whenever the spec changes", "codegen regenerates on spec changes.", "mark unstable paths with a dedicated stability marker", "unstable paths carry a stability marker.", "contract tests guard the published spec against drift", "contract tests catch spec drift."],
	// session expiry
	["idle workspaces expire after fourteen days of inactivity", "fourteen-day idleness expiry.", "expiry warnings appear three days ahead", "expiry warned three days ahead.", "reauth prompts keep the draft state intact", "reauth preserves drafts.", "kicked sessions end cleanly, with a grace window to reopen", "kicks end sessions with a reopen grace window."],
	// hotkeys
	["a command palette opens with a single chord", "palette opens on one chord.", "hotkey hints sit beside their menu items", "hints beside menu items.", "keybind remapping lives in preferences", "keybinds remappable in preferences.", "the palette fuzzy-matches commands with the same heuristic as typo tolerance", "palette reuses the fuzzy heuristic."],
	// csv import
	["bulk imports accept csv with a configurable delimiter", "csv imports with configurable delimiter.", "the importer maps header names to fields, remembering the mapping", "header mapping remembered.", "row-level problems land in a downloadable rejects file", "rejects downloadable per row.", "imports run asynchronously with a progress readout", "imports async with progress."],
	// uptime pinger
	["a lightweight pinger checks the public heartbeat every minute", "pinger checks the heartbeat each minute.", "downtime longer than two minutes pages the on-call rotation", "two-minute downtime pages on-call.", "the uptime readout keeps ninety days of samples", "ninety days of uptime samples.", "maintenance windows suppress pager noise", "maintenance windows silence the pager."],
	// emoji reactions
	["message reactions use the standard unicode set", "reactions on the standard unicode set.", "the picker groups emoji by category with a recents row", "picker groups by category, recents row.", "skin-tone choices persist per account", "skin tones persisted.", "reaction counts collapse past ten distinct choices", "counts collapse after ten choices."],
	// query planner
	["slow reads traced to a mis-estimated planner choice", "planner mis-estimates traced.", "a covering btree removes the sort from the hot path", "covering btree skips the sort.", "nightly vacuum keeps the bloat bounded", "vacuum bounds bloat nightly.", "explain output attached to slow-read reports", "explain attached to slow reads."],
	// print styles
	["the printable stylesheet hides chrome and fits a4 margins", "print stylesheet strips chrome, a4 margins.", "paginated output keeps table headers on every page", "headers repeat on every printed page.", "widow lines get a minimum of two", "widow minimum of two lines.", "a dedicated print button bypasses the app shell", "print button bypasses the shell."],
	// announcements feed
	["an announcements feed condenses weekly highlights per workspace", "announcements feed condenses weekly highlights.", "each recap links the items it mentions", "recaps link their items.", "subscribers choose a delivery day", "subscribers pick the delivery day.", "the feed archives older recaps for a year", "recaps archived for a year."],
];
const FILLER_TURNS_PER_SESSION = 16; // 4 topics × 4 turns

// v2.6: scale-tier filler for the SECOND project — same template discipline,
// kestrel-flavored topics, distinct slugs (other-project-xNN) so the cross-slug
// corpus mass grows with the scale tier too. Zero at scale=0 (small corpus
// byte-identical to pre-v2.6 plus the four base other-project sessions).
const OTHER_FILLER_TOPICS: string[][] = [
	// sparklines
	["sparklines render from the same widget metrics as the big charts", "sparklines share widget metrics.", "the metrics sampler buckets activity by hour", "sampler buckets activity hourly.", "sparkline baselines smooth over weekend dips", "baselines smooth weekend dips.", "the widget legend hides on narrow tiles", "legend hides on narrow tiles."],
	// alert routing
	["alert routes pick the on-call rotation by severity", "alert routes follow severity.", "low-severity alerts batch into the morning recap", "low alerts batch into the recap.", "the escalation ladder pages the secondary after twenty minutes", "escalation pages secondary at twenty minutes.", "muted routes log silently for the audit", "muted routes log silently."],
	// embed tokens
	["embedded views authenticate with short-lived embed tokens", "embeds authenticate with short-lived tokens.", "the token mint caps each embed at a single referrer", "token mint caps one referrer per embed.", "expired embeds show a friendly refresh card", "expired embeds show a refresh card.", "the embed sdk keeps a tiny footprint, under forty kilobytes", "embed sdk stays under forty kilobytes."],
	// heatmap view
	["the heatmap view shades tiles by activity density", "heatmap shades tiles by density.", "dense hours get a hover breakdown per member", "dense hours break down per member.", "the heatmap legend doubles as a time scrubber", "legend doubles as a scrubber.", "weekend columns collapse when the workspace skips them", "weekend columns collapse when skipped."],
];
const otherFillerCount = (scale: number): number => Math.min(8, Math.ceil(scale / 8));

function fillerSessionSpec(index: number): { slug: string; file: string; turns: Turn[] } {
	// rotation: (index*3 + topicSlot*5) mod 20 — every session gets 4 distinct
	// topics; across 60 sessions all 20 topics appear in shifting company
	const turns: Turn[] = [];
	for (let k = 0; k < 4; k++) {
		const topic = FILLER_TOPICS[(index * 3 + k * 5) % FILLER_TOPICS.length];
		for (let t = 0; t < topic.length; t += 2) {
			turns.push(u(topic[t]), a(topic[t + 1]));
		}
	}
	const file = `2026-01-16T10-${String(10 + (index % 50)).padStart(2, "0")}-${String((index * 7) % 60).padStart(2, "0")}-000Z.jsonl`;
	return { slug: `filler${String(index).padStart(2, "0")}`, file, turns };
}

function otherFillerSpec(index: number): { slug: string; file: string; turns: Turn[] } {
	// distinct rotation so the sessions differ from the main filler set
	const turns: Turn[] = [];
	for (let k = 0; k < 4; k++) {
		const topic = OTHER_FILLER_TOPICS[(index * 2 + k * 3) % OTHER_FILLER_TOPICS.length];
		for (let t = 0; t < topic.length; t += 2) {
			turns.push(u(topic[t]), a(topic[t + 1]));
		}
	}
	const file = `2026-01-17T11-${String(10 + (index % 45)).padStart(2, "0")}-${String((index * 11) % 60).padStart(2, "0")}-000Z.jsonl`;
	return { slug: `other-project-x${String(index).padStart(2, "0")}`, file, turns };
}

/** Pollution guards: filler must never trip consolidation's status heuristics
 * (kept in sync with ext/consolidate.ts token sets) nor the router's intent
 * regexes, nor collide with abstention probe vocabulary. */
const POLLUTION_TOKENS = new Set([
	// HEDGE_TOKENS
	"maybe", "someday", "perhaps", "possibly", "potentially", "explore", "exploring", "explored", "consider", "considering", "consideration", "idea", "ideas", "commitment", "plans", "floating", "tentative",
	// ATTEMPT_TOKENS
	"try", "tried", "trying", "attempt", "attempted", "attempting",
	// OUTCOME_TOKENS
	"failed", "revert", "reverts", "reverted", "reverting", "rolled", "rollback", "broke", "broken", "abandon", "abandoned",
	// REVERSAL_TOKENS
	"switched", "switching", "switch", "replaced", "replaces", "replace", "replacing", "dropped", "drop", "retired", "retire", "removed", "remove", "deprecated", "moved", "instead", "obsolete",
]);

function validateFiller(scale: number, abstentionQueries: string[]): void {
	const abstentionTok = new Set<string>();
	for (const q of abstentionQueries) for (const t of tokens(q)) abstentionTok.add(t);
	const validate = (spec: { slug: string; turns: Turn[] }) => {
		for (const turn of spec.turns) {
			for (const tok of tokens(turn.text)) {
				if (POLLUTION_TOKENS.has(tok)) throw new Error(`filler ${spec.slug}: pollution token "${tok}" (consolidation/intent would misread it) — reword: "${turn.text.slice(0, 60)}"`);
				if (abstentionTok.has(tok)) throw new Error(`filler ${spec.slug}: token "${tok}" collides with an abstention probe — reword: "${turn.text.slice(0, 60)}"`);
			}
		}
	};
	for (let i = 1; i <= scale; i++) validate(fillerSessionSpec(i));
	for (let i = 1; i <= otherFillerCount(scale); i++) validate(otherFillerSpec(i));
}

// ── generation + self-validation ──────────────────────────────────────────────

function transcriptLines(spec: { turns: Turn[] }): string {
	return spec.turns
		.map((t) => JSON.stringify({ type: "message", message: { role: t.role, content: [{ type: "text", text: t.text }] } }))
		.join("\n") + "\n";
}

/** Generate the corpus (scale = number of filler distractor sessions, 0 =
 * small corpus only). Returns the validated manifest. */
export function generateLifecycleFixtures(targetDir: string, scale = 0): LifecycleManifest {
	const sessionsDir = join(targetDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });

	// early validation: probe regexes must not bleed across intent classes, and
	// filler (which is checked against abstention vocabulary) must be clean
	for (const p of RECALL_PROBES.neutral) {
		if (FAILURE_INTENT_RE.test(p.query)) throw new Error(`neutral probe ${p.id} reads as failure-intent`);
		if (TEMPORAL_INTENT_RE.test(p.query)) throw new Error(`neutral probe ${p.id} reads as temporal-intent`);
	}
	for (const p of RECALL_PROBES.failureIntent) {
		if (TEMPORAL_INTENT_RE.test(p.query)) throw new Error(`failure probe ${p.id} also reads as temporal-intent`);
	}
	for (const p of TEMPORAL_PROBES) {
		if (FAILURE_INTENT_RE.test(p.query)) throw new Error(`temporal probe ${p.id} also reads as failure-intent — failures stay failure-intent-only`);
	}
	for (const p of AGGREGATION_PROBES) {
		if (FAILURE_INTENT_RE.test(p.query) || TEMPORAL_INTENT_RE.test(p.query)) throw new Error(`aggregation probe ${p.id} reads as failure/temporal-intent`);
	}
	// abstention probes are neutral-intent by construction — if one ever matched
	// an intent regex, the intent-targeted floor bypass would defeat the gate
	for (const p of ABSTENTION_PROBES) {
		if (FAILURE_INTENT_RE.test(p.query) || TEMPORAL_INTENT_RE.test(p.query)) throw new Error(`abstention probe ${p.id} reads as failure/temporal-intent`);
	}
	// v2.6 @slug probes: scoped queries must carry their own @scope token and
	// stay neutral-intent; unscoped same-topic queries must carry NO @token at
	// all (they assert the absence of hard scope). Scopes must name real
	// session slugs, expected refs must be planted.
	for (const p of [...SLUG_PROBES.scopedMain, ...SLUG_PROBES.scopedOther]) {
		if (FAILURE_INTENT_RE.test(p.query) || TEMPORAL_INTENT_RE.test(p.query)) throw new Error(`slug probe ${p.id} reads as failure/temporal-intent`);
		if (!p.query.toLowerCase().includes(`@${p.scope.toLowerCase()}`)) throw new Error(`slug probe ${p.id}: query must carry @${p.scope}`);
	}
	for (const p of SLUG_PROBES.unscopedOtherTopic) {
		if (FAILURE_INTENT_RE.test(p.query) || TEMPORAL_INTENT_RE.test(p.query)) throw new Error(`unscoped slug probe ${p.id} reads as failure/temporal-intent`);
		if (/@[a-z0-9]/i.test(p.query)) throw new Error(`unscoped slug probe ${p.id} must not carry an @token`);
	}
	validateFiller(scale, ABSTENTION_PROBES.map((p) => p.query));
	// the cross-slug sessions follow the same discipline as the filler, in every tier
	for (const spec of OTHER_SESSIONS) {
		for (const turn of spec.turns) {
			for (const tok of tokens(turn.text)) {
				if (POLLUTION_TOKENS.has(tok)) throw new Error(`other-project session ${spec.slug}: pollution token "${tok}" — reword: "${turn.text.slice(0, 60)}"`);
			}
		}
	}

	const plants: PlantEntry[] = [];
	const sessionRows: LifecycleManifest["sessions"] = [];
	const otherRows: LifecycleManifest["otherProject"]["sessions"] = [];

	const isOther = (slug: string) => OTHER_SESSIONS.some((o) => o.slug === slug);
	for (let s = 0; s < SESSIONS.length + OTHER_SESSIONS.length; s++) {
		const spec = [...SESSIONS, ...OTHER_SESSIONS][s];
		const rowsOut = isOther(spec.slug) ? otherRows : sessionRows;
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
		const row = { slug: spec.slug, file: `sessions/${spec.slug}/${file}`, userTurns: turns.length, blocks: bounds.length };
		rowsOut.push(row);
	}

	// filler distractor sessions (scale tier) — plain transcripts, no plants
	const fillerSlugs: string[] = [];
	for (let i = 1; i <= scale; i++) {
		const f = fillerSessionSpec(i);
		const dir = join(sessionsDir, f.slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, f.file), transcriptLines({ turns: f.turns }));
		fillerSlugs.push(f.slug);
	}
	// v2.6: scale-tier filler for the second project — cross-slug mass grows too
	const otherFillerSlugs: string[] = [];
	for (let i = 1; i <= otherFillerCount(scale); i++) {
		const f = otherFillerSpec(i);
		const dir = join(sessionsDir, f.slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, f.file), transcriptLines({ turns: f.turns }));
		otherFillerSlugs.push(f.slug);
	}

	// cross-checks: every probe ref exists; every pair member exists
	const refs = new Set(plants.map((p) => p.ref));
	for (const q of [...RECALL_PROBES.neutral, ...RECALL_PROBES.failureIntent, ...TEMPORAL_PROBES.map((t) => ({ ...t, excludedRefs: [], requiredRefs: t.expectedOldRefs })), ...AGGREGATION_PROBES.map((t) => ({ ...t, excludedRefs: [], requiredRefs: t.expectedRefs })), ...SLUG_PROBES.scopedMain.map((t) => ({ id: t.id, excludedRefs: [], requiredRefs: t.expectedRefs })), ...SLUG_PROBES.scopedOther.map((t) => ({ id: t.id, excludedRefs: [], requiredRefs: t.expectedRefs })), ...SLUG_PROBES.unscopedOtherTopic.map((t) => ({ id: t.id, excludedRefs: [], requiredRefs: t.expectMainRefs }))]) {
		const list = [...("excludedRefs" in q ? (q as any).excludedRefs ?? [] : []), ...((q as any).requiredRefs ?? []), ...((q as any).expectValidRefs ?? [])];
		for (const r of list) if (!refs.has(r)) throw new Error(`probe ${q.id}: unknown ref ${r}`);
	}
	// slug scopes must name real session slugs
	for (const p of [...SLUG_PROBES.scopedMain, ...SLUG_PROBES.scopedOther]) {
		if (!plants.some((x) => x.sessionSlug === p.scope) && !SESSIONS.some((s) => s.slug === p.scope) && !OTHER_SESSIONS.some((s) => s.slug === p.scope)) {
			throw new Error(`slug probe ${p.id}: scope "${p.scope}" matches no session slug`);
		}
	}
	// aggregation members: two DIFFERENT sessions, both valid plants
	for (const p of AGGREGATION_PROBES) {
		const [sa, sb] = p.sessions;
		if (sa === sb) throw new Error(`aggregation probe ${p.id}: refs must come from different sessions`);
		for (const r of p.expectedRefs) if (plants.find((x) => x.ref === r)?.expectedStatus !== "valid") throw new Error(`aggregation probe ${p.id}: ${r} must be a valid plant`);
	}
	// temporal targets: expected-old refs must be planted superseded
	for (const p of TEMPORAL_PROBES) {
		for (const r of p.expectedOldRefs) if (plants.find((x) => x.ref === r)?.expectedStatus !== "superseded") throw new Error(`temporal probe ${p.id}: ${r} must be a superseded plant`);
	}
	// abstention: zero token overlap with the ENTIRE corpus (planted + filler)
	{
		const corpusTok = new Set<string>();
		for (const spec of [...SESSIONS, ...OTHER_SESSIONS]) for (const t of spec.turns) for (const tok of tokens(t.text)) corpusTok.add(tok);
		for (let i = 1; i <= scale; i++) for (const t of fillerSessionSpec(i).turns) for (const tok of tokens(t.text)) corpusTok.add(tok);
		for (let i = 1; i <= otherFillerCount(scale); i++) for (const t of otherFillerSpec(i).turns) for (const tok of tokens(t.text)) corpusTok.add(tok);
		for (const p of ABSTENTION_PROBES) {
			const hit = [...tokens(p.query)].filter((t) => corpusTok.has(t));
			if (hit.length) throw new Error(`abstention probe ${p.id}: tokens ${hit.join(",")} exist in the corpus — pick a truly absent topic`);
		}
	}

	const manifest: LifecycleManifest = {
		name: "lifecycle-fixtures",
		version: "v2.6-slug-scope",
		corpus: "synthetic larkspur-exporter + kestrel-dashboard sessions with planted lifecycle ground truth (deterministic)",
		sessions: sessionRows,
		plants,
		supersessionPairs: [
			{ id: "ss-renderer", topic: "docs preview renderer", older: "lcb01@t3", newer: "lcb02@t3" },
			{ id: "ss-config", topic: "config format", older: "lcb03@t3", newer: "lcb04@t2" },
			{ id: "ss-retry", topic: "webhook retry policy", older: "lcb05@t3", newer: "lcb06@t2" },
			{ id: "ss-harness", topic: "integration test harness", older: "lcb07@t2", newer: "lcb08@t2" },
		],
		recallProbes: RECALL_PROBES,
		temporalProbes: TEMPORAL_PROBES,
		aggregationProbes: AGGREGATION_PROBES,
		abstentionProbes: ABSTENTION_PROBES,
		slugProbes: SLUG_PROBES,
		otherProject: {
			note: "cross-slug distractor project (kestrel-dashboard) — valid-only templates, shared generic vocabulary, disjoint specifics; @slug hard scope must not bleed into it",
			sessions: otherRows,
		},
		scale,
		filler: { count: scale, turnsPerSession: FILLER_TURNS_PER_SESSION, slugs: fillerSlugs, otherCount: otherFillerSlugs.length, otherSlugs: otherFillerSlugs },
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
	const scaleFlag = process.argv.indexOf("--scale");
	const scale = scaleFlag >= 0 ? Number(process.argv[scaleFlag + 1] ?? 0) || 0 : 0;
	const target = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : join(import.meta.dirname ?? "tools", "..", "bench", "lifecycle_fixtures");
	const manifest = generateLifecycleFixtures(target, scale);
	const counts = manifest.plants.reduce<Record<string, number>>((m, p) => ({ ...m, [p.expectedStatus]: (m[p.expectedStatus] ?? 0) + 1 }), {});
	console.log(`lifecycle fixtures → ${target}${scale ? ` (scale: +${scale} filler +${manifest.filler.otherCount} other-project filler sessions)` : ""}`);
	console.log(`sessions: ${manifest.sessions.length} main + ${manifest.otherProject.sessions.length} other-project, plants: ${manifest.plants.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}), filler: ${manifest.filler.count} + ${manifest.filler.otherCount}`);
	console.log(`supersession pairs: ${manifest.supersessionPairs.length}, probes: ${manifest.recallProbes.neutral.length} neutral / ${manifest.recallProbes.failureIntent.length} failure / ${manifest.temporalProbes.length} temporal / ${manifest.aggregationProbes.length} aggregation / ${manifest.abstentionProbes.length} abstention / ${manifest.slugProbes.scopedMain.length + manifest.slugProbes.scopedOther.length} slug-scoped + ${manifest.slugProbes.unscopedOtherTopic.length} slug-unscoped`);
	console.log(`sanity real pairs: ${manifest.sanity.realPairs.map((p) => p.id).join(", ")}`);
	console.log(`manifest: ${join(target, "fixtures_manifest.json")}`);
}
