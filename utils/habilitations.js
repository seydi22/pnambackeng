const Agent = require('../models/Agent');

const HABILITATIONS = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'dashboard-choix', label: 'Choix des blocs du dashboard' },
    { key: 'dashboard-organisation', label: 'Effectifs PAM, SAM, CAM et équipes' },
    { key: 'dashboard-marchands', label: 'Marchands et statuts' },
    { key: 'dashboard-alertes', label: 'Alertes de délai' },
    { key: 'dashboard-activite', label: 'Activité récente' },
    { key: 'parametres', label: 'Paramètres' },
    { key: 'organisation', label: 'Organisation' },
    { key: 'referentiel-kyc', label: 'Référentiel KYC' },
    { key: 'referentiel-geo', label: 'Référentiel géographique' },
    { key: 'pointage', label: 'Pointage' },
    { key: 'materiel', label: 'Matériel' },
    { key: 'marchands', label: 'Marchands' },
    { key: 'carte-marchand', label: 'Carte marchand' },
    { key: 'carte-equipe', label: 'Carte équipe' },
    { key: 'anti-fraude', label: 'Anti-fraude' },
    { key: 'validation', label: 'Validation marchands' },
    { key: 'rapports', label: 'Rapports' },
];

const KEYS = new Set(HABILITATIONS.map((item) => item.key));

const RULES = [
    ['GET', /^\/api\/logs\/?$/, ['dashboard']],
    ['GET', /^\/api\/merchants\/dashboard-stats$/, ['dashboard']],
    ['GET', /^\/api\/merchants\/alertes-delai$/, ['dashboard', 'validation']],
    ['GET', /^\/api\/organization\/?$/, ['dashboard', 'organisation', 'rapports']],
    ['GET', /^\/api\/organization\/territoire$/, ['referentiel-geo', 'organisation']],
    ['PUT', /^\/api\/organization\/territoire$/, ['referentiel-geo']],
    [null, /^\/api\/organization(\/|$)/, ['organisation']],
    ['PUT', /^\/api\/app\/version$/, ['parametres']],
    [null, /^\/api\/remuneration(\/|$)/, ['parametres']],
    ['PUT', /^\/api\/merchants\/kyc-referentiel$/, ['referentiel-kyc']],
    ['GET', /^\/api\/merchants\/kyc-referentiel$/, ['referentiel-kyc']],
    ['GET', /^\/api\/tournees\/?$/, ['pointage']],
    [null, /^\/api\/materiels(\/|$)/, ['materiel']],
    ['GET', /^\/api\/merchants\/localisation$/, ['carte-marchand']],
    ['GET', /^\/api\/positions\/?$/, ['carte-equipe']],
    [null, /^\/api\/alertes-fraude(\/|$)/, ['anti-fraude']],
    [null, /^\/api\/merchants\/(pending-admin-validation|admin-validate|admin-reject|admin-reject-definitive)(\/|$)/, ['validation']],
    [null, /^\/api\/export(\/|$)/, ['rapports']],
    [null, /^\/api\/merchants\/(export|export-operators)\/?$/, ['rapports', 'marchands']],
    ['GET', /^\/api\/agents\/export$/, ['rapports']],
    ['GET', /^\/api\/merchants\/all$/, ['marchands']],
    ['GET', /^\/api\/merchants\/[a-f0-9]{24}$/i, ['marchands', 'validation']],
    ['GET', /^\/api\/agents\/[a-f0-9]{24}$/i, ['marchands', 'validation']],
];

function sanitize(values) {
    const list = Array.isArray(values) ? values : [];
    return [...new Set(list.map((item) => String(item || '').trim()).filter((key) => KEYS.has(key)))];
}

function habilitationsFor(method, originalUrl) {
    const path = String(originalUrl || '').split('?')[0];
    for (const [expected, pattern, keys] of RULES) {
        if (expected && expected !== method) continue;
        if (pattern.test(path)) return keys;
    }
    return null;
}

async function assertBackoffice(req) {
    const agent = await Agent.findById(req.user.id).select('role actif habilitations');
    if (!agent || agent.role !== 'backoffice') {
        const error = new Error('Acces refuse.');
        error.statusCode = 403;
        throw error;
    }
    if (agent.actif === false) {
        const error = new Error('Compte desactive.');
        error.statusCode = 403;
        throw error;
    }
    const needed = habilitationsFor(req.method, req.originalUrl);
    const owned = new Set(agent.habilitations || []);
    if (!needed || !needed.some((key) => owned.has(key))) {
        const error = new Error('Cette fonction n’est pas ouverte pour ce compte.');
        error.statusCode = 403;
        throw error;
    }
}

module.exports = {
    HABILITATIONS,
    sanitize,
    assertBackoffice,
};
