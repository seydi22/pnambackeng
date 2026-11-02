require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const agents = await mongoose.connection.db.collection('agents').countDocuments({ role: 'agent' });
  const withMsisdn = await mongoose.connection.db.collection('agents').countDocuments({
    role: 'agent',
    moovMoneyMsisdn: { $exists: true, $nin: [null, ''] },
  });
  const merchants = await mongoose.connection.db.collection('merchants').countDocuments({
    statut: { $in: ['cree', 'livré'] },
    shortCode: { $exists: true, $nin: [null, ''] },
  });
  const notPaid = await mongoose.connection.db.collection('merchants').countDocuments({
    statut: { $in: ['cree', 'livré'] },
    shortCode: { $exists: true, $nin: [null, ''] },
    'remuneration.status': { $ne: 'paid' },
  });
  const sample = await mongoose.connection.db
    .collection('merchants')
    .find({
      statut: { $in: ['cree', 'livré'] },
      shortCode: { $exists: true, $nin: [null, ''] },
    })
    .project({ nom: 1, shortCode: 1, statut: 1, 'remuneration.status': 1, agentRecruteurId: 1 })
    .limit(8)
    .toArray();
  const agentsSample = await mongoose.connection.db
    .collection('agents')
    .find({ role: 'agent' })
    .project({ matricule: 1, moovMoneyMsisdn: 1 })
    .limit(10)
    .toArray();
  console.log(
    JSON.stringify(
      { agents, withMsisdn, merchantsWithShortCode: merchants, notPaid, sample, agentsSample },
      null,
      2
    )
  );
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
