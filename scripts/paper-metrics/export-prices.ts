// Writes lib/llm/prices.ts as JSON so the Python metrics read the same dated
// price table as the app's spend guard.
//
//   tsx scripts/paper-metrics/export-prices.ts --out <dir>/prices.json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PRICES } from "../../lib/llm/prices";

function main(argv: string[]): void {
  const i = argv.indexOf("--out");
  const out = i === -1 ? undefined : argv[i + 1];
  if (!out) {
    console.error("Usage: tsx scripts/paper-metrics/export-prices.ts --out <file.json>");
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  const body = {
    source: "lib/llm/prices.ts",
    unit: "USD per million tokens",
    models: PRICES,
  };
  writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  console.log(`Prices written to ${out}`);
}

main(process.argv.slice(2));
