const Log = require('../models/Log');
const Agent = require('../models/Agent');
const Merchant = require('../models/Merchant');
const Pam = require('../models/Pam');
const Uam = require('../models/Uam');
const Eam = require('../models/Eam');
const KycReferentiel = require('../models/KycReferentiel');
const jwt = require('jsonwebtoken');
const onFinished = require('on-finished');

const ROLE_LABEL = {
    admin: 'Admin',
    aam: 'AAM',
    sam: 'SAM',
    cam: 'CAM',
    pam: 'PAM',
    agent: 'Agent',
    superviseur: 'Superviseur',
};

const STATUT_LABEL = {
    'en attente': 'En validation terrain',
    'validé_par_superviseur': 'Validé par superviseur',
    cree: 'Créé',
    'validé': 'Créé',
    'rejeté': 'À corriger',
    'livré': 'Livré',
    'rejeté_définitivement': 'Rejeté définitivement',
};

function clip(value, max) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeAction(method, path) {
    if (method === 'POST' && path === '/api/agents/login') return 'Connexion';
    if (method === 'POST' && (path === '/api/agents/register' || path === '/api/agents')) return 'Création de compte';
    if (method === 'PUT' && path === '/api/agents/change-password') return 'Changement de mot de passe';
    if (method === 'PUT' && path === '/api/agents/me/moov-msisdn') return 'Numéro Moov Money';
    if (method === 'PUT' && /^\/api\/agents\/[a-fA-F0-9]{24}$/.test(path)) return 'Mise à jour de compte';
    if (method === 'DELETE' && /^\/api\/agents\/[a-fA-F0-9]{24}$/.test(path)) return 'Suppression de compte';
    if (method === 'GET' && path === '/api/agents/export') return 'Export opérateurs';

    if (method === 'POST' && path === '/api/merchants/createMerchant') return 'Enrôlement';
    if (method === 'POST' && path.startsWith('/api/merchants/supervisor-validate/')) return 'Validation terrain';
    if (method === 'POST' && path.startsWith('/api/merchants/admin-validate/')) return 'Validation finale';
    if (method === 'POST' && path.startsWith('/api/merchants/admin-reject-definitive/')) return 'Rejet définitif';
    if (method === 'POST' && path.startsWith('/api/merchants/admin-reject/')) return 'Renvoi à corriger (back-office)';
    if (method === 'POST' && path.startsWith('/api/merchants/reject/')) return 'Renvoi à corriger (terrain)';
    if (method === 'POST' && /\/deliver$/.test(path) && path.startsWith('/api/merchants/')) return 'Livraison QR';
    if (method === 'PUT' && path === '/api/merchants/kyc-referentiel') return 'Référentiel KYC';
    if (method === 'PUT' && path === '/api/organization/territoire') return 'Référentiel géographique';
    if (method === 'POST' && path === '/api/tournees/debut') return 'Début de tournée';
    if (method === 'POST' && path === '/api/tournees/fin') return 'Fin de tournée';
    if (method === 'POST' && path === '/api/materiels') return 'Création de matériel';
    if (method === 'POST' && path === '/api/materiels/import') return 'Import de matériel';
    if (method === 'POST' && path === '/api/materiels/lot') return 'Affectation de matériel';
    if (method === 'POST' && path === '/api/materiels/restituer') return 'Restitution de matériel';
    if (method === 'POST' && path === '/api/materiels/reception-scan') return 'Réception d’un accessoire';
    if (method === 'POST' && /\/reception$/.test(path) && path.startsWith('/api/materiels/')) return 'Réception d’un appareil';
    if (method === 'POST' && /\/incident$/.test(path) && path.startsWith('/api/materiels/')) return 'Incident matériel';
    if (method === 'DELETE' && /^\/api\/materiels\/[a-fA-F0-9]{24}$/.test(path)) return 'Suppression de matériel';
    if (method === 'GET' && path === '/api/materiels/export') return 'Export matériel';
    if (method === 'POST' && /\/ecarter$/.test(path) && path.startsWith('/api/alertes-fraude/')) return 'Alerte anti-fraude écartée';
    if (method === 'POST' && path === '/api/portal-users') return 'Création d’un compte back-office';
    if (method === 'PUT' && path.startsWith('/api/portal-users/')) return 'Mise à jour d’un compte back-office';
    if (method === 'PUT' && /^\/api\/merchants\/[a-fA-F0-9]{24}$/.test(path)) return 'Correction du dossier';
    if (method === 'GET' && path === '/api/merchants/export') return 'Export marchands';
    if (method === 'GET' && path === '/api/merchants/export-operators') return 'Export opérateurs CPS';

    if (method === 'POST' && path === '/api/organization/pams') return 'Création PAM';
    if (method === 'PUT' && path.startsWith('/api/organization/pams/')) return 'Mise à jour PAM';
    if (method === 'POST' && path === '/api/organization/uams') return 'Création UAM';
    if (method === 'PUT' && path.startsWith('/api/organization/uams/')) return 'Mise à jour UAM';
    if (method === 'POST' && path === '/api/organization/eams') return 'Création EAM';
    if (method === 'PUT' && path.startsWith('/api/organization/eams/')) return 'Mise à jour EAM';
    if (method === 'POST' && path === '/api/organization/users') return 'Création de compte';
    if (method === 'PUT' && path.startsWith('/api/organization/users/')) return 'Mise à jour de compte';

    if (method === 'GET' && path.startsWith('/api/export/performance')) return 'Export performances';
    if (method === 'GET' && path.startsWith('/api/export/suivi')) return 'Export suivi';
    if (method === 'GET' && path.startsWith('/api/export/nearby')) return 'Export à proximité';
    if (method === 'PUT' && path === '/api/app/version') return 'Version de l’application';

    return null;
}

