// backend/routes/merchantRoutes.js

const express = require('express');
const router = express.Router();
const Merchant = require('../models/Merchant');
const authMiddleware = require('../middleware/authMiddleware'); // Middleware pour protéger la route 
const roleMiddleware = require('../middleware/roleMiddleware'); // Importez le middleware
const Agent = require('../models/Agent'); // Ajoutez cette ligne pour importer le modèle Agent
const { createMerchantUpload } = require('../services/imageStorage');
const xlsx = require('xlsx'); // <--- Assurez-vous que cette ligne est bien présente !
const moment = require('moment');
const crypto = require('crypto');
const { REJETE_DEFINITIF, isMerchantLocked, STATUT_CREE } = require('../utils/merchantStatus');
const { cpsCreateTopOrg, cpsCreateOrgOperator, cpsQueryOrgOperatorInfo, cpsQueryCustomerInfo, todayYYYYMMDD } = require('../services/cpsSyncApi');
const { escapeRegex } = require('../utils/escapeRegex');
const { isFieldAgent, isFieldSupervisor } = require('../utils/roles');
const terrain = require('../services/terrainValidation');
const kyc = require('../services/kycReferentielService');
const { buildCommissionMatrix } = require('../services/commissionMatrix');
const geo = require('../services/geoReferentielService');
const notes = require('../services/notificationService');
const positions = require('../services/positionService');
const fraude = require('../services/fraudeService');
const delaiAlertes = require('../services/delaiAlerteService');

const ALLOWED_MERCHANT_SORT_FIELDS = new Set([
    'createdAt',
    'validatedAt',
    'nom',
    'statut',
    'contact',
    'shortCode',
    'region',
    'ville',
]);

function lockedEnrollmentResponse(res) {
    return res.status(403).json({
        msg: 'Cet enrôlement est rejeté définitivement et ne peut plus être modifié ni validé.',
    });
}

/** Supprime les XML CPS legacy (mots de passe) encore presents en base. */
async function scrubLegacyCpsXml(merchantId) {
    if (!merchantId) return;
    await Merchant.updateOne(
        { _id: merchantId },
        {
            $unset: {
                'cpsIntegration.createTopOrg.requestXml': 1,
                'cpsIntegration.createTopOrg.rawResponse': 1,
                'cpsIntegration.createOrgOperator.results.$[].requestXml': 1,
                'cpsIntegration.createOrgOperator.results.$[].rawResponse': 1,
            },
        }
    );
}

const upload = createMerchantUpload();

async function canAccessMerchant(user, merchant) {
    if (!user || !merchant) return false;
    if (user.role === 'admin' || user.role === 'backoffice') return true;

    const recruiterId = merchant.agentRecruteurId
        ? merchant.agentRecruteurId.toString()
        : null;

    if (isFieldAgent(user.role)) {
        return recruiterId === user.id;
    }

    if (isFieldSupervisor(user.role) || user.role === 'cam' || user.role === 'pam') {
        if (!recruiterId) return false;
        const actor = await terrain.loadActor(user.id);
        if (!actor) return false;
        const ids = await terrain.recruiterIdsForScope(actor);
        return ids.some((id) => id.toString() === recruiterId);
    }

    return false;
}

// @route   POST /api/merchants/createMerchant
// @desc    Enregistrer un nouveau marchand
// @access  Private (Agent/Superviseur)
router.post(
    '/createMerchant',
    authMiddleware,
    roleMiddleware(['agent', 'superviseur']),
    upload.fields([
        { name: 'pieceIdentiteRecto', maxCount: 1 },
        { name: 'pieceIdentiteVerso', maxCount: 1 },
        { name: 'photoPasseport', maxCount: 1 },
        { name: 'photoEnseigne', maxCount: 1 }
    ]),
    async (req, res) => {
        console.log('>>> Vercel Debug: /api/merchants/createMerchant route handler reached');
        const {
            nom, secteur, typeCommerce, region, ville, commune,
            nomGerant, prenomGerant, dateNaissanceGerant,
            lieuNaissanceGerant, numeroCompteMoov, adresse,
            contact, nif, rc, typePiece, longitude, latitude,
            operators // This should be a JSON string of the operators array
        } = req.body;

        const files = req.files || {};
        const pieceIdentiteRectoUrl = files.pieceIdentiteRecto ? files.pieceIdentiteRecto[0].path : null;
        const pieceIdentiteVersoUrl = files.pieceIdentiteVerso ? files.pieceIdentiteVerso[0].path : null;
        const photoPasseportUrl = files.photoPasseport ? files.photoPasseport[0].path : null;
        const photoEnseigneUrl = files.photoEnseigne ? files.photoEnseigne[0].path : null;

        if (!photoEnseigneUrl) {
            return res.status(400).json({ msg: 'La photo enseigne est obligatoire.' });
        }

        let parsedOperators = [];
        if (operators) {
            try {
                parsedOperators = JSON.parse(operators);
            } catch (error) {
                return res.status(400).json({ msg: "Le format des opérateurs est invalide." });
            }
        }

        if (!Array.isArray(parsedOperators) || parsedOperators.length === 0) {
            return res.status(400).json({ msg: "Au moins un opérateur est requis." });
        }

        const toOptionalNumber = (v) => {
            if (v === undefined || v === null || String(v).trim() === '') return undefined;
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
        };

        const cleanOptionalString = (v) => {
            if (v === undefined || v === null) return undefined;
            const s = String(v).trim();
            return s === '' ? undefined : s;
        };

        let lieu;
        try {
            lieu = await geo.assertActorLieu(req.user.id, region, ville, commune, req.body.localite);
        } catch (lieuErr) {
            return res.status(lieuErr.statusCode || 400).json({ msg: lieuErr.message });
        }

        try {
            const agent = await Agent.findById(req.user.id);
            const newMerchant = new Merchant({
                nom, secteur, typeCommerce,
                region: lieu.region,
                ville: lieu.ville,
                commune: lieu.commune,
                nomGerant, prenomGerant, dateNaissanceGerant,
                lieuNaissanceGerant, numeroCompteMoov, adresse,
                contact,
                nif: cleanOptionalString(nif),
                rc: cleanOptionalString(rc),
                longitude: toOptionalNumber(longitude),
                latitude: toOptionalNumber(latitude),
                pieceIdentite: {
                    type: typePiece,
                    cniRectoUrl: pieceIdentiteRectoUrl,
                    cniVersoUrl: pieceIdentiteVersoUrl,
                    passeportUrl: photoPasseportUrl
                },
                photoEnseigneUrl,
                agentRecruteurId: req.user.id,
                operators: parsedOperators,
                categorie: cleanOptionalString(req.body.categorie),
                taille: cleanOptionalString(req.body.taille),
                localite: lieu.localite,
            });

            try {
                const checked = await kyc.assertSelection(newMerchant);
                newMerchant.secteur = checked.secteur;
                newMerchant.categorie = checked.categorie;
                newMerchant.typeCommerce = checked.typeCommerce;
                newMerchant.taille = checked.taille;
                newMerchant.localite = checked.localite;
            } catch (kycErr) {
                return res.status(kycErr.statusCode || 400).json({ msg: kycErr.message });
            }

            if (agent) {
                await terrain.assignInitialStep(newMerchant, agent);
            }

            const merchant = await newMerchant.save();
            await positions.recordForUser(req.user.id, {
                latitude: merchant.latitude,
                longitude: merchant.longitude,
                action: 'enrolement',
                merchantId: merchant._id,
            });

            if (agent) {
                agent.performance.enrôlements += 1;
                await agent.save();
            }

            fraude.examiner(merchant._id);
            res.status(201).json(merchant);

        } catch (err) {
            console.error(err.message);
            // Handle unique constraint error for operators
            if (err.code === 11000) {
                const key = err.keyPattern ? Object.keys(err.keyPattern)[0] : '';
                if (key === 'contact') {
                    return res.status(400).json({ msg: 'Ce contact marchand existe déjà.' });
                }
                if (key === 'operators.nni') {
                    return res.status(400).json({ msg: 'Un opérateur avec ce NNI existe déjà.' });
                }
                if (key === 'operators.telephone') {
                    return res.status(400).json({ msg: 'Un opérateur avec ce téléphone existe déjà.' });
                }
                if (key === 'nif') {
                    return res.status(400).json({ msg: 'Ce NIF existe déjà.' });
                }
                if (key === 'rc') {
                    return res.status(400).json({ msg: 'Ce RC existe déjà.' });
                }
                return res.status(400).json({ msg: "Un opérateur avec ce NNI ou téléphone existe déjà." });
            }
            if (err.name === 'ValidationError') {
                return res.status(400).json({ msg: err.message });
            }
            if (err.name === 'CastError') {
                return res.status(400).json({ msg: `Valeur invalide pour le champ ${err.path}.` });
            }
            res.status(500).send('Erreur du serveur.');
        }
    }
);


