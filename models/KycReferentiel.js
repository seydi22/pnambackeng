const mongoose = require('mongoose');

const natureList = { type: [String], default: [] };

const categorieSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, trim: true },
        natures: natureList,
    },
    { _id: false }
);

const secteurSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, trim: true },
        categories: { type: [categorieSchema], default: [] },
    },
    { _id: false }
);

const kycReferentielSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, default: 'default' },
        secteurs: { type: [secteurSchema], default: [] },
    },
    { timestamps: true }
);

module.exports = mongoose.model('KycReferentiel', kycReferentielSchema);
