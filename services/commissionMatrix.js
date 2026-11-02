const Agent = require('../models/Agent');
const Eam = require('../models/Eam');
const { isFieldAgent, isFieldSupervisor } = require('../utils/roles');
const { normalizeMoovMsisdn } = require('../utils/normalizeMsisdn');

const SLOT_SELECT = 'role nom prenom moovMoneyMsisdn actif eamId uamId pamId superviseurId';

function toSlot(agent) {
    if (!agent || agent.actif === false) return undefined;
    return {
        agentId: agent._id,
        role: agent.role,
        nom: agent.nom || '',
        prenom: agent.prenom || '',
        msisdn: normalizeMoovMsisdn(agent.moovMoneyMsisdn),
    };
}

function memberSlot(member) {
    if (!member || !member.msisdn) return undefined;
    const msisdn = normalizeMoovMsisdn(member.msisdn);
    if (!msisdn) return undefined;
    return {
        role: 'aam',
        nom: member.nom || '',
        prenom: member.prenom || '',
        nni: member.nni || '',
        msisdn,
    };
}

/**
 * Photo des numeros a transmettre a Moov pour ce dossier.
 * aam1 et aam2 = les deux membres de l'equipe, avec leur MSISDN.
 * Sans membres enregistres, aam1 reste le compte equipe et aam2 l'ancien binome.
 * SAM, CAM et PAM = le titulaire actif du niveau, sinon le slot est absent.
 */
async function buildCommissionMatrix(recruiterOrId, options = {}) {
    const id = recruiterOrId && recruiterOrId._id ? recruiterOrId._id : recruiterOrId;
    const matrix = { capturedAt: new Date() };
    if (!id) return matrix;

    const recruiter = await Agent.findById(id).select(SLOT_SELECT);
    if (!recruiter || recruiter.actif === false) return matrix;

    let eam = null;
    if (recruiter.eamId) {
        eam = await Eam.findById(recruiter.eamId);
        if (eam && eam.actif !== false) {
            const members = Array.isArray(eam.membres) ? eam.membres : [];
            if (members.length >= 2 && members[0].msisdn && members[1].msisdn) {
                matrix.aam1 = memberSlot(members[0]);
                matrix.aam2 = memberSlot(members[1]);
            } else if (isFieldAgent(recruiter.role)) {
                matrix.aam1 = toSlot(recruiter);
                const peer = await Agent.findOne({
                    eamId: eam._id,
                    role: 'aam',
                    actif: { $ne: false },
                    _id: { $ne: recruiter._id },
                }).select(SLOT_SELECT).sort({ dateCreation: 1 });
                if (peer) matrix.aam2 = toSlot(peer);
            }

            if (eam.samId) {
                const sam = await Agent.findById(eam.samId).select(SLOT_SELECT);
                if (sam && sam.actif !== false && isFieldSupervisor(sam.role)) {
                    matrix.sam = toSlot(sam);
                }
            }
        }
    }

    if (!matrix.aam1 && isFieldAgent(recruiter.role)) {
        matrix.aam1 = toSlot(recruiter);
    }

    if (!matrix.sam && !recruiter.eamId && recruiter.superviseurId) {
        const sam = await Agent.findById(recruiter.superviseurId).select(SLOT_SELECT);
        if (sam && sam.actif !== false && isFieldSupervisor(sam.role)) {
            matrix.sam = toSlot(sam);
        }
    }

    const pamId = (eam && eam.actif !== false && eam.pamId) || recruiter.pamId;
    if (pamId && (!options.taille || options.taille === 'Gros')) {
        const cam = await Agent.findOne({
            role: 'cam',
            pamId,
            actif: { $ne: false },
        }).select(SLOT_SELECT);
        if (cam) matrix.cam = toSlot(cam);
    }

    if (pamId) {
        const pam = await Agent.findOne({
            role: 'pam',
            pamId,
            actif: { $ne: false },
        }).select(SLOT_SELECT);
        if (pam) matrix.pam = toSlot(pam);
    }

    return matrix;
}

async function attachCommissionMatrix(merchant, recruiter) {
    merchant.commissionMatrix = await buildCommissionMatrix(recruiter || merchant.agentRecruteurId, {
        taille: merchant && merchant.taille,
    });
    return merchant;
}

function clearCommissionMatrix(merchant) {
    merchant.commissionMatrix = undefined;
    return merchant;
}

module.exports = {
    buildCommissionMatrix,
    attachCommissionMatrix,
    clearCommissionMatrix,
};