router.get(
    '/export',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const { startDate, endDate } = req.query;
            let filter = { statut: 'cree' };

            if (startDate) {
                filter.createdAt = { ...filter.createdAt, $gte: new Date(startDate) };
            }
            if (endDate) {
                filter.createdAt = { ...filter.createdAt, $lte: new Date(endDate) };
            }

            const merchants = await Merchant.find(filter).lean();
            if (!merchants || merchants.length === 0) {
                return res.status(404).json({ msg: 'Aucun marchand créé à exporter.' });
            }

            const headers = [
                'ShortCode', 'OrganizationName', 'Country', 'Country Value', 'City', 'City Value',
                'Preferred Notification Channel', 'Preferred Notification Channel Value', 'Notification Receiving MSISDN',
                'Notification Receiving MSISDN Value', 'Preferred Notification Language', 'Preferred Notification Language Value',
                'Commercial Register', 'Commercial Register Value', 'NIF', 'NIF Value', 'Organization Type',
                'Organization Type Value', 'Contact Type', 'Contact Type Value', 'Contact First Name', 'Contact First Name Value',
                'Contact Second Name', 'Contact Second Name Value', 'Product', 'ChargeProfile', 'Purpose of the company ',
                'Purpose of the company Value'
            ];

            const exportData = merchants.map(m => ({
                'ShortCode': m.shortCode || '',
                'OrganizationName': m.nom || '',
                'Country': '[Address Details][Country]',
                'Country Value': 'MRT',
                'City': '[Address Details][City]',
                'City Value': m.ville || '',
                'Preferred Notification Channel': '[Contact Details][Preferred Notification Channel]',
                'Preferred Notification Channel Value': '1001',
                'Notification Receiving MSISDN': '[Contact Details][Notification Receiving MSISDN]',
                'Notification Receiving MSISDN Value': m.contact || '',
                'Preferred Notification Language': '[Contact Details][Preferred Notification Language]',
                'Preferred Notification Language Value': 'fr',
                'Commercial Register': '[Corporate Information][Commercial Register]',
                'Commercial Register Value': m.rc || '',
                'NIF': '[Corporate Information][NIF]',
                'NIF Value': m.nif || '',
                'Organization Type': '[Organization Type][Organization Type]',
                'Organization Type Value': 'MERCHANT',
                'Contact Type': '[Organization Contact Details][Contact Type]',
                'Contact Type Value': '02',
                'Contact First Name': '[Organization Contact Details][Contact First Name]',
                'Contact First Name Value': m.prenomGerant || '',
                'Contact Second Name': '[Organization Contact Details][Contact Second Name]',
                'Contact Second Name Value': m.nomGerant || "",
                'Product': '45071',
                'ChargeProfile': '55055',
                'Purpose of the company ': '[Corporate Information][Purpose of the company]',
                'Purpose of the company Value': '01'
            }));

            const XLSX = require('xlsx');
            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.json_to_sheet(exportData, { header: headers });
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Marchands');

            const date = moment().format('YYYYMMDD');
            const time = moment().format('HHmm');
            const uniqueID = crypto.randomBytes(3).toString('hex');
            const filename = `export_merchants_${date}_${time}_${uniqueID}.xlsx`;
            const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(buffer);

        } catch (error) {
            console.error('Erreur export marchands:', error);
            res.status(500).json({ msg: 'Erreur lors de l’export des marchands.' });
        }
    }
);


// @route   GET /api/merchants/all
// @desc    Obtenir la liste des marchands (filtrée + paginée pour l'admin)
// @access  Private (Admin)
router.get(
    '/all',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const { statut, search, agentId, sortBy, sortOrder } = req.query;

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
            const skip = (page - 1) * limit;

            // L'admin ne doit voir que les marchands qui ont passé l'étape superviseur
            // ou qui ont été créés dans le CPS (statut 'cree').
            const filter = {
                statut: { $in: ['validé_par_superviseur', 'cree', 'rejeté', 'livré', REJETE_DEFINITIF, 'validé'] }
            };

            // Si un statut est passé en query par l'admin, on s'assure qu'il est autorisé
            if (statut) {
                if (filter.statut.$in.includes(statut)) {
                    filter.statut = statut;
                } else {
                    // Si le statut demandé n'est pas autorisé pour un admin,
                    // on retourne un tableau vide pour ne pas exposer d'autres données.
                    return res.json({
                        merchants: [],
                        pagination: { page, limit, total: 0, totalPages: 0 },
                    });
                }
            }
            
            if (search) {
                const safeSearch = escapeRegex(search);
                filter.$or = [
                    { nom: { $regex: safeSearch, $options: 'i' } },
                    { nomGerant: { $regex: safeSearch, $options: 'i' } },
                    { contact: { $regex: safeSearch, $options: 'i' } },
                ];
            }

            if (agentId) {
                filter.agentRecruteurId = agentId;
            }

            let sort = { createdAt: -1 };
            if (sortBy && ALLOWED_MERCHANT_SORT_FIELDS.has(sortBy)) {
                sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
            }

            const [total, merchants] = await Promise.all([
                Merchant.countDocuments(filter),
                Merchant.find(filter)
                    .populate('agentRecruteurId', 'matricule nom prenom')
                    .sort(sort)
                    .skip(skip)
                    .limit(limit)
                    .select('-documents')
                    .lean(),
            ]);

            const merchantsForFrontEnd = merchants.map(merchant => ({
                ...merchant,
                displayName: merchant.shortCode ? `${merchant.shortCode} ${merchant.nom}` : merchant.nom,
                creationDate: merchant.createdAt,
            }));

            const totalPages = Math.ceil(total / limit) || 0;

            res.json({
                merchants: merchantsForFrontEnd,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                },
            });
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

router.get(
    '/alertes-delai',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            res.json(await delaiAlertes.list());
        } catch (err) {
            console.error(err.message);
            res.status(500).json({ msg: 'Erreur du serveur.' });
        }
    }
);

