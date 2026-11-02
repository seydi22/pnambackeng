const Zone = require('../models/Zone');
const Pam = require('../models/Pam');
const geo = require('./geoReferentielService');

const NOUAKCHOTT_ZONES = ['Nouakchott-Nord', 'Nouakchott-Ouest', 'Nouakchott-Sud'];

class ZoneError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

function clean(value) {
    return String(value || '').trim();
}

async function normalizeWilayas(names, zoneId) {
    const tree = await geo.listTerritoires();
    const official = new Set(tree.map((item) => item.region));
    const unique = [];
    const seen = new Set();
    (names || []).forEach((raw) => {
        const name = clean(raw);
        if (!name || seen.has(name)) return;
        seen.add(name);
        if (!official.has(name)) {
            throw new ZoneError(`Wilaya inconnue : ${name}.`);
        }
        unique.push(name);
    });
    if (unique.length) {
        const filter = zoneId ? { _id: { $ne: zoneId } } : {};
        const others = await Zone.find(filter).select('nom wilayas');
        others.forEach((other) => {
            const clash = (other.wilayas || []).filter((name) => unique.includes(name));
            if (clash.length) {
                const verb = clash.length > 1 ? 'sont deja' : 'est deja';
                throw new ZoneError(`${clash.join(', ')} ${verb} dans la zone ${other.nom}.`);
            }
        });
    }
    return unique;
}

async function ensureNouakchottZones() {
    const existing = await Zone.find().select('nom wilayas');
    const taken = new Set();
    existing.forEach((zone) => (zone.wilayas || []).forEach((name) => taken.add(name)));
    for (const name of NOUAKCHOTT_ZONES) {
        if (taken.has(name)) continue;
        const named = existing.find((zone) => zone.nom === name);
        if (named) {
            named.wilayas = [...(named.wilayas || []), name];
            await named.save();
            taken.add(name);
            continue;
        }
        const created = await Zone.create({ nom: name, wilayas: [name] });
        existing.push(created);
        taken.add(name);
    }
}

async function listZones() {
    await ensureNouakchottZones();
    return Zone.find().sort({ nom: 1 }).lean();
}

async function createZone({ nom, wilayas }) {
    const name = clean(nom);
    if (!name) throw new ZoneError('Le nom de la zone est requis.');
    const list = await normalizeWilayas(wilayas);
    try {
        return await Zone.create({ nom: name, wilayas: list });
    } catch (err) {
        if (err && err.code === 11000) throw new ZoneError('Une zone porte deja ce nom.');
        throw err;
    }
}

async function updateZone(id, { nom, wilayas, actif }) {
    const zone = await Zone.findById(id);
    if (!zone) throw new ZoneError('Zone introuvable.', 404);
    if (nom != null) {
        const name = clean(nom);
        if (!name) throw new ZoneError('Le nom de la zone est requis.');
        zone.nom = name;
    }
    if (wilayas != null) {
        zone.wilayas = await normalizeWilayas(wilayas, zone._id);
    }
    if (typeof actif === 'boolean') zone.actif = actif;
    try {
        await zone.save();
    } catch (err) {
        if (err && err.code === 11000) throw new ZoneError('Une zone porte deja ce nom.');
        throw err;
    }
    return zone;
}

async function deleteZone(id) {
    const zone = await Zone.findById(id);
    if (!zone) throw new ZoneError('Zone introuvable.', 404);
    const wilayas = zone.wilayas || [];
    const officielles = wilayas.filter((name) => NOUAKCHOTT_ZONES.includes(name));
    const autres = wilayas.filter((name) => !NOUAKCHOTT_ZONES.includes(name));
    if (officielles.length && !autres.length) {
        const verbe = officielles.length > 1 ? 'restent des zones' : 'reste une zone';
        throw new ZoneError(`${officielles.join(', ')} ${verbe} du référentiel. Vous pouvez la renommer.`);
    }
    const released = await Pam.updateMany({ zoneId: zone._id }, { $set: { zoneId: null } });
    await zone.deleteOne();
    return {
        nom: zone.nom,
        pams: released.modifiedCount || 0,
    };
}

module.exports = {
    ZoneError,
    listZones,
    createZone,
    updateZone,
    deleteZone,
};
