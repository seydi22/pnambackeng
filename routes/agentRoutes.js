// backend/routes/agentRoutes.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const Agent = require('../models/Agent');
const Merchant = require('../models/Merchant');
const authMiddleware = require('../middleware/authMiddleware');
const jwt = require('jsonwebtoken');
const roleMiddleware = require('../middleware/roleMiddleware');
const { check, validationResult } = require('express-validator');

const moment = require('moment');
const crypto = require('crypto');
const xlsx = require('xlsx');
const { STATUT_CREE } = require('../utils/merchantStatus');
const loginRateLimit = require('../middleware/loginRateLimit');
const { normalizeMoovMsisdn, isValidMoovMsisdn } = require('../utils/normalizeMsisdn');
const { isFieldSupervisor, FIELD_AGENT_ROLES } = require('../utils/roles');

const ROLES_AUTORISES = ['agent', 'superviseur', 'admin'];

function sanitizeAgent(agent) {
    const obj = agent.toObject ? agent.toObject() : { ...agent };
    delete obj.motDePasse;
    return obj;
}

// Route pour enregistrer un nouvel agent (accessible uniquement par l'admin)
router.post('/register', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
    const { matricule, motDePasse, role, affiliation, superviseurId, moovMoneyMsisdn } = req.body;

    if (!matricule || !motDePasse || !affiliation) {
        return res.status(400).json({ msg: 'matricule, motDePasse et affiliation sont requis.' });
    }

    if (!ROLES_AUTORISES.includes(role)) {
        return res.status(400).json({ msg: 'Role invalide.' });
    }

    let normalizedMsisdn;
    if (moovMoneyMsisdn != null && String(moovMoneyMsisdn).trim() !== '') {
        if (!isValidMoovMsisdn(moovMoneyMsisdn)) {
            return res.status(400).json({ msg: 'Numero Moov Money invalide : 8 chiffres commencant par 4.' });
        }
        normalizedMsisdn = normalizeMoovMsisdn(moovMoneyMsisdn);
        const taken = await Agent.findOne({ moovMoneyMsisdn: normalizedMsisdn });
        if (taken) {
            return res.status(400).json({ msg: 'Ce numero Moov Money est deja utilise.' });
        }
    }

    let agent = await Agent.findOne({ matricule });
    if (agent) {
        return res.status(400).json({ msg: 'L\'agent existe déjà' });
    }

    agent = new Agent({
        matricule,
        motDePasse,
        role,
        affiliation,
        superviseurId: role === 'agent' ? superviseurId : undefined,
        ...(normalizedMsisdn ? { moovMoneyMsisdn: normalizedMsisdn } : {}),
    });

    const salt = await bcrypt.genSalt(10);
    agent.motDePasse = await bcrypt.hash(motDePasse, salt);

    await agent.save();

    res.status(201).json({ msg: 'Agent enregistré avec succès', agent: sanitizeAgent(agent) });
});