function idAfter(path, prefix) {
    const match = path.match(new RegExp(`^${prefix}([a-fA-F0-9]{24})(?:/|$)`));
    return match ? match[1] : null;
}

function merchantDetail(merchant) {
    if (!merchant) return '';
    const parts = [`Statut : ${STATUT_LABEL[merchant.statut] || merchant.statut || '—'}`];
    if (merchant.statut === 'en attente' && merchant.validationEtape) {
        parts.push(`Prochaine étape : ${String(merchant.validationEtape).toUpperCase()}`);
    }
    if (merchant.shortCode) parts.push(`Short code : ${merchant.shortCode}`);
    const cps = merchant.cpsIntegration || {};
    const code = cps.createTopOrg && cps.createTopOrg.resultCode;
    if (code) parts.push(`CPS : ${code}`);
    if (cps.status === 'failed' && cps.error) parts.push(clip(cps.error, 160));
    return parts.join(' · ');
}

async function loadMerchant(id) {
    if (!id) return null;
    return Merchant.findById(id).select('nom statut shortCode validationEtape cpsIntegration.status cpsIntegration.error cpsIntegration.createTopOrg.resultCode');
}

async function contextFor(method, path, status, req) {
    const merchantId = idAfter(path, '/api/merchants/supervisor-validate/')
        || idAfter(path, '/api/merchants/admin-validate/')
        || idAfter(path, '/api/merchants/admin-reject-definitive/')
        || idAfter(path, '/api/merchants/admin-reject/')
        || idAfter(path, '/api/merchants/reject/')
        || idAfter(path, '/api/merchants/');

    if (merchantId && path !== '/api/merchants/kyc-referentiel') {
        const merchant = await loadMerchant(merchantId);
        return {
            cible: merchant ? merchant.nom : '',
            cibleId: merchantId,
            detail: merchantDetail(merchant),
        };
    }

    if (method === 'POST' && path === '/api/merchants/createMerchant') {
        const nom = req.body && req.body.nom;
        let merchant = null;
        if (status < 400 && req.user && req.user.id) {
            const query = { agentRecruteurId: req.user.id };
            if (nom) query.nom = nom;
            merchant = await Merchant.findOne(query)
                .sort({ createdAt: -1 })
                .select('nom statut shortCode validationEtape cpsIntegration.status cpsIntegration.error cpsIntegration.createTopOrg.resultCode');
        }
        const lieu = [req.body && req.body.ville, req.body && req.body.secteur].filter(Boolean).join(' · ');
        return {
            cible: (merchant && merchant.nom) || clip(nom, 120),
            cibleId: merchant ? String(merchant._id) : '',
            detail: merchant ? merchantDetail(merchant) : lieu,
        };
    }

    if (method === 'PUT' && path === '/api/merchants/kyc-referentiel' && status < 400) {
        const doc = await KycReferentiel.findOne({ key: 'default' }).select('secteurs');
        const secteurs = doc && Array.isArray(doc.secteurs) ? doc.secteurs : [];
        const categories = secteurs.reduce((sum, secteur) => sum + ((secteur.categories || []).length), 0);
        return {
            cible: 'Listes du formulaire marchand',
            detail: `${secteurs.length} secteur${secteurs.length > 1 ? 's' : ''}, ${categories} catégorie${categories > 1 ? 's' : ''}`,
        };
    }

    const orgSpecs = [
        ['/api/organization/pams/', Pam],
        ['/api/organization/uams/', Uam],
        ['/api/organization/eams/', Eam],
    ];
    for (const [prefix, Model] of orgSpecs) {
        const id = idAfter(path, prefix);
        if (!id) continue;
        const doc = await Model.findById(id).select('nom actif zone');
        if (!doc) return { cibleId: id };
        const parts = [doc.actif === false ? 'Désactivé' : 'Actif'];
        if (doc.zone) parts.push(`Zone : ${doc.zone}`);
        return { cible: doc.nom, cibleId: id, detail: parts.join(' · ') };
    }

    if ((path === '/api/organization/pams' || path === '/api/organization/uams' || path === '/api/organization/eams') && method === 'POST') {
        const nom = clip(req.body && req.body.nom, 120);
        const holder = req.body && req.body.compte && req.body.compte.matricule
            ? `Compte : ${clip(req.body.compte.matricule, 40)}`
            : '';
        const zone = req.body && req.body.zone ? `Zone : ${req.body.zone}` : '';
        return { cible: nom, detail: [holder, zone].filter(Boolean).join(' · ') };
    }

    const userId = idAfter(path, '/api/organization/users/') || idAfter(path, '/api/agents/');
    if (userId && path !== '/api/agents/login') {
        const account = await Agent.findById(userId).select('matricule role nom prenom actif');
        if (!account) return { cibleId: userId };
        const name = [account.prenom, account.nom].filter(Boolean).join(' ');
        return {
            cible: name ? `${account.matricule} · ${name}` : account.matricule,
            cibleId: userId,
            detail: `${ROLE_LABEL[account.role] || account.role} · ${account.actif === false ? 'Désactivé' : 'Actif'}`,
        };
    }

    if (method === 'POST' && (path === '/api/organization/users' || path === '/api/agents' || path === '/api/agents/register')) {
        const matricule = clip(req.body && req.body.matricule, 40);
        const role = ROLE_LABEL[req.body && req.body.role] || '';
        return { cible: matricule, detail: role };
    }

    return {};
}

