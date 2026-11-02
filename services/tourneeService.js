const Agent = require('../models/Agent');
const Tournee = require('../models/Tournee');

class TourError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

function dayBounds(jour) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(jour || ''));
    const now = new Date();
    const start = match
        ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start, end };
}

function dureeMinutes(tournee, now = new Date()) {
    const fin = tournee.fin ? new Date(tournee.fin) : now;
    const debut = new Date(tournee.debut);
    return Math.max(0, Math.round((fin.getTime() - debut.getTime()) / 60000));
}

async function loadTeam(userId) {
    const agent = await Agent.findById(userId).select('role eamId actif');
    if (!agent || agent.role !== 'aam' || !agent.eamId) {
        throw new TourError('Le pointage est reserve au compte de l equipe.');
    }
    if (agent.actif === false) throw new TourError('Ce compte est desactive.');
    return agent;
}

async function ouverte(eamId) {
    return Tournee.findOne({ eamId, fin: null }).sort({ debut: -1 });
}

async function current(userId) {
    const agent = await loadTeam(userId);
    const tournee = await ouverte(agent.eamId);
    return {
        ouverte: Boolean(tournee),
        tournee: tournee ? tournee.toObject() : null,
    };
}

async function start(userId) {
    const agent = await loadTeam(userId);
    const existing = await ouverte(agent.eamId);
    if (existing) throw new TourError('Une tournee est deja en cours.');
    return Tournee.create({ eamId: agent.eamId, agentId: agent._id, debut: new Date() });
}

async function stop(userId) {
    const agent = await loadTeam(userId);
    const tournee = await ouverte(agent.eamId);
    if (!tournee) throw new TourError('Aucune tournee en cours.');
    tournee.fin = new Date();
    await tournee.save();
    return tournee;
}

async function listForDay(jour) {
    const { start, end } = dayBounds(jour);
    const now = new Date();
    const isToday = now >= start && now < end;
    const filter = isToday
        ? { $or: [{ debut: { $gte: start, $lt: end } }, { fin: null }] }
        : { debut: { $gte: start, $lt: end } };
    const rows = await Tournee.find(filter)
        .populate('eamId', 'nom')
        .populate('agentId', 'matricule')
        .sort({ debut: -1 })
        .lean();
    const lignes = rows.map((row) => ({
        _id: row._id,
        equipe: row.eamId && row.eamId.nom ? row.eamId.nom : '—',
        eamId: row.eamId && row.eamId._id ? row.eamId._id : row.eamId,
        matricule: row.agentId && row.agentId.matricule ? row.agentId.matricule : '',
        debut: row.debut,
        fin: row.fin,
        ouverte: !row.fin,
        dureeMinutes: dureeMinutes(row, now),
    }));
    const totaux = new Map();
    lignes.forEach((ligne) => {
        const key = String(ligne.eamId || ligne.equipe);
        const currentTotal = totaux.get(key) || { equipe: ligne.equipe, dureeMinutes: 0 };
        currentTotal.dureeMinutes += ligne.dureeMinutes;
        totaux.set(key, currentTotal);
    });
    return {
        jour: start.toISOString().slice(0, 10),
        lignes,
        totaux: [...totaux.values()].sort((a, b) => b.dureeMinutes - a.dureeMinutes),
    };
}

module.exports = {
    TourError,
    current,
    start,
    stop,
    listForDay,
};
