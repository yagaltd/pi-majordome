/** CLI: npx tsx tools/init-cli.ts [--dry-run] [--slug <s>] [--lineage <slug>|all] [--limit N] [--no-dims] */
import { initRepo } from "../ext/init.ts";
import { agentsOffer } from "../ext/agentsmd.ts";
import { writeOfferProposal } from "../ext/proposals.ts";
const a = process.argv.slice(2);
async function main() {
	const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
	const m = await initRepo({
		cwd: process.cwd(),
		dryRun: a.includes("--dry-run"),
		slug: get("--slug"),
		lineage: get("--lineage"),
		limit: get("--limit") ? Number(get("--limit")) : undefined,
		noDims: a.includes("--no-dims"),
	});
	console.log(m);
	// AGENTS.md scaffold/augment, headless: no dialog to answer — record the
	// offer as a pending proposal under .majordome/proposals/ and print its
	// path; AGENTS.md itself is written only on an explicit user yes (the
	// interactive /majordome init confirm), never here.
	try {
		const offer = agentsOffer(process.cwd());
		if (offer) {
			const p = writeOfferProposal(offer, process.cwd());
			console.log(`${offer.message}\nproposal (not applied) → ${p}`);
		}
	} catch { /* advisory never fails init */ }
}
main();
