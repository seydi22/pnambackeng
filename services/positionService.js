const Agent = require('../models/Agent');
const Eam = require('../models/Eam');
const Tournee = require('../models/Tournee');
const PositionEquipe = require('../models/PositionEquipe');

const ACTIONS = {
    debut_tournee: 'Début de tournée',
    fin_tournee: 'Fin de tournée',
    enrolement: 'Enrôlement',
    correction: 'Correction',
    suivi: 'En tournée',
};

function readCoord(value) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
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

async function recordForUser(userId, { latitude, longitude, action, merchantId }) {
    const lat = readCoord(latitude);
    const lng = readCoord(longitude);
    if (lat == null || lng == null) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    if (!ACTIONS[action]) return null;
    try {
        const agent = await Agent.findById(userId).select('role eamId');
        if (!agent || agent.role !== 'aam' || !agent.eamId) return null;
        return PositionEquipe.create({
            eamId: agent.eamId,
            agentId: agent._id,
            latitude: lat,
            longitude: lng,
            action,
            merchantId: merchantId || undefined,
        });
    } catch (err) {
        console.error('Position equipe:', err.message);
        return null;
    }
}

async function mapForDay(jour) {
    const { start, end } = dayBounds(jour);
    const [points, openTours] = await Promise.all([
        PositionEquipe.find({ createdAt: { $gte: start, $lt: end } })
            .sort({ createdAt: 1 })
            .populate('eamId', 'nom')
            .populate('agentId', 'matricule')
            .lean(),
        Tournee.find({ fin: null }).select('eamId').lean(),
    ]);
    const openIds = new Set(openTours.map((tour) => String(tour.eamId)));
    const byTeam = new Map();
    points.forEach((point) => {
        const eamId = point.eamId && point.eamId._id ? String(point.eamId._id) : String(point.eamId);
        const bucket = byTeam.get(eamId) || {
            eamId,
            equipe: point.eamId && point.eamId.nom ? point.eamId.nom : '—',
            matricule: point.agentId && point.agentId.matricule ? point.agentId.matricule : '',
            points: [],
        };
        bucket.points.push({
            latitude: point.latitude,
            longitude: point.longitude,
            at: point.createdAt,
            action: point.action,
            actionLabel: ACTIONS[point.action] || point.action,
        });
        byTeam.set(eamId, bucket);
    });

    const latestByTeam = new Map();
    if (openIds.size) {
        const latest = await PositionEquipe.find({ eamId: { $in: [...openIds] } })
            .sort({ createdAt: -1 })
            .populate('eamId', 'nom')
            .populate('agentId', 'matricule')
            .lean();
        latest.forEach((point) => {
            const eamId = point.eamId && point.eamId._id ? String(point.eamId._id) : String(point.eamId);
            if (!latestByTeam.has(eamId)) latestByTeam.set(eamId, point);
        });
    }

    const equipes = [...openIds].map((eamId) => {
        const point = latestByTeam.get(eamId);
        if (!point) return null;
        return {
            eamId,
            equipe: point.eamId && point.eamId.nom ? point.eamId.nom : '—',
            matricule: point.agentId && point.agentId.matricule ? point.agentId.matricule : '',
            latitude: point.latitude,
            longitude: point.longitude,
            at: point.createdAt,
            action: point.action,
            actionLabel: ACTIONS[point.action] || point.action,
            ouverte: true,
        };
    }).filter(Boolean);

    const missingNames = equipes.filter((item) => item.equipe === '—').map((item) => item.eamId);
    if (missingNames.length) {
        const eams = await Eam.find({ _id: { $in: missingNames } }).select('nom').lean();
        const names = new Map(eams.map((eam) => [String(eam._id), eam.nom]));
        equipes.forEach((item) => {
            if (names.has(item.eamId)) item.equipe = names.get(item.eamId);
        });
    }

    return {
        jour: start.toISOString().slice(0, 10),
        equipes,
        traces: [...byTeam.values()],
    };
}

module.exports = {
    recordForUser,
    mapForDay,
};
