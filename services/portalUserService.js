const bcrypt = require('bcryptjs');
const Agent = require('../models/Agent');
const { HABILITATIONS, sanitize } = require('../utils/habilitations');

class PortalError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

function present(agent) {
    return {
        _id: agent._id,
        matricule: agent.matricule,
        nom: agent.nom || '',
        prenom: agent.prenom || '',
        actif: agent.actif !== false,
        habilitations: agent.habilitations || [],
    };
}

async function list() {
    const users = await Agent.find({ role: 'backoffice' }).sort({ matricule: 1 }).lean();
    return { habilitations: HABILITATIONS, comptes: users.map(present) };
}

async function create({ nom, prenom, matricule, motDePasse, habilitations }) {
    const code = String(matricule || '').trim();
    const keys = sanitize(habilitations);
    if (!code) throw new PortalError('Le matricule est requis.');
    if (!String(motDePasse || '') || String(motDePasse).length < 6) {
        throw new PortalError('Le mot de passe doit contenir au moins 6 caractères.');
    }
    if (!keys.length) throw new PortalError('Cochez au moins une habilitation.');
    const existing = await Agent.findOne({ matricule: code }).select('_id');
    if (existing) throw new PortalError('Ce matricule existe déjà.');
    const agent = await Agent.create({
        matricule: code,
        motDePasse: await bcrypt.hash(String(motDePasse), 10),
        nom: String(nom || '').trim(),
        prenom: String(prenom || '').trim(),
        role: 'backoffice',
        affiliation: 'Portail',
        actif: true,
        habilitations: keys,
    });
    return present(agent);
}

async function update(id, { nom, prenom, motDePasse, habilitations, actif }) {
    const agent = await Agent.findById(id).select('+motDePasse');
    if (!agent || agent.role !== 'backoffice') throw new PortalError('Compte introuvable.', 404);
    if (nom != null) agent.nom = String(nom).trim();
    if (prenom != null) agent.prenom = String(prenom).trim();
    if (habilitations != null) {
        const keys = sanitize(habilitations);
        if (!keys.length) throw new PortalError('Cochez au moins une habilitation.');
        agent.habilitations = keys;
    }
    if (actif != null) agent.actif = Boolean(actif);
    if (motDePasse) {
        if (String(motDePasse).length < 6) throw new PortalError('Le mot de passe doit contenir au moins 6 caractères.');
        agent.motDePasse = await bcrypt.hash(String(motDePasse), 10);
    }
    await agent.save();
    return present(agent);
}

function presentLogisticien(agent) {
    return {
        _id: agent._id,
        matricule: agent.matricule,
        nom: agent.nom || '',
        prenom: agent.prenom || '',
        actif: agent.actif !== false,
    };
}

async function listLogisticiens() {
    const users = await Agent.find({ role: 'logisticien' }).sort({ matricule: 1 }).lean();
    return users.map(presentLogisticien);
}

async function createLogisticien({ nom, prenom, matricule, motDePasse }) {
    const code = String(matricule || '').trim();
    if (!code) throw new PortalError('Le matricule est requis.');
    if (!String(motDePasse || '') || String(motDePasse).length < 6) {
        throw new PortalError('Le mot de passe doit contenir au moins 6 caractères.');
    }
    const existing = await Agent.findOne({ matricule: code }).select('_id');
    if (existing) throw new PortalError('Ce matricule existe déjà.');
    const agent = await Agent.create({
        matricule: code,
        motDePasse: await bcrypt.hash(String(motDePasse), 10),
        nom: String(nom || '').trim(),
        prenom: String(prenom || '').trim(),
        role: 'logisticien',
        affiliation: 'Logistique',
        actif: true,
        habilitations: [],
    });
    return presentLogisticien(agent);
}

async function updateLogisticien(id, { nom, prenom, motDePasse, actif }) {
    const agent = await Agent.findById(id).select('+motDePasse');
    if (!agent || agent.role !== 'logisticien') throw new PortalError('Compte introuvable.', 404);
    if (nom != null) agent.nom = String(nom).trim();
    if (prenom != null) agent.prenom = String(prenom).trim();
    if (actif != null) agent.actif = Boolean(actif);
    if (motDePasse) {
        if (String(motDePasse).length < 6) throw new PortalError('Le mot de passe doit contenir au moins 6 caractères.');
        agent.motDePasse = await bcrypt.hash(String(motDePasse), 10);
    }
    await agent.save();
    return presentLogisticien(agent);
}

module.exports = {
    PortalError,
    list,
    create,
    update,
    listLogisticiens,
    createLogisticien,
    updateLogisticien,
};
