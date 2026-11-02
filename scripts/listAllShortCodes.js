require('dotenv').config();
const mongoose = require('mongoose');
const Merchant = require('../models/Merchant');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const list = await Merchant.find({
    shortCode: { $exists: true, $nin: [null, ''] },
    statut: { $in: ['cree', 'livré'] },
  })
    .select('shortCode nom statut createdAt')
    .sort({ shortCode: 1 })
    .lean();

  console.log('TOTAL', list.length);
  list.forEach((m) => {
    const d = m.createdAt ? m.createdAt.toISOString().slice(0, 10) : '';
    console.log(`${m.shortCode}\t${m.statut}\t${d}\t${m.nom}`);
  });
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
