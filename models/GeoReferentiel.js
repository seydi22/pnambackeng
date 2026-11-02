const mongoose = require('mongoose');

const communeSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, trim: true },
        localites: { type: [String], default: [] },
    },
    { _id: false }
);

const moughataaSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, trim: true },
        communes: { type: [communeSchema], default: [] },
    },
    { _id: false }
);

const wilayaSchema = new mongoose.Schema(
    {
        region: { type: String, required: true, trim: true },
        code: { type: String, required: true, trim: true },
        moughataas: { type: [moughataaSchema], default: [] },
    },
    { _id: false }
);

const geoReferentielSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, default: 'default' },
        version: { type: Number, default: 1 },
        territoires: { type: [wilayaSchema], default: [] },
    },
    { timestamps: true }
);

module.exports = mongoose.model('GeoReferentiel', geoReferentielSchema);
