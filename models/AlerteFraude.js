const mongoose = require('mongoose');

const alerteSchema = new mongoose.Schema(
    {
        merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
        autreMerchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
        kind: { type: String, enum: ['enseigne', 'piece'], required: true },
        score: { type: Number, required: true },
        statut: { type: String, enum: ['ouverte', 'ecartee'], default: 'ouverte' },
        bitsA: { type: String, default: '' },
        bitsB: { type: String, default: '' },
        ecarteeAt: { type: Date, default: null },
    },
    { timestamps: true }
);

alerteSchema.index({ merchantId: 1, autreMerchantId: 1, kind: 1 }, { unique: true });
alerteSchema.index({ statut: 1, score: -1 });

module.exports = mongoose.model('AlerteFraude', alerteSchema);
