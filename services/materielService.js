const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const Agent = require('../models/Agent');
const Eam = require('../models/Eam');
const Materiel = require('../models/Materiel');
const Kit = require('../models/Kit');
const { notifyMateriel } = require('./notificationService');

const ETAT_LABEL = {
    en_stock: 'En stock',
    en_transit: 'En transit',
    affecte: 'Affecté',
    incident: 'Incident signalé',
    en_reparation: 'En réparation',
    rebut: 'Rebut',
};

const TYPE_LABEL = {
    maitre: 'Appareil maître',
    tiers: 'Accessoire',
};

const MOTIF_LABEL = {
    perdu: 'Perdu',
    vole: 'Volé',
    defectueux: 'Défectueux',
};

const RESTITUTION = new Set(['en_stock', 'en_reparation', 'rebut']);

class MaterielError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

let migrated = false;

function cleanCode(value) {
    return String(value || '').replace(/\s+/g, '').trim().toUpperCase();
}

function cleanName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanType(value) {
    const text = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    if (text.includes('maitre') || text.includes('tablette') || text.includes('smartphone') || text.includes('telephone')) return 'maitre';
    if (text.includes('imprim') || text.includes('accessoire') || text === 'tiers') return 'tiers';
    return null;
}

function present(item, eam) {
    const equipe = eam && eam.nom ? eam.nom : (item.eamId && item.eamId.nom ? item.eamId.nom : '');
    const eamId = eam && eam._id ? eam._id : (item.eamId && item.eamId._id ? item.eamId._id : item.eamId);
    const type = item.type || 'tiers';
    return {
        _id: item._id,
        code: item.code,
        marque: item.marque || '',
        modele: item.modele || '',
        designation: item.designation,
        type,
        typeLabel: TYPE_LABEL[type] || type,
        etat: item.etat,
        etatLabel: ETAT_LABEL[item.etat] || item.etat,
        incidentMotif: item.incidentMotif || '',
        incidentLabel: MOTIF_LABEL[item.incidentMotif] || '',
        eamId: eamId || null,
        equipe: equipe || '',
        affecteAt: item.affecteAt || null,
        recuAt: item.recuAt || null,
    };
}

async function migrateLegacy() {
    if (migrated) return;
    await Materiel.updateMany({ etat: 'affecte', recuAt: null }, { $set: { etat: 'en_transit' } });
    await Materiel.updateMany({ etat: 'recu' }, { $set: { etat: 'affecte' } });
    await Materiel.updateMany({ type: { $exists: false } }, { $set: { type: 'tiers' } });
    migrated = true;
}

async function list() {
    await migrateLegacy();
    const [items, equipes] = await Promise.all([
        Materiel.find().populate('eamId', 'nom').sort({ createdAt: -1 }).lean(),
        Eam.find({ actif: { $ne: false } }).select('nom').sort({ nom: 1 }).lean(),
    ]);
    return {
        lignes: items.map((item) => present(item)),
        equipes: equipes.map((eam) => ({ _id: eam._id, nom: eam.nom })),
    };
}

async function create({ code, marque, modele, type }) {
    await migrateLegacy();
    const clean = cleanCode(code);
    const brand = cleanName(marque);
    const model = cleanName(modele);
    const kind = cleanType(type);
    if (!clean) throw new MaterielError('L’IMEI ou le numéro de série est requis.');
    if (brand.length < 2) throw new MaterielError('La marque est requise.');
    if (model.length < 1) throw new MaterielError('Le modèle est requis.');
    if (!kind) throw new MaterielError('Le type doit être un appareil maître ou un accessoire.');
    const existing = await Materiel.findOne({ code: clean }).select('_id');
    if (existing) throw new MaterielError('Cet IMEI ou numéro de série existe déjà.');
    const item = await Materiel.create({
        code: clean,
        marque: brand,
        modele: model,
        designation: `${brand} ${model}`,
        type: kind,
        etat: 'en_stock',
    });
    return present(item);
}

