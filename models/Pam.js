const mongoose = require('mongoose');

const pamSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, trim: true },
        zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone', default: null },
        region: { type: String, trim: true, index: true },
        moughataa: { type: String, trim: true, index: true },
        actif: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Pam', pamSchema);
