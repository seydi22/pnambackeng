const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Schema = mongoose.Schema;

const agentSchema = new mongoose.Schema({
    matricule: { type: String, required: true, unique: true },
    motDePasse: { type: String, required: true, select: false },
    nom: { type: String, trim: true },
    prenom: { type: String, trim: true },
    /** NNI obligatoire pour les comptes V2. Sparse : les comptes V1 n'en ont pas encore. */
    nni: { type: String, trim: true, sparse: true, unique: true },
    /** MSISDN wallet Moov Money (rémunération commission). Sparse = agents legacy sans numéro. */
    moovMoneyMsisdn: {
        type: String,
        sparse: true,
        unique: true,
        trim: true,
    },
    /** false = compte desactive, la connexion est refusee. Absent = actif (comptes V1). */
    actif: { type: Boolean, default: true },
    role: {
        type: String,
        enum: ['agent', 'superviseur', 'admin', 'pam', 'cam', 'sam', 'aam', 'backoffice', 'logisticien'],
        default: 'agent',
    },
    pamId: { type: Schema.Types.ObjectId, ref: 'Pam' },
    uamId: { type: Schema.Types.ObjectId, ref: 'Uam', index: true },
    eamId: { type: Schema.Types.ObjectId, ref: 'Eam', index: true },
    affiliation: { type: String, required: true },
    /** Ecrans du portail ouverts pour un compte back-office. L'admin central les a tous. */
    habilitations: [{ type: String }],
    performance: {
        enrôlements: { type: Number, default: 0 },
        validations: { type: Number, default: 0 },
    },
    superviseurId: {
        type: Schema.Types.ObjectId,
        ref: 'Agent',
        required: function () {
            return this.role === 'agent';
        },
    },
    /** Identifiant de la session active du compte equipe. Une nouvelle connexion remplace la precedente. */
    sessionStamp: { type: String },
    dateCreation: {
        type: Date,
        default: Date.now,
    },
});

agentSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.motDePasse);
};

module.exports = mongoose.model('Agent', agentSchema);
