const mongoose = require('mongoose');

const zoneSchema = new mongoose.Schema(
    {
        nom: { type: String, required: true, unique: true, trim: true },
        wilayas: [{ type: String, trim: true }],
        actif: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Zone', zoneSchema);
