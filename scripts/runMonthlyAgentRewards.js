/**
 * Job mensuel de remuneration agents (CPS Promotional Commission).
 *
 * Usage:
 *   node scripts/runMonthlyAgentRewards.js
 *   node scripts/runMonthlyAgentRewards.js --month=2026-07
 *   node scripts/runMonthlyAgentRewards.js --dry-run
 *   node scripts/runMonthlyAgentRewards.js --force
 *
 * Active/montant : parametres admin (collection RemunerationSettings), plus fallback .env.
 * Defaut: mois civil precedent (UTC).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  runMonthlyAgentRewards,
  monthWindow,
} = require('../services/agentMonthlyReward');

function parseMonthArg(argv) {
  const raw = argv.find((a) => a.startsWith('--month='));
  if (!raw) return null;
  const v = raw.split('=')[1];
  const m = /^(\d{4})-(\d{2})$/.exec(v || '');
  if (!m) {
    console.error('Format --month=YYYY-MM invalide');
    process.exit(1);
  }
  const year = Number(m[1]);
  const monthIndex0 = Number(m[2]) - 1;
  if (monthIndex0 < 0 || monthIndex0 > 11) {
    console.error('Mois invalide');
    process.exit(1);
  }
  return monthWindow(year, monthIndex0);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const period = parseMonthArg(argv) || undefined;

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI manquant');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Mongo connecte. Lancement job remuneration...');

  try {
    const report = await runMonthlyAgentRewards({ period, dryRun, force });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