router.post('/login', loginRateLimit, async (req, res) => {
    try {
        const { matricule, motDePasse } = req.body;

        if (!matricule || !motDePasse) {
            return res.status(400).json({ msg: 'Matricule et mot de passe requis.' });
        }

        const agent = await Agent.findOne({ matricule }).select('+motDePasse');

        if (!agent) {
            return res.status(401).json({ msg: 'Identifiants invalides.' });
        }

        const isMatch = await agent.matchPassword(motDePasse);

        if (!isMatch) {
            return res.status(401).json({ msg: 'Identifiants invalides.' });
        }

        if (agent.actif === false) {
            return res.status(403).json({ msg: 'Compte desactive.' });
        }

        if (!process.env.JWT_SECRET) {
            console.error('JWT_SECRET manquant');
            return res.status(500).json({ msg: 'Erreur du serveur.' });
        }

        if (agent.role === 'aam') {
            agent.sessionStamp = crypto.randomBytes(16).toString('hex');
            await agent.save();
        }

        const payload = {
            user: {
                id: agent.id,
                role: agent.role,
                affiliation: agent.affiliation,
                matricule: agent.matricule,
                ...(agent.role === 'aam' ? { sessionStamp: agent.sessionStamp } : {}),
            }
        };

        const expiresInSeconds = 3600;
        const expirationTime = Math.floor(Date.now() / 1000) + expiresInSeconds;

        jwt.sign(
            payload,
            process.env.JWT_SECRET,
            { expiresIn: expiresInSeconds },
            (err, token) => {
                if (err) {
                    console.error('Erreur JWT.sign:', err.message);
                    return res.status(500).json({ msg: 'Erreur du serveur.' });
                }

                res.json({
                    token,
                    agent: {
                        id: agent.id,
                        matricule: agent.matricule,
                        role: agent.role,
                        affiliation: agent.affiliation,
                        moovMoneyMsisdn: agent.moovMoneyMsisdn || null,
                        habilitations: agent.role === 'backoffice' ? (agent.habilitations || []) : [],
                    },
                    requiresMoovMsisdn: false,
                    expiresIn: expirationTime,
                });
            }
        );

    } catch (err) {
        console.error('Erreur login:', err.message);
        res.status(500).send('Erreur du serveur.');
    }
});
// Route pour obtenir la performance de tous les agents (réservée aux superviseurs et admins)
router.get(
    '/performance',
    authMiddleware,
    roleMiddleware(['superviseur', 'admin',]),
    async (req, res) => {
        // Sélectionne uniquement les champs matricule, role et performance
        const agentsPerformance = await Agent.find().select('matricule role performance');
        res.json(agentsPerformance);
    }
);

