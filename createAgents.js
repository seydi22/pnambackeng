// backend/createAgents.js
// Script de SEED local uniquement. Ne jamais executer en production.

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Agent = require('./models/Agent');
const dotenv = require('dotenv');

dotenv.config();

function requireEnvFlag() {
    if (process.env.ALLOW_SEED !== '1') {
        console.error('Refuse: definissez ALLOW_SEED=1 pour executer ce script.');
        console.error('Exemple: ALLOW_SEED=1 CONFIRM_DELETE_AGENTS=YES node createAgents.js');
        process.exit(1);
    }
    if (process.env.NODE_ENV === 'production') {
        console.error('Refuse: createAgents.js est interdit en production.');
        process.exit(1);
    }
    if (process.env.CONFIRM_DELETE_AGENTS !== 'YES') {
        console.error('Refuse: CONFIRM_DELETE_AGENTS=YES requis (supprime tous les agents).');
        process.exit(1);
    }
}

function passwordOrRandom(envKey, label) {
    const fromEnv = process.env[envKey];
    if (fromEnv && String(fromEnv).length >= 12) {
        return String(fromEnv);
    }
    const generated = crypto.randomBytes(12).toString('base64url');
    console.warn(`[seed] ${label}: mot de passe genere (defini ${envKey} pour forcer une valeur).`);
    return generated;
}

const createAgents = async () => {
    requireEnvFlag();

    const adminPassword = passwordOrRandom('SEED_ADMIN_PASSWORD', 'ADMIN001');
    const supervisorPassword = passwordOrRandom('SEED_SUPERVISEUR_PASSWORD', 'SUP001');
    const agent1Password = passwordOrRandom('SEED_AGENT1_PASSWORD', 'AGT001');
    const agent2Password = passwordOrRandom('SEED_AGENT2_PASSWORD', 'AGT002');

    const agents = [
        {
            matricule: 'ADMIN001',
            motDePasse: adminPassword,
            role: 'admin',
            affiliation: 'Moov Money',
        },
        {
            matricule: 'SUP001',
            motDePasse: supervisorPassword,
            role: 'superviseur',
            affiliation: 'Moov Money',
        },
        {
            matricule: 'AGT001',
            motDePasse: agent1Password,
            role: 'agent',
            affiliation: 'Moov Money',
            superviseurId: null, // rempli apres creation SUP001
        },
        {
            matricule: 'AGT002',
            motDePasse: agent2Password,
            role: 'agent',
            affiliation: 'Moov Money',
            superviseurId: null,
        },
    ];

    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connexion a la base de donnees reussie.');

        await Agent.deleteMany({});
        console.log('Anciens agents supprimes (seed confirme).');

        const salt = await bcrypt.genSalt(10);

        const admin = await new Agent({
            ...agents[0],
            motDePasse: await bcrypt.hash(agents[0].motDePasse, salt),
        }).save();

        const superviseur = await new Agent({
            ...agents[1],
            motDePasse: await bcrypt.hash(agents[1].motDePasse, salt),
        }).save();

        const agent1 = await new Agent({
            matricule: agents[2].matricule,
            affiliation: agents[2].affiliation,
            role: 'agent',
            superviseurId: superviseur._id,
            motDePasse: await bcrypt.hash(agents[2].motDePasse, salt),
        }).save();

        const agent2 = await new Agent({
            matricule: agents[3].matricule,
            affiliation: agents[3].affiliation,
            role: 'agent',
            superviseurId: superviseur._id,
            motDePasse: await bcrypt.hash(agents[3].motDePasse, salt),
        }).save();

        const created = [admin, superviseur, agent1, agent2];
        const plainPasswords = {
            ADMIN001: adminPassword,
            SUP001: supervisorPassword,
            AGT001: agent1Password,
            AGT002: agent2Password,
        };

        console.log('Agents de test crees :');
        created.forEach((agent) => {
            console.log(
                `- Matricule: ${agent.matricule}, Role: ${agent.role}, MotDePasse: ${plainPasswords[agent.matricule]}`
            );
        });

        process.exit(0);
    } catch (error) {
        console.error('Erreur lors de la creation des agents :', error);
        process.exit(1);
    }
};

createAgents();
