/**
 * Smoke test manual del interpreter (antes era NLU adapter).
 *
 *   npx tsx scripts/test-nlu.ts "termne piernas re cansado che"
 *   npx tsx scripts/test-nlu.ts                                   # modo interactivo
 *
 * Requiere GEMINI_API_KEY en .env. NO toca la DB ni Evolution API.
 *
 * Usa un userId fake fijo, asi compartis budget entre invocaciones rapidas
 * y no agotas el cupo real de un user en produccion.
 */
import "dotenv/config";
import { createInterface } from "node:readline";
import { interpretMessage } from "../src/services/gemini.service.js";

const FAKE_USER = "00000000-0000-0000-0000-000000000001";

async function runOnce(text: string): Promise<void> {
  const started = Date.now();
  const result = await interpretMessage(text, FAKE_USER);
  const elapsed = Date.now() - started;
  process.stdout.write(`\n[${elapsed} ms] input: "${text}"\n`);
  if (result === null) {
    process.stdout.write("  result: null (fallback al classifier local)\n");
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

async function main() {
  const argText = process.argv.slice(2).join(" ").trim();
  if (argText) {
    await runOnce(argText);
    return;
  }

  process.stdout.write("Modo interactivo. Escribi un mensaje y Enter. Ctrl+C para salir.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  rl.on("line", async (line) => {
    const t = line.trim();
    if (!t) {
      rl.prompt();
      return;
    }
    try {
      await runOnce(t);
    } catch (err) {
      process.stdout.write(`error: ${(err as Error).message}\n`);
    }
    rl.prompt();
  });
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
