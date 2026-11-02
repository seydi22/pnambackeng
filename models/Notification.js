const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
    {
        destinataireId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', required: true, index: true },
        sujet: { type: String, enum: ['correction', 'materiel'], default: 'correction' },
        merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', index: true },
        merchantNom: { type: String, trim: true },
        motif: { type: String, trim: true },
        lu: { type: Boolean, default: false, index: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Notification', notificationSchema);
