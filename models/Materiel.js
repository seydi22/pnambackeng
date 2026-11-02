const mongoose = require('mongoose');

const materielSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, unique: true, trim: true },
        marque: { type: String, default: '', trim: true },
        modele: { type: String, default: '', trim: true },
        designation: { type: String, required: true, trim: true },
        type: { type: String, enum: ['maitre', 'tiers'], default: 'tiers' },
        etat: {
            type: String,
            enum: ['en_stock', 'en_transit', 'affecte', 'incident', 'en_reparation', 'rebut'],
            default: 'en_stock',
        },
        incidentMotif: { type: String, enum: ['perdu', 'vole', 'defectueux', null], default: null },
        eamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Eam', default: null },
        affecteAt: { type: Date, default: null },
        recuAt: { type: Date, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Materiel', materielSchema);
