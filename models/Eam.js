const mongoose = require('mongoose');

const eamSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, trim: true },
        commune: { type: String, trim: true },
        pamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pam', index: true },
        samId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', index: true },
        /** Ancien rattachement. Les nouvelles EAM passent par pamId et samId. */
        uamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Uam', index: true },
        /**
         * Deux membres de terrain. Leur MSISDN part dans la matrice (aam1, aam2).
         * Le compte de connexion de l'equipe reste unique et distinct.
         */
        membres: {
            type: [{
                nom: { type: String, trim: true },
                prenom: { type: String, trim: true },
                nni: { type: String, trim: true },
                msisdn: { type: String, trim: true },
            }],
            default: undefined,
        },
        actif: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Eam', eamSchema);
