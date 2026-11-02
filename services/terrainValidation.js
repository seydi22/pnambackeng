const Agent = require('../models/Agent');
const Eam = require('../models/Eam');
const Uam = require('../models/Uam');
const { isFieldSupervisor, FIELD_AGENT_ROLES } = require('../utils/roles');
const { attachCommissionMatrix, clearCommissionMatrix } = require('./commissionMatrix');
const { notifyCorrection } = require('./notificationService');

const STEP_ORDER = ['sam', 'cam', 'pam'];

class TerrainError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

async function activeAgent(id) {
    if (!id) return null;
    const agent = await Agent.findById(id).select('role actif pamId eamId superviseurId');
    if (!agent || agent.actif === false) return null;
    return agent;
}

async function legacyUam(eam, recruiter) {
    const uamId = (eam && eam.uamId) || (recruiter && recruiter.uamId);
    if (!uamId) return null;
    const uam = await Uam.findById(uamId).select('pamId camId actif');
    if (!uam || uam.actif === false) return null;
    return uam;
}

async function pamIdFor(recruiter, eam) {
    if (eam && eam.pamId) return eam.pamId;
    if (recruiter && recruiter.pamId) return recruiter.pamId;
    const uam = await legacyUam(eam, recruiter);
    return uam ? uam.pamId : null;
}

async function activeCam(pamId, eam, recruiter) {
    if (pamId) {
        const cam = await Agent.findOne({
            role: 'cam',
            pamId,
            actif: { $ne: false },
        }).select('_id role pamId');
        if (cam) return cam;
    }
    const uam = await legacyUam(eam, recruiter);
    if (uam && uam.camId) return activeAgent(uam.camId);
    return null;
}

/**
 * SAM, puis CAM seulement pour un marchand Gros, puis PAM.
 * Un niveau sans titulaire actif est absent de la chaine.
 */
async function resolveChain(recruiter, merchant) {
    if (!recruiter) return [];
    const steps = [];

    let eam = null;
    if (recruiter.eamId) {
        eam = await Eam.findById(recruiter.eamId);
        if (eam && eam.actif !== false) {
            const sam = await activeAgent(eam.samId);
            if (sam && isFieldSupervisor(sam.role)) steps.push('sam');
        }
    }

    if (!steps.includes('sam') && !recruiter.eamId && recruiter.superviseurId) {
        const supervisor = await activeAgent(recruiter.superviseurId);
        if (supervisor && isFieldSupervisor(supervisor.role)) steps.push('sam');
    }

    const pamId = await pamIdFor(recruiter, eam);
    const taille = merchant && merchant.taille;
    if (taille === 'Gros') {
        const cam = await activeCam(pamId, eam, recruiter);
        if (cam && cam.role === 'cam') steps.push('cam');
    }

    if (pamId) {
        const pam = await Agent.findOne({
            role: 'pam',
            pamId,
            actif: { $ne: false },
        }).select('_id');
        if (pam) steps.push('pam');
    }

    return steps;
}

function currentStep(merchant) {
    if (!merchant || merchant.statut !== 'en attente') return null;
    if (STEP_ORDER.includes(merchant.validationEtape)) return merchant.validationEtape;
    if (!merchant.validationEtape) return 'sam';
    return null;
}

async function assignInitialStep(merchant, recruiter) {
    const chain = await resolveChain(recruiter, merchant);
    if (!Array.isArray(merchant.validationHistorique)) {
        merchant.validationHistorique = [];
    }
    const first = chain[0] || 'admin';
    merchant.validationHistorique.push({
        etape: first,
        agentId: recruiter ? recruiter._id : undefined,
        action: 'soumis',
        at: new Date(),
    });
    merchant.rejectionReason = '';
    if (chain.length === 0) {
        merchant.statut = 'validé_par_superviseur';
        merchant.validationEtape = 'admin';
        await attachCommissionMatrix(merchant, recruiter);
        return merchant;
    }
    clearCommissionMatrix(merchant);
    merchant.statut = 'en attente';
    merchant.validationEtape = chain[0];
    return merchant;
}

async function assertCanAct(actor, merchant) {
    const step = currentStep(merchant);
    if (!step) {
        throw new TerrainError('Ce dossier n\'est pas en attente de validation terrain.');
    }
    const recruiter = await Agent.findById(merchant.agentRecruteurId)
        .select('eamId uamId pamId superviseurId role');
    if (!recruiter) {
        throw new TerrainError('Agent recruteur introuvable.', 404);
    }

    if (step === 'sam') {
        let allowed = false;
        if (recruiter.eamId) {
            const eam = await Eam.findById(recruiter.eamId).select('samId');
            allowed = !!(eam && eam.samId && String(eam.samId) === String(actor._id));
        }
        if (!allowed && recruiter.superviseurId && String(recruiter.superviseurId) === String(actor._id)) {
            allowed = isFieldSupervisor(actor.role);
        }
        if (!allowed) throw new TerrainError('Action non autorisee pour cette etape SAM.', 403);
    } else if (step === 'cam') {
        if (actor.role !== 'cam' || !actor.pamId) {
            throw new TerrainError('Action non autorisee pour cette etape CAM.', 403);
        }
        const eam = recruiter.eamId ? await Eam.findById(recruiter.eamId).select('pamId uamId') : null;
        const pamId = await pamIdFor(recruiter, eam);
        if (!pamId || String(pamId) !== String(actor.pamId)) {
            throw new TerrainError('Action non autorisee pour cette etape CAM.', 403);
        }
    } else if (step === 'pam') {
        if (actor.role !== 'pam' || !actor.pamId) {
            throw new TerrainError('Action non autorisee pour cette etape PAM.', 403);
        }
        const pamId = recruiter.pamId;
        if (!pamId || String(pamId) !== String(actor.pamId)) {
            throw new TerrainError('Action non autorisee pour cette etape PAM.', 403);
        }
    }

    return { step, recruiter };
}

