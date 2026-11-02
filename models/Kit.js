const mongoose = require('mongoose');

const kitSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, unique: true, trim: true },
        materielIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Materiel' }],
        eamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Eam', default: null },
        etat: { type: String, enum: ['pret', 'en_transit', 'affecte'], default: 'pret' },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Kit', kitSchema);
