/**
 * ONE-TIME migration: legacy hand-curated STATUS.md → decision blocks.
 *
 * The captain-approved architecture (DECISION-BLOCK STORE): blocks.jsonl is
 * the ONLY ledger source; /majordome status folds decision blocks on the fly;
 * STATUS.md demotes to a generated export (/majordome status --export md).
 * This script reads the legacy md table (via the shared parseStatusRows) and
 * appends ONE decision block per row — evidence and substrate VERBATIM —
 * through the same appendDecisionStatus path every future agreement uses.
 *
 * Idempotent: items that already have a decision block in this repo's ledger
 * are skipped, so re-running after a partial run (or after real decisions
 * started appending) never duplicates or overwrites.
 *
 * HERMETIC BY DEFAULT IN PRACTICE: it acts on cwd's repoRoot + the real store
 * (MAJORDOME_DIR override for a fixture store, MAJORDOME_STATUS_FILE for a
 * fixture ledger). The REAL pi-majordome migration runs on master at merge:
 *   npx tsx tools/migrate-status.ts            # migrate, then
 *   npx tsx tools/migrate-status.ts --dry-run  # preview only
 */
import { existsSync, readFileSync } from "node:fs";
import { DECISION_STATUSES, type DecisionStatus } from "../ext/store.ts";
import {
	appendDecisionStatus,
	loadDecisions,
	parseStatusRows,
	statusFile,
} from "../ext/status.ts";

export interface MigrateResult {
	rows: number; // rows in the source ledger
	migrated: number;
	skipped: number; // item already has a decision block
	invalid: number; // row status outside built/parked/dropped/pending
	builtNoEvidence: number; // migrated verbatim; flagged for the evidence gate
}

export function migrateStatus(opts: { repoRoot?: string; statusPath?: string; dryRun?: boolean } = {}): MigrateResult {
	const repoRoot = opts.repoRoot ?? process.cwd();
	const statusPath = opts.statusPath ?? statusFile(repoRoot);
	const res: MigrateResult = { rows: 0, migrated: 0, skipped: 0, invalid: 0, builtNoEvidence: 0 };
	if (!existsSync(statusPath)) return res; // no legacy ledger → nothing to migrate
	const rows = parseStatusRows(readFileSync(statusPath, "utf8"));
	res.rows = rows.length;
	const have = new Set(loadDecisions(repoRoot).map((b) => b.decision.item));
	for (const r of rows) {
		if (have.has(r.item)) {
			res.skipped++;
			continue;
		}
		if (!DECISION_STATUSES.includes(r.status as DecisionStatus)) {
			res.invalid++;
			continue;
		}
		if (r.status === "built" && !/\b[0-9a-f]{7}\b/.test(r.evidence) && !/^global: /.test(r.evidence)) {
			res.builtNoEvidence++;
		}
		if (!opts.dryRun) appendDecisionStatus({ item: r.item, status: r.status as DecisionStatus, evidence: r.evidence, substrate: r.substrate }, repoRoot);
		res.migrated++;
	}
	return res;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	const dryRun = process.argv.includes("--dry-run");
	const res = migrateStatus({ dryRun });
	const L = [
		`${dryRun ? "[dry-run] " : ""}migrate-status: ${res.rows} legacy row(s) at ${statusFile()}`,
		`  migrated ${res.migrated} · skipped ${res.skipped} (already decision blocks) · invalid ${res.invalid}`,
	];
	if (res.builtNoEvidence) L.push(`  ⚠ ${res.builtNoEvidence} built row(s) without a 7-hex commit / global: evidence — migrated verbatim, flagged for the evidence gate`);
	console.log(L.join("\n"));
}