function nextStep(chain, step) {
    const index = chain.indexOf(step);
    if (index >= 0) return chain[index + 1] || null;
    const position = STEP_ORDER.indexOf(step);
    return chain.find((item) => STEP_ORDER.indexOf(item) > position) || null;
}

async function validateTerrain(merchant, actor) {
    const { step, recruiter } = await assertCanAct(actor, merchant);
    const chain = await resolveChain(recruiter, merchant);
    const following = nextStep(chain, step);

    if (!Array.isArray(merchant.validationHistorique)) merchant.validationHistorique = [];
    merchant.validationHistorique.push({
        etape: step,
        agentId: actor._id,
        action: 'valide',
        at: new Date(),
    });
    merchant.rejectionReason = '';

    if (following) {
        merchant.statut = 'en attente';
        merchant.validationEtape = following;
        clearCommissionMatrix(merchant);
    } else {
        merchant.statut = 'validé_par_superviseur';
        merchant.validationEtape = 'admin';
        merchant.validatedBySupervisor = actor._id;
        merchant.validatedBySupervisorAt = new Date();
        await attachCommissionMatrix(merchant, recruiter);
    }

    await merchant.save();
    return merchant;
}

async function rejectTerrain(merchant, actor, rejectionReason) {
    const reason = String(rejectionReason || '').trim();
    if (!reason) throw new TerrainError('La raison du rejet est requise.');
    const { step } = await assertCanAct(actor, merchant);

    if (!Array.isArray(merchant.validationHistorique)) merchant.validationHistorique = [];
    merchant.validationHistorique.push({
        etape: step,
        agentId: actor._id,
        action: 'rejete',
        at: new Date(),
    });
    merchant.statut = 'rejeté';
    merchant.rejectionReason = `Rejeté, à corriger : ${reason}`;
    merchant.set('validationEtape', undefined);
    clearCommissionMatrix(merchant);
    await merchant.save();
    await notifyCorrection(merchant);
    return merchant;
}

async function recruiterIdsForScope(actor) {
    if (isFieldSupervisor(actor.role)) {
        const eams = await Eam.find({ samId: actor._id }).select('_id');
        const or = [{ superviseurId: actor._id }];
        if (eams.length) or.push({ eamId: { $in: eams.map((eam) => eam._id) } });
        const agents = await Agent.find({ $or: or }).select('_id');
        return agents.map((agent) => agent._id);
    }
    if (actor.role === 'cam' && actor.pamId) {
        const agents = await Agent.find({
            pamId: actor.pamId,
            role: { $in: FIELD_AGENT_ROLES },
        }).select('_id');
        return agents.map((agent) => agent._id);
    }
    if (actor.role === 'pam' && actor.pamId) {
        const agents = await Agent.find({
            pamId: actor.pamId,
            role: { $in: FIELD_AGENT_ROLES },
        }).select('_id');
        return agents.map((agent) => agent._id);
    }
    return [];
}

async function findPendingForActor(actor) {
    const clauses = [];

    if (isFieldSupervisor(actor.role)) {
        const ids = await recruiterIdsForScope(actor);
        if (ids.length) {
            clauses.push({
                agentRecruteurId: { $in: ids },
                statut: 'en attente',
                $or: [{ validationEtape: 'sam' }, { validationEtape: null }],
            });
        }
    }
    if (actor.role === 'cam' && actor.pamId) {
        const ids = await recruiterIdsForScope(actor);
        if (ids.length) {
            clauses.push({
                agentRecruteurId: { $in: ids },
                statut: 'en attente',
                validationEtape: 'cam',
                taille: 'Gros',
            });
        }
    }
    if (actor.role === 'pam' && actor.pamId) {
        const ids = await recruiterIdsForScope(actor);
        if (ids.length) {
            clauses.push({
                agentRecruteurId: { $in: ids },
                statut: 'en attente',
                validationEtape: 'pam',
            });
        }
    }

    if (!clauses.length) return null;
    return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function loadActor(userId) {
    return Agent.findById(userId);
}

module.exports = {
    TerrainError,
    STEP_ORDER,
    resolveChain,
    currentStep,
    assignInitialStep,
    validateTerrain,
    rejectTerrain,
    recruiterIdsForScope,
    findPendingForActor,
    loadActor,
};
