const mongoose = require('mongoose');

const empreinteSchema = new mongoose.Schema(
    {
        merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
        kind: { type: String, enum: ['enseigne', 'piece', 'portrait'], required: true },
        url: { type: String, required: true },
        bits: { type: String, required: true },
    },
    { timestamps: true }
);

empreinteSchema.index({ merchantId: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('EmpreinteImage', empreinteSchema);
