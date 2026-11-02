const Agent = require('../models/Agent');
const Pam = require('../models/Pam');
const Eam = require('../models/Eam');
const Zone = require('../models/Zone');
const GeoReferentiel = require('../models/GeoReferentiel');
const SEED = require('../data/territoires.json');
const { territoryStem, scopeSlice, scopeZone } = require('../data/territoires');

const SEED_VERSION = 2;

class GeoError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

async function getReferentiel() {
    let doc = await GeoReferentiel.findOne({ key: 'default' });
    if (!doc || doc.version !== SEED_VERSION) {
        doc = await GeoReferentiel.findOneAndUpdate(
            { key: 'default' },
            { $set: { territoires: SEED, version: SEED_VERSION } },
            { new: true, upsert: true }
        );
    }
    return doc;
}

async function listTerritoires() {
    const doc = await getReferentiel();
    return doc.toObject().territoires || [];
}

async function stem(region, moughataa) {
    return territoryStem(await listTerritoires(), region, moughataa);
}

async function scopeForUser(userId) {
    const agent = await Agent.findById(userId).select('pamId eamId');
    if (!agent) throw new GeoError('Compte introuvable.', 404);

    let pamId = agent.pamId;
    if (!pamId && agent.eamId) {
        const eam = await Eam.findById(agent.eamId).select('pamId');
        pamId = eam && eam.pamId;
    }
    if (!pamId) throw new GeoError('Ce compte n\'est pas rattache a une zone ni a une moughataa.');

    const pam = await Pam.findById(pamId).select('region moughataa zoneId');
    if (!pam) throw new GeoError('Ce compte n\'est pas rattache a une zone ni a une moughataa.');

    const tree = await listTerritoires();
    if (pam.zoneId) {
        const zone = await Zone.findById(pam.zoneId).select('nom wilayas actif');
        if (!zone || zone.actif === false || !(zone.wilayas || []).length) {
            throw new GeoError('La zone de ce PAM ne contient aucune wilaya.');
        }
        const slice = scopeZone(tree, zone.wilayas);
        if (!slice.territoires.length) {
            throw new GeoError('Les wilayas de cette zone ne figurent pas dans le referentiel.');
        }
        return { ...slice, zone: zone.nom };
    }
    if (!pam.region || !pam.moughataa) {
        throw new GeoError('Ce compte n\'est pas rattache a une zone ni a une moughataa.');
    }

    try {
        return scopeSlice(tree, pam.region, pam.moughataa);
    } catch (err) {
        if (err && (err.message === 'REGION' || err.message === 'MOUGHATAA')) {
            throw new GeoError('La moughataa affectee ne figure pas dans le referentiel.');
        }
        throw err;
    }
}

function findCommune(communes, name) {
    return (communes || []).find((item) => {
        if (typeof item === 'string') return item === name;
        return item && item.nom === name;
    });
}

async function assertActorLieu(userId, region, ville, commune, localite) {
    const scope = await scopeForUser(userId);
    const lieuRegion = String(region || '').trim();
    const lieuMoughataa = String(ville || '').trim();
    const lieuCommune = String(commune || '').trim();
    const lieuLocalite = String(localite || '').trim();
    let communes = scope.communes;
    if (scope.mode === 'zone') {
        const wilaya = (scope.territoires || []).find((item) => item.region === lieuRegion);
        if (!wilaya) {
            throw new GeoError(`Cette wilaya ne fait pas partie de la zone ${scope.zone}.`);
        }
        const moughataa = (wilaya.moughataas || []).find((item) => item.nom === lieuMoughataa);
        if (!moughataa) {
            throw new GeoError('Cette moughataa ne fait pas partie de la wilaya choisie.');
        }
        communes = moughataa.communes;
    } else if (lieuRegion !== scope.region || lieuMoughataa !== scope.moughataa) {
        throw new GeoError(`Ce compte est limite a la moughataa ${scope.moughataa} (${scope.region}).`);
    }
    const found = findCommune(communes, lieuCommune);
    if (!found) {
        throw new GeoError('Cette commune ne fait pas partie de la moughataa.');
    }
    const localites = typeof found === 'string' ? [] : (found.localites || []);
    if (!localites.includes(lieuLocalite)) {
        throw new GeoError('Cette localite ne fait pas partie de la commune.');
    }
    return { region: lieuRegion, ville: lieuMoughataa, commune: lieuCommune, localite: lieuLocalite };
}