function extractTokenFromHeaders(headers) {
    if (headers['x-auth-token']) return headers['x-auth-token'];
    const authHeader = headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim();
    }
    return null;
}

function captureMessage(req, res) {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        if (body && typeof body === 'object' && typeof body.msg === 'string') {
            req.auditMessage = clip(body.msg, 240);
        }
        return originalJson(body);
    };
    const originalSend = res.send.bind(res);
    res.send = (body) => {
        if (!req.auditMessage && res.statusCode >= 400 && typeof body === 'string' && body.length < 300 && !body.trim().startsWith('{') && !body.trim().startsWith('[')) {
            req.auditMessage = clip(body, 240);
        }
        return originalSend(body);
    };
}

const logMiddleware = async (req, res, next) => {
    captureMessage(req, res);

    const requestPath = String(req.originalUrl || '').split('?')[0];
    const deletedUserId = req.method === 'DELETE' ? idAfter(requestPath, '/api/agents/') : null;
    if (deletedUserId) {
        try {
            const account = await Agent.findById(deletedUserId).select('matricule role nom prenom');
            if (account) {
                const name = [account.prenom, account.nom].filter(Boolean).join(' ');
                req.auditSnapshot = {
                    cible: name ? `${account.matricule} · ${name}` : account.matricule,
                    cibleId: deletedUserId,
                    detail: ROLE_LABEL[account.role] || account.role || '',
                };
            }
        } catch (ex) {
            // La suppression reste tracée par son identifiant.
        }
    }

    onFinished(res, async () => {
        try {
        const path = String(req.originalUrl || '').split('?')[0];
        const action = describeAction(req.method, path);
        if (!action) return;

        const status = res.statusCode;
        let matricule = 'Système';
        let role = '';
        let acteur = '';
        const token = extractTokenFromHeaders(req.headers);

        if (req.user && req.user.matricule) {
            matricule = req.user.matricule;
            role = req.user.role || '';
        } else if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                if (decoded && decoded.user) {
                    matricule = decoded.user.matricule || matricule;
                    role = decoded.user.role || '';
                    req.user = req.user || decoded.user;
                }
            } catch (ex) {
                // Jeton illisible : la trace reste rattachée au matricule connu.
            }
        }

        if (req.method === 'POST' && path === '/api/agents/login') {
            const attempted = req.body && req.body.matricule ? String(req.body.matricule).trim() : '';
            if (attempted) {
                matricule = attempted;
                try {
                    const account = await Agent.findOne({ matricule: attempted }).select('role nom prenom matricule');
                    if (account) {
                        role = account.role || role;
                        matricule = account.matricule;
                        acteur = [account.prenom, account.nom].filter(Boolean).join(' ');
                    }
                } catch (ex) {
                    // La connexion reste tracée même si la lecture du compte échoue.
                }
            }
        } else if (req.user && req.user.id) {
            try {
                const account = await Agent.findById(req.user.id).select('nom prenom role matricule');
                if (account) {
                    acteur = [account.prenom, account.nom].filter(Boolean).join(' ');
                    role = role || account.role || '';
                    matricule = account.matricule || matricule;
                }
            } catch (ex) {
                // Le matricule du jeton suffit.
            }
        }

        let cible = '';
        let cibleId = '';
        let detail = '';
        try {
            const extra = await contextFor(req.method, path, status, req);
            const snapshot = req.auditSnapshot || {};
            cible = extra.cible || snapshot.cible || '';
            cibleId = extra.cibleId || snapshot.cibleId || '';
            detail = extra.detail || snapshot.detail || '';
        } catch (ex) {
            const snapshot = req.auditSnapshot || {};
            cible = snapshot.cible || '';
            cibleId = snapshot.cibleId || '';
            detail = snapshot.detail || '';
        }

        if (status >= 400 && req.auditMessage) {
            detail = detail ? `${detail} · ${req.auditMessage}` : req.auditMessage;
        }
        detail = clip(detail, 400);

        try {
            await new Log({
                matricule,
                role,
                acteur,
                action,
                outcome: status >= 400 ? 'echec' : 'succes',
                statusCode: status,
                cible,
                cibleId,
                detail,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
            }).save();
        } catch (error) {
            console.error('Failed to save log:', error.message);
        }
        } catch (error) {
            console.error('Failed to write audit log:', error.message);
        }
    });

    next();
};

module.exports = logMiddleware;
