/** CLI: npx tsx tools/doctor-cli.ts [housekeeping] [--dry-run]
 *
 * The /majordome doctor + housekeeping checks from any terminal. This entry
 * exists because the checks used to be extension/selfcheck-internal only:
 * bare `tsx ext/doctor.ts` printed nothing (library module) and
 * `tools/init-cli.ts doctor` ran init instead (then sat on stdin) — that
 * failure mode dies here. Prints to stdout, never reads stdin.
 */
import { doctor } from "../ext/doctor.ts";
import { housekeeping } from "../ext/housekeep.ts";

const args = process.argv.slice(2);
const out = args.includes("housekeeping")
	? await housekeeping(process.cwd(), { apply: !args.includes("--dry-run") })
	: await doctor();
console.log(out);
