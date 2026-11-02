const mongoose = require('mongoose');

const tourneeSchema = new mongoose.Schema(
    {
        eamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Eam', required: true, index: true },
        agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', required: true },
        debut: { type: Date, required: true },
        fin: { type: Date, default: null },
    },
    { timestamps: true }
);

tourneeSchema.index({ eamId: 1, fin: 1 });

module.exports = mongoose.model('Tournee', tourneeSchema);
