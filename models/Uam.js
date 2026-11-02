const mongoose = require('mongoose');

const uamSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, trim: true },
        /** Affectation geographique libre. Le referentiel a 4 niveaux arrive en phase 3. */
        zone: { type: String, trim: true, default: '' },
        pamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pam', required: true, index: true },
        camId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', unique: true, sparse: true },
        actif: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Uam', uamSchema);