// Route pour obtenir les statistiques du tableau de bord
router.get(
    '/dashboard-stats',
    [authMiddleware, roleMiddleware(['superviseur', 'admin', 'cam', 'pam'])],
    async (req, res) => {
        try {
            let stats;
            let responsePayload = {};

            const formattedStats = {
                'en attente': 0,
                'validé_par_superviseur': 0,
                'cree': 0,
                'rejeté': 0,
                [REJETE_DEFINITIF]: 0,
                'livré': 0,
            };

            if (req.user.role === 'admin' || req.user.role === 'backoffice') {
                // Pour l'admin, agréger sur tous les marchands
                stats = await Merchant.aggregate([
                    { $group: { _id: '$statut', count: { $sum: 1 } } }
                ]);
                
                stats.forEach(s => {
                    const key = s._id === 'validé' ? 'cree' : s._id;
                    if (formattedStats.hasOwnProperty(key)) {
                        formattedStats[key] += s.count;
                    }
                });

                const totalMerchants = await Merchant.countDocuments();
                const totalAgents = await Agent.countDocuments();
                
                responsePayload = {
                    stats: {
                        ...formattedStats,
                        total: totalMerchants,
                    },
                    totalAgents: totalAgents
                };

            } else {
                const actor = await terrain.loadActor(req.user.id);
                const agentIds = actor ? await terrain.recruiterIdsForScope(actor) : [];

                stats = await Merchant.aggregate([
                    { $match: { agentRecruteurId: { $in: agentIds } } },
                    { $group: { _id: '$statut', count: { $sum: 1 } } }
                ]);

                stats.forEach(s => {
                    const key = s._id === 'validé' ? 'cree' : s._id;
                    if (formattedStats.hasOwnProperty(key)) {
                        formattedStats[key] += s.count;
                    }
                });

                const pendingFilter = actor ? await terrain.findPendingForActor(actor) : null;
                const pendingMerchants = pendingFilter
                    ? await Merchant.find(pendingFilter)
                        .populate('agentRecruteurId', 'matricule nom prenom')
                        .select('-__v')
                    : [];

                responsePayload = {
                    stats: formattedStats,
                    pendingMerchants: pendingMerchants,
                    teamCount: agentIds.length,
                };
            }

            res.json(responsePayload);

        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur');
        }
    }
);

// --- MODIFIED VALIDATION WORKFLOW ROUTES ---

