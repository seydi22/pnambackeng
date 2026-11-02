require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection('merchants');

  const months = [
    { label: '2026-07', start: new Date(Date.UTC(2026, 6, 1)), end: new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999)) },
    { label: '2026-08', start: new Date(Date.UTC(2026, 7, 1)), end: new Date(Date.UTC(2026, 7, 31, 23, 59, 59, 999)) },
  ];

  for (const m of months) {
    const rows = await col
      .find({
        createdAt: { $gte: m.start, $lte: m.end },
        shortCode: { $exists: true, $nin: [null, ''] },
        statut: { $in: ['cree', 'livré'] },
      })
      .project({ shortCode: 1, nom: 1, statut: 1, createdAt: 1 })
      .sort({ shortCode: 1 })
      .toArray();
    console.log(`\n=== ${m.label} (${rows.length} marchands) ===`);
    console.log(rows.map((r) => r.shortCode).join(', '));
  }

  const special = await col
    .find({ shortCode: { $in: ['004157', '4157', '004149', '4149'] } })
    .project({ shortCode: 1, nom: 1, statut: 1, createdAt: 1 })
    .toArray();
  console.log('\n=== Recherche 004157 / 004149 ===');
  console.log(JSON.stringify(special, null, 2));

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
