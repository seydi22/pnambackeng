const mongoose = require('mongoose');

const positionSchema = new mongoose.Schema(
    {
        eamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Eam', required: true, index: true },
        agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', required: true },
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true },
        action: {
            type: String,
            enum: ['debut_tournee', 'fin_tournee', 'enrolement', 'correction', 'suivi'],
            required: true,
        },
        merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' },
    },
    { timestamps: true }
);

positionSchema.index({ createdAt: 1, eamId: 1 });

module.exports = mongoose.model('PositionEquipe', positionSchema);
