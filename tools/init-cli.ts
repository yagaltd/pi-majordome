/** CLI: npx tsx tools/init-cli.ts [--dry-run] [--slug <s>] [--lineage <slug>|all] [--limit N] [--no-dims] */
import { initRepo } from "../ext/init.ts";
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
}
main();
