// backend/models/Merchant.js

const mongoose = require('mongoose');

const commissionSlotSchema = new mongoose.Schema({
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
    role: { type: String },
    nom: { type: String },
    prenom: { type: String },
    nni: { type: String },
    msisdn: { type: String },
}, { _id: false });

const operatorSchema = new mongoose.Schema({
    nom: { type: String, required: true },
    prenom: { type: String, required: true },
    nni: { type: String, required: true, unique: true },
    telephone: { type: String, required: true, unique: true },
   
    shortCode: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const merchantSchema = new mongoose.Schema({
    nom: { type: String, required: true },
    secteur: { type: String, required: true },
    /** Categorie du referentiel KYC, entre secteur et nature. */
    categorie: { type: String, trim: true },
    typeCommerce: { type: String, required: true },
    /** Gros, Moyen ou Petit. Absent sur les dossiers crees avant la phase 3. */
    taille: { type: String, enum: ['Gros', 'Moyen', 'Petit'] },
    
    // Nouveaux champs de localisation
    region: { type: String, required: true },
    /** Moughataa. Le nom de champ reste ville pour les dossiers et l'export CPS existants. */
    ville: { type: String, required: true },
    commune: { type: String, required: true },
    localite: { type: String, trim: true },
    longitude: { type: Number },
    latitude: { type: Number },

    // Nouveaux champs pour les informations du gérant
    nomGerant: { type: String, required: true },
    prenomGerant: { type: String, required: true },
    adresse: { type: String, required: true },
    contact: { type: String, required: true, unique: true },
    nif: { type: String,  sparse: true },
    rc: { type: String,  sparse: true },
    
    // Structure de la pièce d'identité plus flexible
    pieceIdentite: {
        type: { type: String, enum: ['cni', 'carte de sejour', 'passeport'] },
        cniRectoUrl: { type: String },
        cniVersoUrl: { type: String },
        passeportUrl: { type: String }
    },
    photoEnseigneUrl: { type: String, required: true },

    // 'validé' conserve pour documents historiques ; le flux actuel passe directement a 'cree'.
    statut: {
        type: String,
        enum: ['en attente', 'validé_par_superviseur', 'validé', 'cree', 'rejeté', 'rejeté_définitivement', 'livré'],
        default: 'en attente',
    },
    agentRecruteurId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
    createdAt: { type: Date, default: Date.now },
    validatedAt: { type: Date },
    rejectionReason: { type: String },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
    lastModifiedAt: { type: Date },
    shortCode: { type: String, unique: true, sparse: true },

    /**
     * Etape courante de la validation terrain.
     * sam → cam → pam, les niveaux sans titulaire sont sautes.
     * admin = terrain termine, file de validation finale.
     * Absent sur un dossier "en attente" historique = etape SAM (circuit V1).
     */
    validationEtape: {
        type: String,
        enum: ['sam', 'cam', 'pam', 'admin'],
    },
    validationHistorique: [{
        etape: { type: String },
        agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
        action: { type: String, enum: ['soumis', 'valide', 'rejete'] },
        at: { type: Date, default: Date.now },
    }],

    // NOUVEAUX CHAMPS POUR LE SUIVI SUPERVISEUR
    validatedBySupervisor: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
    validatedBySupervisorAt: { type: Date },

    // NOUVEAUX CHAMPS POUR LA LIVRAISON
    qrCodePhotoUrl: { type: String },
    paymentTestPhotoUrl: { type: String },
    deliveredAt: { type: Date },
    deliveredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },

    /**
     * Matrice MSISDN prete a partir vers Moov (membre 1, membre 2, SAM, CAM, PAM).
     * Figee a l'arrivee en validation finale, rafraichie au moment de l'appel CPS.
     * Non injectee dans CreateTopOrg tant que Moov n'a pas nomme les champs.
     */
    commissionMatrix: {
        capturedAt: { type: Date },
        aam1: commissionSlotSchema,
        aam2: commissionSlotSchema,
        sam: commissionSlotSchema,
        cam: commissionSlotSchema,
        pam: commissionSlotSchema,
    },

    /**
     * Remuneration agent (commission promotionnelle CPS) — une seule fois par marchand.
     */
    remuneration: {
        status: {
            type: String,
            enum: ['none', 'eligible', 'paid', 'failed'],
            default: 'none',
        },
        amount: { type: Number },
        paidAt: { type: Date },
        paidForMonth: { type: String }, // 'YYYY-MM'
        conversationId: { type: String },
        transactionId: { type: String },
        lastError: { type: String },
    },

    // Tableau pour stocker les opérateurs liés à ce marchand
    operators: [operatorSchema],

    /**
     * Suivi d’intégration CPS (Huawei SYNCAPI).
     * On garde volontairement un format souple: utile pour debug sans casser le workflow.
     */
    cpsIntegration: {
        status: { type: String, enum: ['idle', 'in_progress', 'success', 'failed'], default: 'idle' },
        lastAttemptAt: { type: Date },
        error: { type: String },
        createTopOrg: {
            resultCode: { type: String },
            resultDesc: { type: String },
            conversationId: { type: String },
            // Legacy only — never select / never write secrets going forward
            requestXml: { type: String, select: false },
            rawResponse: { type: String, select: false },
            completedAt: { type: Date },
        },
        createOrgOperator: {
            results: [{
                msisdn: { type: String },
                operatorId: { type: String },
                resultCode: { type: String },
                resultDesc: { type: String },
                conversationId: { type: String },
                requestXml: { type: String, select: false },
                rawResponse: { type: String, select: false },
                completedAt: { type: Date },
            }],
        },
    },
});

function stripCpsXmlFields(ret) {
    if (!ret || !ret.cpsIntegration) return ret;
    if (ret.cpsIntegration.createTopOrg) {
        delete ret.cpsIntegration.createTopOrg.requestXml;
        delete ret.cpsIntegration.createTopOrg.rawResponse;
    }
    const results = ret.cpsIntegration.createOrgOperator && ret.cpsIntegration.createOrgOperator.results;
    if (Array.isArray(results)) {
        results.forEach((r) => {
            if (!r) return;
            delete r.requestXml;
            delete r.rawResponse;
        });
    }
    return ret;
}

merchantSchema.set('toJSON', {
    transform(_doc, ret) {
        return stripCpsXmlFields(ret);
    },
});
merchantSchema.set('toObject', {
    transform(_doc, ret) {
        return stripCpsXmlFields(ret);
    },
});

module.exports = mongoose.model('Merchant', merchantSchema);