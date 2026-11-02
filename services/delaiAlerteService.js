const Merchant = require('../models/Merchant');
const Agent = require('../models/Agent');
const Eam = require('../models/Eam');

const SEUIL_HEURES = 24;
const SEUIL_MS = SEUIL_HEURES * 60 * 60 * 1000;

function lastHistoryAt(merchant) {
    const history = Array.isArray(merchant.validationHistorique) ? merchant.validationHistorique : [];
    const last = history.length ? history[history.length - 1].at : null;
    return last ? new Date(last) : null;
}

function waitingSince(merchant, kind) {
    if (kind === 'finale') {
        return new Date(merchant.validatedBySupervisorAt || lastHistoryAt(merchant) || merchant.createdAt);
    }
    return new Date(lastHistoryAt(merchant) || merchant.createdAt);
}

function niveauOf(merchant) {
    if (merchant.statut === 'validé_par_superviseur' || merchant.validationEtape === 'admin') {
        return { key: 'finale', label: 'Validation finale' };
    }
    if (merchant.validationEtape === 'cam') return { key: 'cam', label: 'CAM' };
    if (merchant.validationEtape === 'pam') return { key: 'pam', label: 'PAM' };
    return { key: 'sam', label: 'SAM' };
}

function personName(agent) {
    if (!agent) return '';
    const name = [agent.prenom, agent.nom].filter(Boolean).join(' ').trim();
    return name || agent.matricule || '';
}

function asPerson(agent) {
    if (!agent) return null;
    return {
        nom: personName(agent),
        telephone: agent.moovMoneyMsisdn || '',
    };
}

function present(merchant, kind) {
    const since = waitingSince(merchant, kind);
    const elapsed = Date.now() - since.getTime();
    const niveau = niveauOf(merchant);
    return {
        id: String(merchant._id),
        nom: merchant.nom || 'Marchand',
        niveau: niveau.key,
        niveauLabel: niveau.label,
        depuis: since.toISOString(),
        heures: Math.max(0, Math.floor(elapsed / (60 * 60 * 1000))),
        retard: elapsed >= SEUIL_MS,
        intervenants: [],
    };
}

async function actorsFor(merchants) {
    const recruiterIds = [...new Set(merchants.map((item) => item.agentRecruteurId).filter(Boolean).map(String))];
    const recruiters = recruiterIds.length
        ? await Agent.find({ _id: { $in: recruiterIds } }).select('eamId pamId superviseurId').lean()
        : [];
    const recruiterById = new Map(recruiters.map((item) => [String(item._id), item]));
    const eamIds = [...new Set(recruiters.map((item) => item.eamId).filter(Boolean).map(String))];
    const eams = eamIds.length
        ? await Eam.find({ _id: { $in: eamIds } }).select('samId pamId').lean()
        : [];
    const eamById = new Map(eams.map((item) => [String(item._id), item]));

    const pamIds = new Set();
    const samIds = new Set();
    const supervisorIds = new Set();
    merchants.forEach((merchant) => {
        const recruiter = recruiterById.get(String(merchant.agentRecruteurId || ''));
        if (!recruiter) return;
        const eam = recruiter.eamId ? eamById.get(String(recruiter.eamId)) : null;
        const pamId = (eam && eam.pamId) || recruiter.pamId;
        if (pamId) pamIds.add(String(pamId));
        if (eam && eam.samId) samIds.add(String(eam.samId));
        if (recruiter.superviseurId) supervisorIds.add(String(recruiter.superviseurId));
    });

    const actorIds = [...samIds, ...supervisorIds];
    const [named, cams, pams, backoffice] = await Promise.all([
        actorIds.length
            ? Agent.find({ _id: { $in: actorIds }, actif: { $ne: false } }).select('nom prenom matricule moovMoneyMsisdn role').lean()
            : [],
        pamIds.size
            ? Agent.find({ role: 'cam', pamId: { $in: [...pamIds] }, actif: { $ne: false } }).select('nom prenom matricule moovMoneyMsisdn pamId').lean()
            : [],
        pamIds.size
            ? Agent.find({ role: 'pam', pamId: { $in: [...pamIds] }, actif: { $ne: false } }).select('nom prenom matricule moovMoneyMsisdn pamId').lean()
            : [],
        Agent.find({
            role: 'backoffice',
            actif: { $ne: false },
            habilitations: 'validation',
        }).select('nom prenom matricule moovMoneyMsisdn').lean(),
    ]);

    const byId = new Map(named.map((item) => [String(item._id), item]));
    const camsByPam = new Map();
    cams.forEach((item) => {
        const key = String(item.pamId);
        const list = camsByPam.get(key) || [];
        list.push(item);
        camsByPam.set(key, list);
    });
    const pamByOrg = new Map(pams.map((item) => [String(item.pamId), item]));
    let finalePeople = backoffice.map(asPerson).filter((item) => item.nom);
    if (!finalePeople.length) {
        const admins = await Agent.find({ role: 'admin', actif: { $ne: false } })
            .select('nom prenom matricule moovMoneyMsisdn')
            .lean();
        finalePeople = admins.map(asPerson).filter((item) => item.nom);
    }

    function people(merchant, kind) {
        if (kind === 'finale') return finalePeople;
        const recruiter = recruiterById.get(String(merchant.agentRecruteurId || ''));
        if (!recruiter) return [];
        const eam = recruiter.eamId ? eamById.get(String(recruiter.eamId)) : null;
        const pamId = String((eam && eam.pamId) || recruiter.pamId || '');
        const step = niveauOf(merchant).key;
        if (step === 'cam') return (camsByPam.get(pamId) || []).map(asPerson).filter((item) => item.nom);
        if (step === 'pam') {
            const holder = asPerson(pamByOrg.get(pamId));
            return holder && holder.nom ? [holder] : [];
        }
        const sam = (eam && eam.samId && byId.get(String(eam.samId)))
            || (recruiter.superviseurId && byId.get(String(recruiter.superviseurId)));
        const person = asPerson(sam);
        return person && person.nom ? [person] : [];
    }

    return { people, backoffice: backoffice.map(asPerson).filter((item) => item.nom) };
}

async function list() {
    const [terrainDocs, finaleDocs] = await Promise.all([
        Merchant.find({ statut: 'en attente' })
            .select('nom statut validationEtape validationHistorique createdAt agentRecruteurId')
            .lean(),
        Merchant.find({ statut: 'validé_par_superviseur' })
            .select('nom statut validationEtape validationHistorique validatedBySupervisorAt createdAt agentRecruteurId')
            .sort({ validatedBySupervisorAt: 1, createdAt: 1 })
            .limit(200)
            .lean(),
    ]);

    const terrainKept = [];
    const terrainRows = [];
    terrainDocs.forEach((merchant) => {
        const row = present(merchant, 'terrain');
        if (!row.retard) return;
        terrainKept.push(merchant);
        terrainRows.push(row);
    });
    const { people } = await actorsFor([...terrainKept, ...finaleDocs]);
    terrainRows.forEach((row, index) => {
        row.intervenants = people(terrainKept[index], 'terrain');
    });
    const terrain = terrainRows.sort((a, b) => b.heures - a.heures).slice(0, 200);

    const finale = finaleDocs
        .map((merchant) => {
            const row = present(merchant, 'finale');
            row.intervenants = people(merchant, 'finale');
            return row;
        })
        .sort((a, b) => Number(b.retard) - Number(a.retard) || b.heures - a.heures);

    return {
        seuilHeures: SEUIL_HEURES,
        terrain,
        finale,
    };
}

module.exports = {
    SEUIL_HEURES,
    list,
};
