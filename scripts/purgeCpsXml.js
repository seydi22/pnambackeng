// scripts/purgeCpsXml.js
// Purge one-shot des XML CPS legacy (Password / SecurityCredential) en base.
// Usage: ALLOW_CPS_PURGE=1 node scripts/purgeCpsXml.js

const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

async function main() {
    if (process.env.ALLOW_CPS_PURGE !== '1') {
        console.error('Refuse: definissez ALLOW_CPS_PURGE=1 pour executer ce script.');
        process.exit(1);
    }

    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI manquant.');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);

    const merchants = mongoose.connection.collection('merchants');

    const result = await merchants.updateMany(
        {
            $or: [
                { 'cpsIntegration.createTopOrg.requestXml': { $exists: true } },
                { 'cpsIntegration.createTopOrg.rawResponse': { $exists: true } },
                { 'cpsIntegration.createOrgOperator.results.requestXml': { $exists: true } },
                { 'cpsIntegration.createOrgOperator.results.rawResponse': { $exists: true } },
            ],
        },
        {
            $unset: {
                'cpsIntegration.createTopOrg.requestXml': '',
                'cpsIntegration.createTopOrg.rawResponse': '',
                'cpsIntegration.createOrgOperator.results.$[].requestXml': '',
                'cpsIntegration.createOrgOperator.results.$[].rawResponse': '',
            },
        }
    );

    console.log(`Documents matches: ${result.matchedCount}`);
    console.log(`Documents modifies: ${result.modifiedCount}`);

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('Erreur purge CPS XML:', err);
    try {
        await mongoose.disconnect();
    } catch (_) {
        // ignore
    }
    process.exit(1);
});