// @route   POST /api/merchants/supervisor-validate/:id
// @desc    Pre-validate a merchant (supervisor)
// @access  Private (Superviseur)
router.post(
    '/supervisor-validate/:id',
    [authMiddleware, roleMiddleware(['superviseur', 'cam', 'pam'])],
    async (req, res) => {
        try {
            const merchant = await Merchant.findById(req.params.id);
            if (!merchant) {
                return res.status(404).json({ msg: 'Marchand non trouvé.' });
            }
            if (isMerchantLocked(merchant)) {
                return lockedEnrollmentResponse(res);
            }
            const actor = await terrain.loadActor(req.user.id);
            if (!actor || actor.actif === false) {
                return res.status(403).json({ msg: 'Compte desactive.' });
            }
            await terrain.validateTerrain(merchant, actor);
            let msg = 'Dossier validé par le superviseur. La validation finale est faite par le back-office.';
            if (merchant.statut === 'en attente' && merchant.validationEtape === 'cam') {
                msg = 'Validation enregistrée. Le dossier passe au CAM.';
            } else if (merchant.statut === 'en attente' && merchant.validationEtape === 'pam') {
                msg = 'Validation enregistrée. Le dossier passe au PAM.';
            } else if (merchant.statut === 'en attente' && merchant.validationEtape === 'sam') {
                msg = 'Validation enregistrée. Le dossier passe au SAM.';
            }
            res.json({ msg, merchant });
        } catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ msg: err.message });
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   POST /api/merchants/admin-validate/:id
// @desc    Finally validate a merchant (admin)
// @access  Private (Admin)
router.post(
    '/admin-validate/:id',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            // Récupération initiale
            let merchant = await Merchant.findById(req.params.id);
            if (!merchant) {
                return res.status(404).json({ msg: 'Marchand non trouvé.' });
            }
            if (isMerchantLocked(merchant)) {
                return lockedEnrollmentResponse(res);
            }
            if (merchant.statut === 'cree') {
                return res.json({ msg: 'Marchand déjà créé dans CPS.', merchant });
            }
            if (merchant.statut !== 'validé_par_superviseur') {
                return res.status(400).json({ msg: 'Le marchand n est pas en attente de validation finale.' });
            }

            // Matrice MSISDN au moment de l'envoi. Elle est stockee, pas injectee dans le SOAP.
            const commissionMatrix = await buildCommissionMatrix(merchant.agentRecruteurId);

            // Verrouillage atomique (anti double-clic / anti double requêtes concurrentes)
            // IMPORTANT: empêche la création de plusieurs TopOrg pour un même marchand.
            merchant = await Merchant.findOneAndUpdate(
                {
                    _id: req.params.id,
                    statut: 'validé_par_superviseur',
                    $or: [
                        { 'cpsIntegration.status': { $ne: 'in_progress' } },
                        { cpsIntegration: { $exists: false } },
                    ],
                },
                {
                    $set: {
                        'cpsIntegration.status': 'in_progress',
                        'cpsIntegration.lastAttemptAt': Date.now(),
                        'cpsIntegration.error': '',
                        commissionMatrix,
                    },
                },
                { new: true }
            );

            if (!merchant) {
                const current = await Merchant.findById(req.params.id);
                return res.status(409).json({
                    msg: 'Intégration CPS déjà en cours pour ce marchand. Réessayez dans quelques secondes.',
                    merchant: current,
                });
            }

            // === Pré-check (optionnel): QueryCustomerInfo sur MSISDN opérateur ===
            // Ancien workflow: rejeter si le numéro a déjà un compte Moov Money.
            // Nouveau workflow: si le numéro existe déjà, on créera l'opérateur SANS MSISDN
            // (mais en gardant Notification Receiving MSISDN), sinon on inclut le MSISDN.
            const CPS_URL = process.env.CPS_URL;
            const enableCustomerPrecheck = String(process.env.CPS_PRECHECK_CUSTOMERINFO || '').trim() === '1';
            const existingCustomerByMsisdn = {};
            if (CPS_URL && enableCustomerPrecheck) {
                const requiredForQueryCustomer = [
                    'CPS_THIRD_PARTY_ID',
                    'CPS_PASSWORD',
                    'CPS_INITIATOR_IDENTIFIER_TYPE',
                    'CPS_INITIATOR_IDENTIFIER',
                    'CPS_INITIATOR_SECURITY_CREDENTIAL',
                ];
                const missingForQuery = requiredForQueryCustomer.filter((k) => !process.env[k]);
                if (!missingForQuery.length) {
                    const queryCustomerUrl = process.env.CPS_CUSTOMERINFO_URL || CPS_URL;
                    const receiverIdType = process.env.CPS_QUERY_CUSTOMER_IDENTIFIER_TYPE || '1';
                    const operatorsToCheck = merchant.operators || [];

                    for (const op of operatorsToCheck) {
                        const msisdn = op.telephone;
                        if (!msisdn) continue;

                        const q = await cpsQueryCustomerInfo({
                            url: queryCustomerUrl,
                            payload: {
                                thirdPartyId: process.env.CPS_THIRD_PARTY_ID,
                                password: process.env.CPS_PASSWORD,
                                initiatorIdentifierType: process.env.CPS_INITIATOR_IDENTIFIER_TYPE,
                                initiatorIdentifier: process.env.CPS_INITIATOR_IDENTIFIER,
                                initiatorSecurityCredential: process.env.CPS_INITIATOR_SECURITY_CREDENTIAL,
                                receiverIdentifierType: receiverIdType,
                                receiverIdentifier: msisdn,
                            },
                        });

                        const code = String(q.resultCode || '');
                        const desc = String(q.resultDesc || '');
                        // Sur vos retours, un compte existant renvoie ResultCode=0 et QueryCustomerInfoResult.
                        const looksExisting =
                            code === '0' &&
                            /QueryCustomerInfoResult|CustomerBasicData|Registered Customer|PrimaryMSISDN/i.test(
                                q.responseXml || ''
                            );

                        if (looksExisting) {
                            existingCustomerByMsisdn[msisdn] = true;
                        } else {
                            existingCustomerByMsisdn[msisdn] = false;
                        }
                    }
                }
            }

            // ShortCode: générer UNE SEULE FOIS, puis ne plus changer.
            if (!merchant.shortCode) {
                const lastMerchant = await Merchant.findOne({ shortCode: { $exists: true } }).sort({ shortCode: -1 });
                let newShortCode = "003063";
                if (lastMerchant && lastMerchant.shortCode) {
                    const incremented = (parseInt(lastMerchant.shortCode, 10) + 1).toString().padStart(6, '0');
                    newShortCode = incremented;
                }
                merchant.shortCode = newShortCode;
            }

            // S’assure que tous les opérateurs ont le même ShortCode.
            merchant.operators.forEach((operator) => {
                operator.shortCode = merchant.shortCode;
            });

            // === Intégration CPS ===
            // Si la config CPS n'est pas définie, on garde l’ancien comportement (validation locale).
            if (!CPS_URL) {
                merchant.statut = STATUT_CREE;
                merchant.validatedAt = Date.now();
                merchant.rejectionReason = '';
                await merchant.save();
                await scrubLegacyCpsXml(merchant._id);

                if (merchant.agentRecruteurId) {
                    await Agent.findByIdAndUpdate(merchant.agentRecruteurId, { $inc: { 'performance.validations': 1 } });
                }

                return res.json({
                    msg: 'Marchand cree localement (CPS_URL non configuree).',
                    merchant,
                });
            }

            // cpsIntegration.status/lastAttemptAt/error sont déjà posés via le verrou atomique ci-dessus.

            const requiredEnv = [
                'CPS_THIRD_PARTY_ID',
                'CPS_PASSWORD',
                'CPS_INITIATOR_IDENTIFIER_TYPE',
                'CPS_INITIATOR_IDENTIFIER',
                'CPS_INITIATOR_SECURITY_CREDENTIAL',
                'CPS_RECEIVER_IDENTIFIER_TYPE',
                'CPS_RECEIVER_IDENTIFIER',
            ];
            const missing = requiredEnv.filter((k) => !process.env[k]);
            if (missing.length) {
                merchant.cpsIntegration.status = 'failed';
                merchant.cpsIntegration.error = `Variables d'environnement manquantes: ${missing.join(', ')}`;
                await merchant.save();
                await scrubLegacyCpsXml(merchant._id);
                return res.status(500).json({ msg: merchant.cpsIntegration.error, merchant });
            }

            // Mapping KYC (valeurs techniques validées dans Postman)
            const countryValue = process.env.CPS_COUNTRY_VALUE || 'MRT';
            const cityValue = merchant.ville;
            const nifValue = merchant.nif || '';
            const commercialRegisterValue = merchant.rc || '';
            // Valeurs fixes (référence: export marchands)
            const organizationTypeValue = process.env.CPS_ORG_TYPE_VALUE || 'MERCHANT';
            const contactTypeValue = process.env.CPS_CONTACT_TYPE_VALUE || '02';
            const contactFirstNameValue = merchant.prenomGerant || '';
            const preferredNotificationLanguage = process.env.CPS_PREFERRED_LANG || 'fr';
            const preferredNotificationChannel = process.env.CPS_PREFERRED_CHANNEL || '1001';
            const productId = process.env.CPS_PRODUCT_ID || '45071';
            const remark = process.env.CPS_REMARK || 'Enrollment Admin Final Validation';

            // 1) CreateTopOrg (idempotent): si déjà OK, on ne rejoue pas.
            const topOrgAlreadyOk = String(merchant.cpsIntegration?.createTopOrg?.resultCode) === '0';
            if (!topOrgAlreadyOk) {
                const topOrgResp = await cpsCreateTopOrg({
                    url: CPS_URL,
                    payload: {
                        thirdPartyId: process.env.CPS_THIRD_PARTY_ID,
                        password: process.env.CPS_PASSWORD,
                        initiatorIdentifierType: process.env.CPS_INITIATOR_IDENTIFIER_TYPE,
                        initiatorIdentifier: process.env.CPS_INITIATOR_IDENTIFIER,
                        initiatorSecurityCredential: process.env.CPS_INITIATOR_SECURITY_CREDENTIAL,
                        receiverIdentifierType: process.env.CPS_RECEIVER_IDENTIFIER_TYPE,
                        receiverIdentifier: process.env.CPS_RECEIVER_IDENTIFIER,
                        shortCode: merchant.shortCode,
                        organizationName: merchant.nom,
                        msisdn: merchant.contact,
                        productId,
                        preferredNotificationLanguage,
                        preferredNotificationChannel,
                        countryValue,
                        cityValue,
                        nifValue,
                        commercialRegisterValue,
                        organizationTypeValue,
                        contactTypeValue,
                        contactFirstNameValue,
                        remark,
                    },
                });

                merchant.cpsIntegration.createTopOrg = {
                    resultCode: topOrgResp.resultCode,
                    resultDesc: topOrgResp.resultDesc,
                    conversationId: topOrgResp.conversationId,
                    completedAt: Date.now(),
                };

                const topOrgCode = String(topOrgResp.resultCode || '');
                const topOrgDesc = String(topOrgResp.resultDesc || '');
                const alreadyExistsCodes = String(process.env.CPS_TOPORG_ALREADY_EXISTS_CODES || '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                const alreadyExistsByText =
                    /already\s*exist|already\s*exists|exist\s*already|duplicate|short\s*code|organization\s*already/i.test(
                        topOrgDesc
                    );
                const isAlreadyExists =
                    (alreadyExistsCodes.length > 0 && alreadyExistsCodes.includes(topOrgCode)) ||
                    (alreadyExistsCodes.length === 0 && alreadyExistsByText);

                // Si le TopOrg existe déjà côté CPS, on continue vers CreateOrgOperator
                // (idempotence / retry opérateur) au lieu de bloquer l'application.
                if (topOrgCode !== '0' && !isAlreadyExists) {
                    merchant.cpsIntegration.status = 'failed';
                    merchant.cpsIntegration.error = `CreateTopOrg échec: ${topOrgResp.resultCode || 'N/A'} ${topOrgResp.resultDesc || ''}`.trim();
                    await merchant.save();
                    await scrubLegacyCpsXml(merchant._id);
                    return res.status(502).json({ msg: merchant.cpsIntegration.error, merchant });
                }
                if (topOrgCode !== '0' && isAlreadyExists) {
                    merchant.cpsIntegration.error = '';
                }
            }

            // 2) CreateOrgOperator (pour chaque opérateur)
            // Valeurs fixes (référence: export opérateurs)
            const roleId = process.env.CPS_OPERATOR_ROLE_ID || '500000000000011413';
            // CPS refuse une EffectiveDate antérieure à la date courante (ex: TP40254).
            // Si une date est fournie dans .env mais qu'elle est dans le passé, on force à aujourd'hui.
            const roleEffectiveDate = (() => {
                const today = todayYYYYMMDD();
                const fromEnv = String(process.env.CPS_OPERATOR_ROLE_EFFECTIVE_DATE || '').trim();
                if (!fromEnv) return today;
                // Format attendu yyyyMMdd ; comparaison lexicographique OK.
                return fromEnv < today ? today : fromEnv;
            })();
            const roleExpiryDate = process.env.CPS_OPERATOR_ROLE_EXPIRY_DATE || '20990320';
            const authTypeEnv = (process.env.CPS_OPERATOR_AUTH_TYPE || 'HANDSET').trim();
            // CPS (SYNCAPI) attend souvent un code (ex: "02") même si l’UI affiche "HANDSET".
            const authenticationType =
                authTypeEnv.toUpperCase() === 'HANDSET' ? '02' : authTypeEnv;
            const operatorResults = [];
            let operatorHasNonZero = false;
            let operatorHasManual = false;

            for (const op of merchant.operators || []) {
                const operatorMsisdn = op.telephone;
                const operatorId = op.telephone;
                const idNumber = String(op.nni || '').trim();

                if (!/^\d+$/.test(idNumber)) {
                    const errMsg = `NNI opérateur invalide (doit être numérique): ${idNumber || 'N/A'}`;
                    merchant.cpsIntegration.status = 'failed';
                    merchant.cpsIntegration.error = errMsg;
                    await merchant.save();
                    await scrubLegacyCpsXml(merchant._id);
                    return res.status(400).json({ msg: errMsg, merchant });
                }

                // Idempotence opérateur: si déjà présent dans l’org, on skip CreateOrgOperator.
                const queryOperatorIdentifierType = process.env.CPS_QUERY_OPERATOR_IDENTIFIER_TYPE || '12';
                // Si on ne passe pas MSISDN au CPS (workflow prod), on query plutôt sur OperatorID.
                const querySource = process.env.CPS_QUERY_OPERATOR_IDENTIFIER_SOURCE || 'operatorId';
                const queryOperatorIdentifier = querySource === 'msisdn' ? operatorMsisdn : operatorId;

                const queryResp = await cpsQueryOrgOperatorInfo({
                    url: CPS_URL,
                    payload: {
                        thirdPartyId: process.env.CPS_THIRD_PARTY_ID,
                        password: process.env.CPS_PASSWORD,
                        initiatorIdentifierType: process.env.CPS_INITIATOR_IDENTIFIER_TYPE,
                        initiatorIdentifier: process.env.CPS_INITIATOR_IDENTIFIER,
                        initiatorSecurityCredential: process.env.CPS_INITIATOR_SECURITY_CREDENTIAL,
                        operatorIdentifierType: queryOperatorIdentifierType,
                        operatorIdentifier: queryOperatorIdentifier,
                        shortCode: merchant.shortCode,
                    },
                });

                const notFoundCodes = String(process.env.CPS_QUERY_OPERATOR_NOT_FOUND_CODES || '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                const queryCode = String(queryResp.resultCode || '');
                const queryDesc = String(queryResp.resultDesc || '');
                const looksNotFound = /not\s*exist|not\s*found|no\s*record/i.test(queryDesc);
                const operatorExists = queryCode === '0';

                if (operatorExists) {
                    operatorResults.push({
                        msisdn: operatorMsisdn,
                        operatorId,
                        resultCode: '0',
                        resultDesc: 'Operator already exists (QueryOrgOperatorInfo).',
                        conversationId: queryResp.conversationId,
                        completedAt: Date.now(),
                    });
                    continue;
                }

                // Si la requête Query échoue pour une raison autre que "not found", on stoppe.
                const isNotFound =
                    (notFoundCodes.length > 0 && notFoundCodes.includes(queryCode)) ||
                    (notFoundCodes.length === 0 && looksNotFound);
                if (!isNotFound && queryCode) {
                    merchant.cpsIntegration.createOrgOperator = { results: operatorResults };
                    merchant.cpsIntegration.status = 'failed';
                    merchant.cpsIntegration.error = `QueryOrgOperatorInfo échec (${queryOperatorIdentifier}): ${queryCode} ${queryDesc}`.trim();
                    await merchant.save();
                    await scrubLegacyCpsXml(merchant._id);
                    return res.status(502).json({ msg: merchant.cpsIntegration.error, merchant });
                }

                // Workflow simplifié:
                // si le MSISDN a déjà un compte Moov Money (pré-check), on ne crée pas l'opérateur via API.
                // Le marchand passe quand même en "cree" (TopOrg OK) et l'opérateur sera créé manuellement (export).
                const existingCustomer = existingCustomerByMsisdn[operatorMsisdn] === true;
                if (existingCustomer) {
                    operatorHasManual = true;
                    operatorResults.push({
                        msisdn: operatorMsisdn,
                        operatorId,
                        resultCode: 'MANUAL',
                        resultDesc: 'Operator creation skipped: MSISDN already has an existing Moov Money account. Create operator manually via export/SP Portal.',
                        conversationId: queryResp.conversationId,
                        completedAt: Date.now(),
                    });
                    continue;
                }

                const orgOpResp = await cpsCreateOrgOperator({
                    url: CPS_URL,
                    payload: {
                        thirdPartyId: process.env.CPS_THIRD_PARTY_ID,
                        password: process.env.CPS_PASSWORD,
                        initiatorIdentifierType: process.env.CPS_INITIATOR_IDENTIFIER_TYPE,
                        initiatorIdentifier: process.env.CPS_INITIATOR_IDENTIFIER,
                        initiatorSecurityCredential: process.env.CPS_INITIATOR_SECURITY_CREDENTIAL,
                        shortCode: merchant.shortCode,
                        languageCode: process.env.CPS_OPERATOR_LANGUAGE_CODE || 'en',
                        // IMPORTANT:
                        // Dans SP Portal, on peut créer un opérateur sans MSISDN (canal Web).
                        // Si on garde HANDSET/02 sans MSISDN, CPS tente d'ajouter un device et peut échouer (IC13200).
                        // => Quand MSISDN est omis, on bascule sur un authType alternatif (ex: WEB) configurable.
                        authenticationType: (() => {
                            const override = String(process.env.CPS_OPERATOR_INCLUDE_MSISDN || '').trim();
                            const msisdnOmitted =
                                override === '0' ||
                                (override !== '1' && existingCustomerByMsisdn[operatorMsisdn] === true);
                            if (!msisdnOmitted) return authenticationType;
                            const alt = String(process.env.CPS_OPERATOR_AUTH_TYPE_NO_MSISDN || '').trim() || '01';
                            return alt.toUpperCase() === 'HANDSET' ? '02' : alt;
                        })(),
                        // En prod, UserName peut devoir être vide (cf export opérateurs) ou un login non-MSISDN.
                        // Par défaut on laisse vide et on permet de forcer via .env.
                        // NOTE: en mode "sans MSISDN" (souvent Web), CPS attend fréquemment un UserName non vide.
                        // On met par défaut OperatorID, sauf si override via env.
                        userName: (() => {
                            const base = process.env.CPS_OPERATOR_USERNAME ?? '';
                            const override = String(process.env.CPS_OPERATOR_INCLUDE_MSISDN || '').trim();
                            const msisdnOmitted =
                                override === '0' ||
                                (override !== '1' && existingCustomerByMsisdn[operatorMsisdn] === true);
                            if (!msisdnOmitted) return base;
                            const noMsisdnUser = process.env.CPS_OPERATOR_USERNAME_NO_MSISDN;
                            if (noMsisdnUser !== undefined) return String(noMsisdnUser);
                            return operatorId;
                        })(),
                        operatorId,
                        // Stratégie MSISDN:
                        // - si le numéro a déjà un compte (precheck), on n'envoie PAS MSISDN (mais on garde notificationMsisdn).
                        // - sinon, on envoie MSISDN (comportement standard attendu par CPS quand auth=HANDSET/02).
                        // - override global possible: CPS_OPERATOR_INCLUDE_MSISDN=0 force l'omission, =1 force l'inclusion.
                        msisdn: (() => {
                            const override = String(process.env.CPS_OPERATOR_INCLUDE_MSISDN || '').trim();
                            if (override === '0') return '';
                            if (override === '1') return operatorMsisdn;
                            const exists = existingCustomerByMsisdn[operatorMsisdn];
                            return exists ? '' : operatorMsisdn;
                        })(),
                        roleId,
                        roleEffectiveDate,
                        roleExpiryDate,
                        firstName: op.prenom || '',
                        preferredNotificationChannel,
                        // Obligatoire: numéro pour recevoir les notifications (même si on n'envoie pas MSISDN).
                        notificationMsisdn: operatorMsisdn,
                        idTypeValue: process.env.CPS_OPERATOR_ID_TYPE || '01',
                        idNumber,
                        documentReceived: process.env.CPS_OPERATOR_DOCUMENT_RECEIVED || 'Y',
                    },
                });

                operatorResults.push({
                    msisdn: operatorMsisdn,
                    operatorId,
                    resultCode: orgOpResp.resultCode,
                    resultDesc: orgOpResp.resultDesc,
                    conversationId: orgOpResp.conversationId,
                    completedAt: Date.now(),
                });

                if (String(orgOpResp.resultCode) !== '0') {
                    // Workflow simplifié: on ne bloque plus le marchand si l'opérateur échoue.
                    // L'opérateur sera géré manuellement via export.
                    operatorHasNonZero = true;
                    continue;
                }
            }

            merchant.cpsIntegration.createOrgOperator = { results: operatorResults };
            // TopOrg a été créé (ou existait). Même si un opérateur échoue, le marchand peut passer "cree".
            // On garde la trace via resultCode != 0 ou MANUAL.
            merchant.cpsIntegration.status = 'success';
            merchant.cpsIntegration.error = operatorHasNonZero || operatorHasManual
                ? 'TopOrg OK. Certains opérateurs doivent être créés manuellement (export) ou ont échoué en création automatique.'
                : '';

            // === Finalisation workflow ===
            merchant.statut = STATUT_CREE;
            merchant.validatedAt = Date.now();
            merchant.rejectionReason = '';

            await merchant.save();
            await scrubLegacyCpsXml(merchant._id);

            if (merchant.agentRecruteurId) {
                await Agent.findByIdAndUpdate(merchant.agentRecruteurId, { $inc: { 'performance.validations': 1 } });
            }

            if (operatorHasNonZero || operatorHasManual) {
                return res.json({
                    msg: 'Top organisation créée. Un ou plusieurs opérateurs sont à créer manuellement (via export/SP Portal).',
                    merchant,
                });
            }
            return res.json({ msg: 'Marchand créé dans CPS avec succès.', merchant });
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   GET /api/merchants/supervisors/me/performance
// @desc    Get performance data for the logged-in supervisor
// @access  Private (Superviseur)
router.get(
    '/supervisors/me/performance',
    [authMiddleware, roleMiddleware(['superviseur'])],
    async (req, res) => {
        try {
            const supervisorId = req.user.id;

            // Get supervisor details
            const supervisor = await Agent.findById(supervisorId).select('nom matricule');

            if (!supervisor) {
                return res.status(404).json({ msg: 'Superviseur non trouvé.' });
            }

            // Get validation count
            const validationCount = await Merchant.countDocuments({
                validatedBySupervisor: supervisorId
            });

            const performanceData = {
                supervisorId: supervisor._id,
                supervisorName: supervisor.nom,
                supervisorMatricule: supervisor.matricule,
                validationCount: validationCount
            };

            res.json(performanceData);

        } catch (err) {
            console.error("Erreur lors de la récupération de la performance du superviseur:", err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// --- NEW SUPERVISOR PERFORMANCE ROUTE ---

// @route   GET /api/supervisors/performance
// @desc    Get a list of all supervisors with their validation counts
// @access  Private (Admin)
router.get(
    '/supervisors/performance',
    [authMiddleware, roleMiddleware(['admin','superviseur'])],
    async (req, res) => {
        try {
            const performanceData = await Merchant.aggregate([
                {
                    $match: {
                        validatedBySupervisor: { $exists: true, $ne: null }
                    }
                },
                {
                    $group: {
                        _id: '$validatedBySupervisor',
                        validationCount: { $sum: 1 }
                    }
                },
                {
                    $lookup: {
                        from: 'agents', // La collection des agents/superviseurs
                        localField: '_id',
                        foreignField: '_id',
                        as: 'supervisorDetails'
                    }
                },
                {
                    $unwind: '$supervisorDetails'
                },
                {
                    $project: {
                        _id: 0,
                        supervisorId: '$_id',
                        supervisorName: '$supervisorDetails.nom', // ou le champ approprié comme 'username'
                        supervisorMatricule: '$supervisorDetails.matricule',
                        validationCount: 1
                    }
                },
                {
                    $sort: {
                        validationCount: -1
                    }
                }
            ]);

            res.json(performanceData);

        } catch (err) {
            console.error("Erreur lors de la récupération de la performance des superviseurs:", err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);


// @route   POST /api/merchants/admin-reject/:id
// @desc    Reject a pre-validated merchant (admin)
// @access  Private (Admin)
router.post(
    '/admin-reject/:id',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const { rejectionReason } = req.body;
            if (!rejectionReason) {
                return res.status(400).json({ msg: 'La raison du rejet est requise.' });
            }

            const merchant = await Merchant.findById(req.params.id);
            if (!merchant) {
                return res.status(404).json({ msg: 'Marchand non trouvé.' });
            }
            if (isMerchantLocked(merchant)) {
                return lockedEnrollmentResponse(res);
            }
            if (merchant.statut !== 'validé_par_superviseur') {
                return res.status(400).json({ msg: 'Ce marchand n est pas en attente de validation finale.' });
            }

            merchant.statut = 'rejeté';
            merchant.rejectionReason = `Rejeté, à corriger : ${rejectionReason}`;
            merchant.set('validationEtape', undefined);
            await merchant.save();
            await notes.notifyCorrection(merchant);

            res.json({ msg: 'Dossier renvoyé à l\'agent pour correction.', merchant });
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   POST /api/merchants/admin-reject-definitive/:id
// @desc    Rejet définitif (admin) — l'enrôlement ne peut plus être modifié ni validé
// @access  Private (Admin)
router.post(
    '/admin-reject-definitive/:id',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const { rejectionReason } = req.body;
            if (!rejectionReason || !String(rejectionReason).trim()) {
                return res.status(400).json({ msg: 'La raison du rejet est requise.' });
            }

            const merchant = await Merchant.findById(req.params.id);
            if (!merchant) {
                return res.status(404).json({ msg: 'Marchand non trouvé.' });
            }
            if (isMerchantLocked(merchant)) {
                return res.status(400).json({ msg: 'Ce marchand est déjà rejeté définitivement.' });
            }

            const statutsAutorises = ['en attente', 'validé_par_superviseur', 'rejeté'];
            if (!statutsAutorises.includes(merchant.statut)) {
                return res.status(400).json({
                    msg: `Le rejet définitif n'est pas applicable pour le statut actuel : ${merchant.statut}.`,
                });
            }

            merchant.statut = REJETE_DEFINITIF;
            merchant.rejectionReason = `Rejet définitif (admin): ${rejectionReason.trim()}`;
            await merchant.save();

            res.json({ msg: 'Enrôlement rejeté définitivement.', merchant });
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   POST /api/merchants/reject/:id
// @desc    Reject a pending merchant (supervisor)
// @access  Private (Superviseur)
router.post(
    '/reject/:id',
    [authMiddleware, roleMiddleware(['superviseur', 'cam', 'pam'])],
    async (req, res) => {
        const { rejectionReason } = req.body;
        try {
            const merchant = await Merchant.findById(req.params.id);
            if (!merchant) {
                return res.status(404).json({ msg: 'Marchand non trouvé.' });
            }
            if (isMerchantLocked(merchant)) {
                return lockedEnrollmentResponse(res);
            }
            const actor = await terrain.loadActor(req.user.id);
            if (!actor || actor.actif === false) {
                return res.status(403).json({ msg: 'Compte desactive.' });
            }
            await terrain.rejectTerrain(merchant, actor, rejectionReason);
            res.json({ msg: 'Dossier renvoyé à l\'agent pour correction.', merchant });
        } catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ msg: err.message });
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// --- QUEUE AND LISTING ROUTES ---

// @route   GET /api/merchants/pending
// @desc    Get pending merchants for the logged-in supervisor
// @access  Private (Superviseur)
router.get(
    '/pending',
    [authMiddleware, roleMiddleware(['superviseur', 'cam', 'pam'])],
    async (req, res) => {
        try {
            const actor = await terrain.loadActor(req.user.id);
            const filter = actor ? await terrain.findPendingForActor(actor) : null;
            const pendingMerchants = filter
                ? await Merchant.find(filter).populate('agentRecruteurId', 'matricule nom prenom').select('-__v')
                : [];
            res.json(pendingMerchants);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur');
        }
    }
);

// @route   GET /api/merchants/pending-admin-validation
// @desc    Get merchants awaiting final admin validation
// @access  Private (Admin)
router.get(
    '/pending-admin-validation',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const merchants = await Merchant.find({ statut: 'validé_par_superviseur' })
                .populate('agentRecruteurId', 'matricule nom prenom');
            res.json(merchants);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

// @route   GET /api/merchants/by-agent/:agentId
// @desc    Get merchants for a specific agent
// @access  Private (Superviseur, Admin)
router.get(
    '/by-agent/:agentId',
    [authMiddleware, roleMiddleware(['superviseur', 'admin'])],
    async (req, res) => {
        try {
            const merchants = await Merchant.find({ agentRecruteurId: req.params.agentId }).select('-__v');
            if (merchants.length === 0) {
                return res.status(404).json({ msg: 'Aucun marchand trouvé pour cet agent.' });
            }
            res.json(merchants);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur');
        }
    }
);

// @route   GET /api/merchants/my-merchants
// @desc    Get merchants for the logged-in agent
// @access  Private (Agent)
router.get(
    '/my-merchants',
    [authMiddleware, roleMiddleware(['agent'])],
    async (req, res) => {
        try {
            const merchants = await Merchant.find({ agentRecruteurId: req.user.id }).select('-__v');
            if (merchants.length === 0) {
                return res.status(404).json({ msg: 'Aucun marchand trouvé pour cet agent.' });
            }
            res.json(merchants);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur');
        }
    }
);

// @route   GET /api/merchants/superviseur-merchants
// @desc    Marchands du perimetre : superviseur V1, SAM, CAM ou PAM
// @access  Private (Superviseur, SAM, CAM, PAM)
router.get(
    '/superviseur-merchants',
    [authMiddleware, roleMiddleware(['superviseur', 'cam', 'pam'])],
    async (req, res) => {
        try {
            const actor = await terrain.loadActor(req.user.id);
            const agentIds = actor ? await terrain.recruiterIdsForScope(actor) : [];

            const { statut, search } = req.query;
            const filter = { agentRecruteurId: { $in: agentIds } };

            if (statut && statut !== 'Tous') {
                if (statut === 'cree' || statut === 'validé') {
                    filter.statut = { $in: ['cree', 'validé'] };
                } else {
                    filter.statut = statut;
                }
            }
            if (search) {
                const searchRegex = new RegExp(escapeRegex(search), 'i');
                filter.$or = [
                    { nom: searchRegex },
                    { nomGerant: searchRegex },
                    { contact: searchRegex },
                ];
            }

            const merchants = await Merchant.find(filter).populate('agentRecruteurId', 'nom prenom matricule');
            res.json(merchants);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur');
        }
    }
);
// @route   GET /api/merchants/export-operators
// @desc    Exporter tous les opérateurs au format Excel
// @access  Private (Admin)
router.get(
    '/export-operators',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const { startDate, endDate } = req.query;
            let filter = {
                // Nouveau: exporter uniquement les opérateurs à créer manuellement
                // (ceux dont CreateOrgOperator a échoué / a été skip "MANUAL", alors que le marchand est déjà "cree").
                statut: 'cree',
                "operators.0": { "$exists": true },
                $or: [
                    { 'cpsIntegration.createOrgOperator.results': { $exists: false } },
                    { 'cpsIntegration.createOrgOperator.results.resultCode': { $ne: '0' } },
                ],
            };

            if (startDate) {
                filter.validatedAt = { ...filter.validatedAt, $gte: new Date(startDate) };
            }
            if (endDate) {
                filter.validatedAt = { ...filter.validatedAt, $lte: new Date(endDate) };
            }

            const merchants = await Merchant.find(filter).lean();

            if (!merchants || merchants.length === 0) {
                return res.status(404).json({ msg: 'Aucun opérateur à exporter.' });
            }

            const exportData = [];
            const headers = [
                'Notification Language', 'Organization ShortCode', 'AuthenticationType', 'UserName', 'OperatorID',
                'MSISDN', 'First Name', 'First Name Value', 'Middle Name', 'Middle Name Value', 'Last name',
                'Last name Value', 'Date of Birth', 'Date of Birth Value', 'ID 1 Type', 'ID 1 Type Value',
                'ID 1 Number', 'ID 1 Number Value', 'Preferred Notification Channel', 'Preferred Notification Channel Value',
                'Notification Receiving MSISDN', 'Notification Receiving MSISDN Value', 'Preferred Notification Language',
                'Preferred Notification Language Value', 'Role ID'
            ];

            merchants.forEach(merchant => {
                if (merchant.operators && merchant.operators.length > 0) {
                    merchant.operators.forEach(op => {
                        const results = merchant?.cpsIntegration?.createOrgOperator?.results || [];
                        const r = results.find((x) => x && (x.msisdn === op.telephone || x.operatorId === op.telephone));
                        const code = String(r?.resultCode || '');
                        // On n'exporte QUE ceux à traiter manuellement (MANUAL) ou échecs (code != 0).
                        // Si aucun résultat n'existe pour cet opérateur, on l'exporte aussi.
                        const shouldExport = !code || code !== '0';
                        if (!shouldExport) return;

                        exportData.push({
                            'Notification Language': 'fr',
                            'Organization ShortCode': merchant.shortCode || '',
                            'AuthenticationType': 'HANDSET',
                            'UserName': '',
                            'OperatorID': op.telephone || '' ,
                            'MSISDN': op.telephone || '',
                            'First Name': '[Personal Details][First Name]',
                            'First Name Value': op.prenom || '',
                            'Middle Name': '[Personal Details][Middle Name]',
                            'Middle Name Value': '',
                            'Last name': '[Personal Details][Last Name]',
                            'Last name Value': op.nom || '',
                            'Date of Birth': '[Personal Details][Date of Birth]',
                            'Date of Birth Value': '',
                            'ID 1 Type': '[ID Details][ID Type]',
                            'ID 1 Type Value': '01',
                            'ID 1 Number': '[ID Details][ID Number]',
                            'ID 1 Number Value': op.nni || '',
                            'Preferred Notification Channel': '[Contact Details][Preferred Notification Channel]',
                            'Preferred Notification Channel Value': '1001',
                            'Notification Receiving MSISDN': '[Contact Details][Notification Receiving MSISDN]',
                            'Notification Receiving MSISDN Value': op.telephone || '',
                            'Preferred Notification Language': '[Contact Details][Preferred Notification Language]',
                            'Preferred Notification Language Value': 'fr',
                            'Role ID': '500000000000011413'
                        });
                    });
                }
            });

            if (exportData.length === 0) {
                return res.status(404).json({ msg: 'Aucun opérateur à exporter.' });
            }

            const workbook = xlsx.utils.book_new();
            const worksheet = xlsx.utils.json_to_sheet(exportData, { header: headers });

            xlsx.utils.book_append_sheet(workbook, worksheet, 'Operateurs');

            const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Disposition', 'attachment; filename="operateurs_export.xlsx"');
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(buffer);

        } catch (error) {
            console.error('Erreur export opérateurs:', error);
            res.status(500).json({ msg: 'Erreur lors de l’export des opérateurs.' });
        }
    }
);
// @route   GET /api/merchants/localisation
// @desc    Recuperer les coordonnees GPS des marchands actifs (scope role)
// @access  Private (Admin, Superviseur)
router.get(
    '/localisation',
    authMiddleware,
    roleMiddleware(['admin', 'superviseur']),
    async (req, res) => {
    try {
        const filter = {
            statut: {
                $in: [
                    'en attente',
                    'validé_par_superviseur',
                    'cree',
                    'validé',
                    'rejeté',
                    'livré',
                    REJETE_DEFINITIF,
                ],
            },
            latitude: { $exists: true, $ne: null },
            longitude: { $exists: true, $ne: null },
        };

        if (isFieldSupervisor(req.user.role)) {
            const myAgents = await Agent.find({ superviseurId: req.user.id }).select('_id');
            filter.agentRecruteurId = { $in: myAgents.map((a) => a._id) };
        }

        const merchants = await Merchant.find(filter)
            .select('_id nom latitude longitude statut agentRecruteurId')
            .populate('agentRecruteurId', 'matricule');

        const locations = merchants.map(merchant => ({
            id: merchant._id,
            nom: merchant.nom,
            lat: merchant.latitude,
            lng: merchant.longitude,
            statut: merchant.statut,
            matricule: merchant.agentRecruteurId ? merchant.agentRecruteurId.matricule : 'N/A'
        }));

        res.json(locations);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Erreur du serveur.');
    }
});


// @route   GET /api/merchants/territoire
// @desc    Moughataa affectee au compte, et ses communes
// @access  Private
router.get(
    '/territoire',
    authMiddleware,
    roleMiddleware(['admin', 'superviseur', 'agent', 'cam', 'pam']),
    async (req, res) => {
        try {
            res.json(await geo.scopeForUser(req.user.id));
        } catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ msg: err.message });
            console.error(err.message);
            res.status(500).json({ msg: 'Erreur du serveur.' });
        }
    }
);

// @route   GET /api/merchants/kyc-referentiel
// @desc    Listes secteur / categorie / nature et tailles
// @access  Private
router.get(
    '/kyc-referentiel',
    authMiddleware,
    roleMiddleware(['admin', 'superviseur', 'agent', 'cam', 'pam']),
    async (req, res) => {
        try {
            const doc = await kyc.getReferentiel();
            res.json({ tailles: kyc.TAILLES, secteurs: doc.secteurs });
        } catch (err) {
            console.error(err.message);
            res.status(500).json({ msg: 'Erreur du serveur.' });
        }
    }
);

router.put(
    '/kyc-referentiel',
    [authMiddleware, roleMiddleware(['admin'])],
    async (req, res) => {
        try {
            const doc = await kyc.updateReferentiel(req.body && req.body.secteurs);
            res.json({ msg: 'Referentiel KYC mis a jour.', tailles: kyc.TAILLES, secteurs: doc.secteurs });
        } catch (err) {
            if (err.statusCode) return res.status(err.statusCode).json({ msg: err.message });
            console.error(err.message);
            res.status(500).json({ msg: 'Erreur du serveur.' });
        }
    }
);

// @route   GET /api/merchants/:id
// @desc    Get a single merchant's details (scoped)
// @access  Private
router.get(
    '/:id',
    authMiddleware,
    roleMiddleware(['admin', 'superviseur', 'agent', 'cam', 'pam']),
    async (req, res) => {
        try {
            const merchant = await Merchant.findById(req.params.id).select('-__v');
            if (!merchant) {
                return res.status(404).json({ msg: 'Marchand non trouvé.' });
            }

            const allowed = await canAccessMerchant(req.user, merchant);
            if (!allowed) {
                return res.status(403).json({ msg: 'Acces refuse a ce marchand.' });
            }

            res.json(merchant);
        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur');
        }
    }
);



// @route   PUT /api/merchants/:id
// @desc    Mettre à jour un marchand rejeté et le re-soumettre
// @access  Private (Agent)
router.put(
    '/:id',
    [authMiddleware, roleMiddleware(['agent'])],
    upload.fields([
        { name: 'pieceIdentiteRecto', maxCount: 1 },
        { name: 'pieceIdentiteVerso', maxCount: 1 },
        { name: 'photoPasseport', maxCount: 1 },
        { name: 'photoEnseigne', maxCount: 1 }
    ]),
    async (req, res) => {
        try {
            // Vérifier si des données ont été envoyées
            if ((!req.body || Object.keys(req.body).length === 0) && (!req.files || Object.keys(req.files).length === 0)) {
                return res.status(400).json({ msg: 'Aucune donnée de mise à jour fournie.' });
            }

            const merchant = await Merchant.findById(req.params.id);

            if (!merchant) {
                return res.status(404).json({ msg: 'Marchand non trouvé.' });
            }

            // Vérifier que l'agent qui modifie est bien l'agent recruteur
            if (merchant.agentRecruteurId.toString() !== req.user.id) {
                return res.status(403).json({ msg: 'Action non autorisée. Vous ne pouvez modifier que vos propres marchands.' });
            }

            if (isMerchantLocked(merchant)) {
                return res.status(403).json({
                    msg: 'Cet enrôlement est rejeté définitivement et ne peut plus être modifié.',
                });
            }

            // Seuls les marchands avec le statut "rejeté" peuvent être modifiés.
            if (merchant.statut !== 'rejeté') {
                return res.status(403).json({ msg: "Ce marchand ne peut pas être modifié car il n'est pas au statut rejeté." });
            }

            // Handle operators update
            if (req.body.operators && typeof req.body.operators === 'string') {
                try {
                    req.body.operators = JSON.parse(req.body.operators);
                } catch (error) {
                    return res.status(400).json({ msg: "Le format des opérateurs est invalide." });
                }
            }

            // Whitelist : pas de mass assignment sur statut / cps / ownership
            const allowedFields = [
                'nom', 'secteur', 'categorie', 'typeCommerce', 'taille',
                'region', 'ville', 'commune', 'localite', 'longitude', 'latitude',
                'nomGerant', 'prenomGerant', 'adresse', 'contact', 'nif', 'rc',
                'operators',
            ];
            for (const field of allowedFields) {
                if (Object.prototype.hasOwnProperty.call(req.body, field)) {
                    merchant[field] = req.body[field];
                }
            }

            let lieu;
            try {
                lieu = await geo.assertActorLieu(req.user.id, merchant.region, merchant.ville, merchant.commune, merchant.localite);
            } catch (lieuErr) {
                return res.status(lieuErr.statusCode || 400).json({ msg: lieuErr.message });
            }
            merchant.region = lieu.region;
            merchant.ville = lieu.ville;
            merchant.commune = lieu.commune;
            merchant.localite = lieu.localite;

            try {
                const checked = await kyc.assertSelection(merchant);
                merchant.secteur = checked.secteur;
                merchant.categorie = checked.categorie;
                merchant.typeCommerce = checked.typeCommerce;
                merchant.taille = checked.taille;
                merchant.localite = checked.localite;
            } catch (kycErr) {
                return res.status(kycErr.statusCode || 400).json({ msg: kycErr.message });
            }

            // Mettre à jour les images si de nouveaux fichiers sont uploadés
            if (req.files) {
                if (req.files['pieceIdentiteRecto']) {
                    merchant.pieceIdentite.cniRectoUrl = req.files['pieceIdentiteRecto'][0].path;
                }
                if (req.files['pieceIdentiteVerso']) {
                    merchant.pieceIdentite.cniVersoUrl = req.files['pieceIdentiteVerso'][0].path;
                }
                if (req.files['photoPasseport']) {
                    merchant.pieceIdentite.passeportUrl = req.files['photoPasseport'][0].path;
                }
                if (req.files['photoEnseigne']) {
                    merchant.photoEnseigneUrl = req.files['photoEnseigne'][0].path;
                }
            }
            
            // Mettre à jour le type de pièce si fourni
            if (req.body.typePiece) {
                merchant.pieceIdentite.type = req.body.typePiece;
            }

            // Mettre à jour les champs de suivi et le statut
            merchant.lastModifiedBy = req.user.id;
            merchant.lastModifiedAt = Date.now();
            const recruiter = await Agent.findById(merchant.agentRecruteurId);
            if (recruiter) {
                await terrain.assignInitialStep(merchant, recruiter);
            } else {
                merchant.statut = 'en attente';
                merchant.rejectionReason = null;
            }

            await merchant.save();
            await notes.markMerchantRead(merchant._id);
            await positions.recordForUser(req.user.id, {
                latitude: merchant.latitude,
                longitude: merchant.longitude,
                action: 'correction',
                merchantId: merchant._id,
            });

            fraude.examiner(merchant._id);
            res.json({ msg: 'Marchand mis à jour et re-soumis pour validation.' });

        } catch (err) {
            console.error(err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

const { deliverMerchant } = require('../controllers/merchantController');

// @route   POST /api/merchants/:id/deliver
// @desc    Confirm QR code delivery, upload photos, and update merchant status
// @access  Private/Agent
router.post(
    '/:id/deliver',
    authMiddleware,
    roleMiddleware(['agent']),
    upload.fields([
        { name: 'qrCodePhoto', maxCount: 1 },
        { name: 'paymentTestPhoto', maxCount: 1 },
    ]),
    deliverMerchant
);




module.exports = router;