router.get(
    '/my-performance', // <-- Nouveau nom de route plus spécifique pour éviter les conflits
    authMiddleware,
    // Note : Le rôle 'agent' est suffisant car la requête concerne l'agent lui-même.
    roleMiddleware(['agent', 'superviseur', 'admin']),
    async (req, res) => {
        try {
            // Utiliser req.user.id pour trouver la performance de l'agent connecté
            const agent = await Agent.findById(req.user.id).select('matricule role performance');

            if (!agent) {
                return res.status(404).json({ msg: 'Agent non trouvé.' });
            }

            res.json(agent.performance); // Ne renvoie que l'objet de performance
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   GET /api/agents/all-performance
// @desc    Obtenir les statistiques de performance de tous les agents pour un superviseur
// @access  Private (Superviseur, Admin)
router.get(
    '/all-performance',
    authMiddleware,
    roleMiddleware(['superviseur']), // Accès uniquement aux superviseurs
    async (req, res) => {
        try {
            // Filtrer les agents par leur superviseurId
            const agentsPerformance = await Agent.find({ superviseurId: req.user.id }).select(
                'matricule role performance affiliation moovMoneyMsisdn'
            );

            if (!agentsPerformance) {
                return res.status(404).json({ msg: 'Aucun agent trouvé sous votre supervision.' });
            }

            res.json(agentsPerformance);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// --- NOUVELLES ROUTES POUR LE CRUD DES AGENTS ---

router.post(
    '/',
    [
        authMiddleware,
        roleMiddleware(['superviseur', 'admin']),
        check('matricule', 'Le matricule est requis').not().isEmpty(),
        check('motDePasse', 'Le mot de passe doit contenir au moins 6 caractères').isLength({ min: 6 })
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { matricule, motDePasse, affiliation, moovMoneyMsisdn } = req.body;

        try {
            let agent = await Agent.findOne({ matricule });
            if (agent) {
                return res.status(400).json({ msg: 'L\'agent existe déjà.' });
            }

            let normalizedMsisdn;
            if (moovMoneyMsisdn != null && String(moovMoneyMsisdn).trim() !== '') {
                if (!isValidMoovMsisdn(moovMoneyMsisdn)) {
                    return res.status(400).json({ msg: 'Numero Moov Money invalide : 8 chiffres commencant par 4.' });
                }
                normalizedMsisdn = normalizeMoovMsisdn(moovMoneyMsisdn);
                const taken = await Agent.findOne({ moovMoneyMsisdn: normalizedMsisdn });
                if (taken) {
                    return res.status(400).json({ msg: 'Ce numero Moov Money est deja utilise.' });
                }
            }

            let role;
            let superviseurId = null;

            if (isFieldSupervisor(req.user.role)) {
                // Un superviseur ou un SAM ne peut créer que des agents rattachés à lui.
                role = 'agent';
                superviseurId = req.user.id;
            } else {
                // Admin : agent ou superviseur uniquement (pas d'auto-promotion admin ici).
                role = req.body.role || 'agent';
                if (!['agent', 'superviseur'].includes(role)) {
                    return res.status(400).json({ msg: 'Role invalide. Roles autorises: agent, superviseur.' });
                }
                if (role === 'agent') {
                    if (!req.body.superviseurId) {
                        return res.status(400).json({ msg: 'superviseurId est requis pour creer un agent.' });
                    }
                    superviseurId = req.body.superviseurId;
                }
            }

            agent = new Agent({
                matricule,
                motDePasse,
                affiliation,
                role,
                superviseurId,
                ...(normalizedMsisdn ? { moovMoneyMsisdn: normalizedMsisdn } : {}),
            });

            const salt = await bcrypt.genSalt(10);
            agent.motDePasse = await bcrypt.hash(motDePasse, salt);

            await agent.save();
            res.json({ msg: 'Agent créé avec succès', agent: sanitizeAgent(agent) });
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);


// @route   PUT /api/agents/change-password
// @desc    Modifier le mot de passe de l\'agent connecté
// @access  Private
router.put('/change-password', authMiddleware, async (req, res) => {
    const { ancienMotDePasse, nouveauMotDePasse } = req.body;
    const agentId = req.user.id;

    try {
        const agent = await Agent.findById(agentId).select('+motDePasse');
        if (!agent) {
            return res.status(404).json({ msg: 'Agent non trouvé.' });
        }

        const isMatch = await agent.matchPassword(ancienMotDePasse);
        if (!isMatch) {
            return res.status(400).json({ msg: "L'ancien mot de passe est incorrect." });
        }

        const salt = await bcrypt.genSalt(10);
        agent.motDePasse = await bcrypt.hash(nouveauMotDePasse, salt);

        await agent.save();

        res.json({ msg: 'Mot de passe mis à jour avec succès.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Erreur du serveur.');
    }
});

// @route   PUT /api/agents/me/moov-msisdn
// @desc    Enregistrer / mettre a jour le numero Moov Money de l'agent connecte
// @access  Private (agent, superviseur)
router.put(
    '/me/moov-msisdn',
    authMiddleware,
    roleMiddleware(['agent', 'superviseur']),
    async (req, res) => {
        try {
            const { moovMoneyMsisdn } = req.body;
            if (!isValidMoovMsisdn(moovMoneyMsisdn)) {
                return res.status(400).json({ msg: 'Numero Moov Money invalide : 8 chiffres commencant par 4.' });
            }
            const normalized = normalizeMoovMsisdn(moovMoneyMsisdn);

            const taken = await Agent.findOne({
                moovMoneyMsisdn: normalized,
                _id: { $ne: req.user.id },
            });
            if (taken) {
                return res.status(400).json({ msg: 'Ce numero Moov Money est deja utilise.' });
            }

            const agent = await Agent.findById(req.user.id);
            if (!agent) {
                return res.status(404).json({ msg: 'Agent non trouve.' });
            }

            agent.moovMoneyMsisdn = normalized;
            await agent.save();

            res.json({
                msg: 'Numero Moov Money enregistre.',
                agent: sanitizeAgent(agent),
                requiresMoovMsisdn: false,
            });
        } catch (err) {
            console.error(err.message);
            if (err && err.code === 11000) {
                return res.status(400).json({ msg: 'Ce numero Moov Money est deja utilise.' });
            }
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   PUT /api/agents/:id
// @desc    Modifier un agent (uniquement par superviseur/admin)
// @access  Private
router.put(
    '/:id',
    [
        authMiddleware,
        roleMiddleware(['superviseur', 'admin'])
    ],
    async (req, res) => {
        const { motDePasse, role, moovMoneyMsisdn } = req.body;
        const agentId = req.params.id;

        try {
            let agent = await Agent.findById(agentId);
            if (!agent) {
                return res.status(404).json({ msg: 'Agent non trouvé.' });
            }

            if (isFieldSupervisor(req.user.role)) {
                if (!agent.superviseurId || agent.superviseurId.toString() !== req.user.id) {
                    return res.status(403).json({ msg: 'Acces refuse : vous ne pouvez modifier que vos agents.' });
                }
                if (role && role !== 'agent') {
                    return res.status(403).json({ msg: 'Acces refuse : vous ne pouvez pas changer le role.' });
                }
            } else if (role) {
                if (!['agent', 'superviseur'].includes(role)) {
                    return res.status(400).json({ msg: 'Role invalide.' });
                }
                agent.role = role;
            }

            if (motDePasse) {
                const salt = await bcrypt.genSalt(10);
                agent.motDePasse = await bcrypt.hash(motDePasse, salt);
            }

            if (moovMoneyMsisdn != null && String(moovMoneyMsisdn).trim() !== '') {
                if (!isValidMoovMsisdn(moovMoneyMsisdn)) {
                    return res.status(400).json({ msg: 'Numero Moov Money invalide : 8 chiffres commencant par 4.' });
                }
                const normalized = normalizeMoovMsisdn(moovMoneyMsisdn);
                const taken = await Agent.findOne({
                    moovMoneyMsisdn: normalized,
                    _id: { $ne: agent._id },
                });
                if (taken) {
                    return res.status(400).json({ msg: 'Ce numero Moov Money est deja utilise.' });
                }
                agent.moovMoneyMsisdn = normalized;
            }

            await agent.save();
            res.json({ msg: 'Agent mis à jour avec succès', agent: sanitizeAgent(agent) });
        } catch (err) {
            console.error(err.message);
            if (err && err.code === 11000) {
                return res.status(400).json({ msg: 'Ce numero Moov Money est deja utilise.' });
            }
            res.status(500).send('Erreur du serveur.');
        }
    }
);

router.get(
    '/all-supervisors',
    [authMiddleware, roleMiddleware(['admin','superviseur'])],
    async (req, res) => {
        try {
            const supervisors = await Agent.find({ role: 'superviseur' }).select('-motDePasse');
            res.json(supervisors);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   GET /api/agents/all-agents
// @desc    Obtenir la liste de tous les agents
// @access  Private (Admin)
router.get(
    '/all-agents',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const agents = await Agent.find({ role: { $in: FIELD_AGENT_ROLES } })
                .populate('superviseurId', 'matricule')
                .populate('eamId', 'nom')
                .select('-motDePasse');
            res.json(agents);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   DELETE /api/agents/:id
// @desc    Supprimer un agent (uniquement par superviseur/admin)
// @access  Private
router.delete(
    '/:id',
    [authMiddleware, roleMiddleware(['superviseur', 'admin'])],
    async (req, res) => {
        try {
            const agent = await Agent.findById(req.params.id);

            if (!agent) {
                return res.status(404).json({ msg: 'Agent non trouvé.' });
            }

            // Vérifier que le superviseur ne peut pas se supprimer
            if (agent._id.toString() === req.user.id) {
                return res.status(401).json({ msg: 'Vous ne pouvez pas supprimer votre propre compte.' });
            }

            // Le superviseur ne peut supprimer que ses propres agents
            if (isFieldSupervisor(req.user.role) && agent.superviseurId && agent.superviseurId.toString() !== req.user.id) {
                 return res.status(401).json({ msg: 'Non autorisé à supprimer cet agent.' });
            }
            
            await agent.deleteOne();
            res.json({ msg: 'Agent supprimé avec succès.' });
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// Route protégée pour récupérer les informations de l\'agent connecté
router.get('/me', authMiddleware, async (req, res) => {
    // req.user contient l\'objet décodé par le middleware
    const agent = await Agent.findById(req.user.id).select('-motDePasse');
    res.json(agent);
});


// @route   GET /api/agents/export
// @desc    Exporter tous les opérateurs au format Excel
// @access  Private (Admin, Superviseur)
router.get(
    '/export',
    [authMiddleware, roleMiddleware(['admin', 'superviseur'])],
    async (req, res) => {
        try {
            // 1. Recuperer les marchands crees qui ont au moins un operateur
            const merchants = await Merchant.find({
                statut: STATUT_CREE,
                "operators.0": { "$exists": true }
            }).lean();

            if (!merchants || merchants.length === 0) {
                return res.status(404).json({ msg: 'Aucun opérateur à exporter.' });
            }

            // 2. Préparer les données pour l\'export
            const exportData = [];
            const headers = [
                'Notification Language', 'Organization ShortCode', 'AuthenticationType', 'UserName', 'OperatorID',
                'MSISDN', 'First Name', 'First Name Value', 'Middle Name', 'Middle Name Value', 'Last name',
                'Last name Value', 'Date of Birth', 'Date of Birth Value', 'id1 type', 'id1 type value',
                'ID 1 Number', 'ID 1 Number Value', 'Preferred Notification Channel', 'Preferred Notification Channel Value',
                'Notification Receiving MSISDN', 'Notification Receiving MSISDN Value', 'Preferred Notification Language',
                'Preferred Notification Language Value', 'Role ID'
            ];

            merchants.forEach(merchant => {
                if (merchant.operators && merchant.operators.length > 0) {
                    merchant.operators.forEach(op => {
                        exportData.push({
                            'Notification Language': 'fr',
                            'Organization ShortCode': merchant.shortCode || '',
                            'AuthenticationType': 'WEB',
                            'UserName': '',
                            'OperatorID': '',
                            'MSISDN': op.telephone || '',
                            'First Name': '[Personal Details][First Name]',
                            'First Name Value': op.prenom || '',
                            'Middle Name': '[Personal Details][Middle Name]',
                            'Middle Name Value': '',
                            'Last name': '[Personal Details][Last Name]',
                            'Last name Value': op.nom || '',
                            'Date of Birth': '[Personal Details][Date of Birth]',
                            'Date of Birth Value': '',
                            'id1 type': '[ID Details][ID Type]',
                            'id1 type value': '01',
                            'ID 1 Number': '[ID Details][ID Number]',
                            'ID 1 Number Value': op.nni || '',
                            'Preferred Notification Channel': '[Contact Details][Preferred Notification Channel]',
                            'Preferred Notification Channel Value': '1001',
                            'Notification Receiving MSISDN': '[Contact Details][Notification Receiving MSISDN]',
                            'Notification Receiving MSISDN Value': op.telephone ? `222${op.telephone}` : '',
                            'Preferred Notification Language': '[Contact Details][Preferred Notification Language]',
                            'Preferred Notification Language Value': 'fr',
                            'Role ID': '500000000000011509'
                        });
                    });
                }
            });

            if (exportData.length === 0) {
                return res.status(404).json({ msg: 'Aucun opérateur à exporter.' });
            }

            // 3. Création du fichier Excel
            const workbook = xlsx.utils.book_new();
            const worksheet = xlsx.utils.json_to_sheet(exportData, { header: headers, skipHeader: true });
             // Ajouter les en-têtes manuellement à la première ligne
            xlsx.utils.sheet_add_aoa(worksheet, [headers], { origin: 'A1' });

            xlsx.utils.book_append_sheet(workbook, worksheet, 'Operateurs');

            // 4. Envoi du fichier au client
            const date = moment().format('YYYYMMDD');
            const time = moment().format('HHmm');
            const uniqueID = crypto.randomBytes(3).toString('hex');
            const filename = `export_operateurs_${date}_${time}_${uniqueID}.xlsx`;
            const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(buffer);

        } catch (error) {
            console.error('Erreur export opérateurs:', error);
            res.status(500).json({ msg: 'Erreur lors de l’export des opérateurs.' });
        }
    });
module.exports = router;