function headerIndex(headers) {
    const index = {};
    headers.forEach((header, position) => {
        const key = String(header || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
        if (key.includes('marque')) index.marque = position;
        else if (key.includes('modele')) index.modele = position;
        else if (key.includes('imei') || key.includes('serie') || key === 'code') index.code = position;
        else if (key.includes('type')) index.type = position;
    });
    return index;
}

function cellText(value) {
    if (value == null) return '';
    if (typeof value === 'object' && value.text) return String(value.text);
    if (typeof value === 'object' && value.result != null) return String(value.result);
    return String(value);
}

async function rowsFromFile(buffer, filename) {
    const workbook = new ExcelJS.Workbook();
    const name = String(filename || '').toLowerCase();
    if (name.endsWith('.csv')) {
        await workbook.csv.read(Readable.from(buffer));
    } else {
        await workbook.xlsx.load(buffer);
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const rows = [];
    sheet.eachRow((row, rowNumber) => {
        rows.push({ rowNumber, values: row.values.slice(1).map(cellText) });
    });
    return rows;
}

async function importer(buffer, filename) {
    await migrateLegacy();
    const rows = await rowsFromFile(buffer, filename);
    if (rows.length < 2) throw new MaterielError('Le fichier ne contient aucune ligne de matériel.');
    const index = headerIndex(rows[0].values);
    if (index.marque == null || index.modele == null || index.code == null || index.type == null) {
        throw new MaterielError('Les colonnes attendues sont Marque, Modèle, IMEI et Type.');
    }
    const crees = [];
    const ignores = [];
    for (const row of rows.slice(1)) {
        const marque = row.values[index.marque];
        const modele = row.values[index.modele];
        const code = row.values[index.code];
        const type = row.values[index.type];
        if (!cleanCode(code) && !cleanName(marque) && !cleanName(modele)) continue;
        try {
            crees.push(await create({ code, marque, modele, type }));
        } catch (err) {
            ignores.push({ ligne: row.rowNumber, msg: err.message || 'Ligne ignorée.' });
        }
    }
    return { crees: crees.length, ignores };
}

async function loadEam(eamId) {
    if (!eamId) throw new MaterielError('Choisissez une équipe.');
    const eam = await Eam.findById(eamId).select('nom actif');
    if (!eam || eam.actif === false) throw new MaterielError('Équipe introuvable.');
    return eam;
}

async function assignLot(ids, eamId) {
    await migrateLegacy();
    const eam = await loadEam(eamId);
    const unique = [...new Set((ids || []).map(String))].filter(Boolean);
    if (!unique.length) throw new MaterielError('Sélectionnez au moins un équipement.');
    const items = await Materiel.find({ _id: { $in: unique } });
    if (items.length !== unique.length) throw new MaterielError('Un équipement sélectionné est introuvable.', 404);
    const bloque = items.find((item) => item.etat !== 'en_stock');
    if (bloque) throw new MaterielError('Seuls les équipements en stock peuvent partir en transit.');
    const now = new Date();
    await Materiel.updateMany(
        { _id: { $in: unique } },
        { $set: { eamId: eam._id, etat: 'en_transit', affecteAt: now, recuAt: null, incidentMotif: null } }
    );
    return { affectes: unique.length, equipe: eam.nom };
}

async function remove(id) {
    await migrateLegacy();
    const item = await Materiel.findById(id);
    if (!item) throw new MaterielError('Matériel introuvable.', 404);
    if (item.etat !== 'en_stock') throw new MaterielError('Seuls les équipements en stock peuvent être supprimés.');
    await item.deleteOne();
}

async function restituer(code, etat) {
    await migrateLegacy();
    if (!RESTITUTION.has(etat)) throw new MaterielError('Le statut de restitution doit être En stock, En réparation ou Rebut.');
    const item = await Materiel.findOne({ code: cleanCode(code) });
    if (!item) throw new MaterielError('Aucun équipement ne correspond à ce code.', 404);
    item.eamId = null;
    item.etat = etat;
    item.recuAt = null;
    if (etat === 'en_stock') item.incidentMotif = null;
    await item.save();
    return present(item);
}

async function loadTeam(userId) {
    const agent = await Agent.findById(userId).select('role eamId');
    if (!agent || agent.role !== 'aam' || !agent.eamId) {
        throw new MaterielError('Le matériel est réservé au compte de l’équipe.', 403);
    }
    return agent;
}

async function mine(userId) {
    await migrateLegacy();
    const agent = await loadTeam(userId);
    const items = await Materiel.find({ eamId: agent.eamId }).sort({ etat: 1, designation: 1 }).lean();
    return { lignes: items.map((item) => present(item)) };
}

async function recevoirMaitre(userId, id, identifiants) {
    await migrateLegacy();
    const agent = await loadTeam(userId);
    const item = await Materiel.findById(id);
    if (!item || !item.eamId || String(item.eamId) !== String(agent.eamId)) {
        throw new MaterielError('Matériel introuvable.', 404);
    }
    if (item.type !== 'maitre') throw new MaterielError('Cet accessoire se réceptionne en scannant son code.');
    if (item.etat === 'affecte') return present(item);
    if (item.etat !== 'en_transit') throw new MaterielError('Cet appareil n’est pas en transit.');
    const lus = [...new Set((identifiants || []).map(cleanCode).filter(Boolean))];
    if (!lus.length) throw new MaterielError('Cet appareil n’a pas communiqué son IMEI ni son numéro de série.');
    if (!lus.includes(item.code)) throw new MaterielError('L’identifiant de cet appareil ne correspond pas à la fiche.');
    item.etat = 'affecte';
    item.recuAt = new Date();
    await item.save();
    await cloturerKitSiComplet(item._id);
    return present(item);
}

async function recevoirScan(userId, code) {
    await migrateLegacy();
    const agent = await loadTeam(userId);
    const item = await Materiel.findOne({ code: cleanCode(code) });
    if (!item || !item.eamId || String(item.eamId) !== String(agent.eamId)) {
        throw new MaterielError('Ce code ne correspond à aucun accessoire en transit pour votre équipe.', 404);
    }
    if (item.type !== 'tiers') throw new MaterielError('L’appareil maître se confirme sans scan, depuis sa fiche.');
    if (item.etat === 'affecte') return present(item);
    if (item.etat !== 'en_transit') throw new MaterielError('Cet accessoire n’est pas en transit.');
    item.etat = 'affecte';
    item.recuAt = new Date();
    await item.save();
    await cloturerKitSiComplet(item._id);
    return present(item);
}

async function signaler(userId, id, motif) {
    await migrateLegacy();
    if (!MOTIF_LABEL[motif]) throw new MaterielError('Le motif doit être perdu, volé ou défectueux.');
    const agent = await loadTeam(userId);
    const item = await Materiel.findById(id);
    if (!item || !item.eamId || String(item.eamId) !== String(agent.eamId)) {
        throw new MaterielError('Matériel introuvable.', 404);
    }
    if (!['affecte', 'en_transit'].includes(item.etat)) {
        throw new MaterielError('Un incident se signale sur un équipement en transit ou affecté.');
    }
    item.etat = 'incident';
    item.incidentMotif = motif;
    await item.save();
    return present(item);
}

const KIT_LABEL = {
    pret: 'Prêt au comptoir',
    en_transit: 'Remis, en attente de réception',
    affecte: 'Réceptionné',
};

function cleanKitNom(value) {
    return cleanCode(value).replace(/[^A-Z0-9_]/g, '');
}

async function cloturerKitSiComplet(materielId) {
    const kit = await Kit.findOne({ materielIds: materielId, etat: 'en_transit' });
    if (!kit) return;
    const items = await Materiel.find({ _id: { $in: kit.materielIds } }).select('etat');
    if (items.length && items.every((item) => item.etat === 'affecte')) {
        kit.etat = 'affecte';
        await kit.save();
    }
}

async function presentKit(kit) {
    const items = await Materiel.find({ _id: { $in: kit.materielIds || [] } }).lean();
    const byId = new Map(items.map((item) => [String(item._id), item]));
    const eam = kit.eamId && kit.eamId.nom ? kit.eamId : null;
    return {
        _id: kit._id,
        nom: kit.nom,
        etat: kit.etat,
        etatLabel: KIT_LABEL[kit.etat] || kit.etat,
        eamId: eam ? eam._id : (kit.eamId && kit.eamId._id ? kit.eamId._id : kit.eamId),
        equipe: eam ? eam.nom : '',
        lignes: (kit.materielIds || []).map((id) => present(byId.get(String(id)) || { _id: id, code: '', designation: 'Retiré', etat: 'en_stock', type: 'tiers' })),
    };
}

async function listKits() {
    const kits = await Kit.find().populate('eamId', 'nom').sort({ createdAt: -1 }).lean();
    return Promise.all(kits.map((kit) => presentKit(kit)));
}

async function creerKit({ nom, codes }) {
    await migrateLegacy();
    const name = cleanKitNom(nom);
    if (name.length < 3) throw new MaterielError('Donnez un identifiant de kit, par exemple KIT_NOUAKCHOTT_12.');
    const uniqueCodes = [...new Set((codes || []).map(cleanCode).filter(Boolean))];
    if (uniqueCodes.length < 2) throw new MaterielError('Un kit regroupe au moins deux équipements, par exemple une tablette et une imprimante.');
    const items = await Materiel.find({ code: { $in: uniqueCodes } });
    if (items.length !== uniqueCodes.length) throw new MaterielError('Un code scanné ne correspond à aucun équipement en stock.');
    const bloque = items.find((item) => item.etat !== 'en_stock');
    if (bloque) throw new MaterielError(`${bloque.code} n’est pas disponible en stock.`);
    const deja = await Kit.findOne({
        materielIds: { $in: items.map((item) => item._id) },
        etat: { $in: ['pret', 'en_transit'] },
    }).select('nom');
    if (deja) throw new MaterielError(`Un équipement est déjà dans le kit ${deja.nom}.`);
    try {
        const kit = await Kit.create({ nom: name, materielIds: items.map((item) => item._id), etat: 'pret' });
        return presentKit(kit);
    } catch (err) {
        if (err && err.code === 11000) throw new MaterielError('Cet identifiant de kit existe déjà.');
        throw err;
    }
}

async function dispatcher({ nom, eamId }) {
    await migrateLegacy();
    const kit = await Kit.findOne({ nom: cleanKitNom(nom) });
    if (!kit) throw new MaterielError('Aucun kit ne correspond à ce code.', 404);
    if (kit.etat !== 'pret') throw new MaterielError('Ce kit a déjà été remis.');
    const result = await assignLot(kit.materielIds, eamId);
    kit.eamId = (await loadEam(eamId))._id;
    kit.etat = 'en_transit';
    await kit.save();
    const equipe = await Agent.findOne({ role: 'aam', eamId: kit.eamId, actif: { $ne: false } }).select('_id');
    if (equipe) {
        try {
            await notifyMateriel(equipe._id, kit.nom);
        } catch (err) {
            console.error('Notification kit:', err.message);
        }
    }
    return { kit: kit.nom, equipe: result.equipe, affectes: result.affectes };
}

async function chercherCode(code) {
    await migrateLegacy();
    const item = await Materiel.findOne({ code: cleanCode(code) }).populate('eamId', 'nom');
    if (!item) throw new MaterielError('Aucun équipement ne correspond à ce code.', 404);
    return present(item);
}

async function sav() {
    await migrateLegacy();
    const items = await Materiel.find({
        $or: [
            { etat: { $in: ['incident', 'en_reparation'] } },
            { incidentMotif: { $in: ['perdu', 'vole', 'defectueux'] } },
        ],
    }).populate('eamId', 'nom').sort({ updatedAt: -1 }).lean();
    const lignes = items.map((item) => present(item));
    return {
        lignes,
        comptes: {
            panne: lignes.filter((item) => item.etat === 'incident' && item.incidentMotif === 'defectueux').length,
            fournisseur: lignes.filter((item) => item.etat === 'en_reparation').length,
            perdus: lignes.filter((item) => item.incidentMotif === 'perdu').length,
            voles: lignes.filter((item) => item.incidentMotif === 'vole').length,
        },
    };
}

function toCsv(lignes) {
    const header = ['Marque', 'Modèle', 'IMEI', 'Type', 'État', 'Incident', 'Équipe', 'Affecté le', 'Reçu le'];
    const rows = lignes.map((item) => [
        item.marque,
        item.modele,
        item.code,
        item.typeLabel,
        item.etatLabel,
        item.incidentLabel,
        item.equipe,
        item.affecteAt ? new Date(item.affecteAt).toISOString() : '',
        item.recuAt ? new Date(item.recuAt).toISOString() : '',
    ]);
    const lines = [header, ...rows].map((row) => row.map((cell) => {
        const text = String(cell ?? '');
        return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(';'));
    return `\uFEFF${lines.join('\n')}`;
}

module.exports = {
    MaterielError,
    list,
    create,
    importer,
    assignLot,
    listKits,
    creerKit,
    dispatcher,
    chercherCode,
    sav,
    remove,
    restituer,
    mine,
    recevoirMaitre,
    recevoirScan,
    signaler,
    toCsv,
};
