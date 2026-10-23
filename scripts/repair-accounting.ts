import { repairAccounting } from "../server/accounting-repair.ts";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) throw Error("Usage: node scripts/repair-accounting.ts DATA_DIR [--apply]");
console.log(JSON.stringify(repairAccounting(dir, args.includes("--apply"))));