function cleanName(value) {
    return String(value || '').trim();
}

function uniqueNames(values, label) {
    const seen = new Set();
    return values.map((value) => {
        const nom = cleanName(value);
        if (!nom) throw new GeoError(`Un nom vide n'est pas accepte (${label}).`);
        const key = nom.toLowerCase();
        if (seen.has(key)) throw new GeoError(`Doublon dans ${label} : ${nom}.`);
        seen.add(key);
        return nom;
    });
}

function normalizeTree(tree) {
    if (!Array.isArray(tree) || tree.length === 0) {
        throw new GeoError('Au moins une wilaya est requise.');
    }
    const seenRegions = new Set();
    return tree.map((zone) => {
        const region = cleanName(zone && zone.region);
        const code = cleanName(zone && zone.code).toUpperCase();
        if (!region) throw new GeoError('Chaque wilaya doit avoir un nom.');
        if (!/^[A-Z]{2,5}$/.test(code)) throw new GeoError(`Code de wilaya invalide pour ${region}.`);
        const regionKey = region.toLowerCase();
        if (seenRegions.has(regionKey)) throw new GeoError(`Wilaya en double : ${region}.`);
        seenRegions.add(regionKey);

        const rawMoughataas = Array.isArray(zone.moughataas) ? zone.moughataas : [];
        if (rawMoughataas.length === 0) throw new GeoError(`La wilaya ${region} doit avoir une moughataa.`);
        const seenMoughataas = new Set();
        const moughataas = rawMoughataas.map((item) => {
            const nom = cleanName(item && item.nom);
            if (!nom) throw new GeoError(`Moughataa sans nom dans ${region}.`);
            const key = nom.toLowerCase();
            if (seenMoughataas.has(key)) throw new GeoError(`Moughataa en double dans ${region} : ${nom}.`);
            seenMoughataas.add(key);
            const rawCommunes = Array.isArray(item.communes) ? item.communes : [];
            if (rawCommunes.length === 0) throw new GeoError(`La moughataa ${nom} doit avoir une commune.`);
            const seenCommunes = new Set();
            const communes = rawCommunes.map((commune) => {
                const communeNom = cleanName(commune && (commune.nom || commune));
                if (!communeNom) throw new GeoError(`Commune sans nom dans ${nom}.`);
                const communeKey = communeNom.toLowerCase();
                if (seenCommunes.has(communeKey)) throw new GeoError(`Commune en double dans ${nom} : ${communeNom}.`);
                seenCommunes.add(communeKey);
                const rawLocalites = Array.isArray(commune && commune.localites) ? commune.localites : [];
                const localites = uniqueNames(rawLocalites, communeNom);
                if (localites.length === 0) throw new GeoError(`La commune ${communeNom} doit avoir une localite.`);
                return { nom: communeNom, localites };
            });
            return { nom, communes };
        });
        return { region, code, moughataas };
    });
}

async function updateReferentiel(tree) {
    const territoires = normalizeTree(tree);
    const doc = await GeoReferentiel.findOneAndUpdate(
        { key: 'default' },
        { $set: { territoires, version: SEED_VERSION } },
        { new: true, upsert: true }
    );
    return doc.toObject().territoires;
}

module.exports = {
    GeoError,
    listTerritoires,
    stem,
    scopeForUser,
    assertActorLieu,
    updateReferentiel,
};
