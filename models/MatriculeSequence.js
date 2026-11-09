const mongoose = require('mongoose');

const matriculeSequenceSchema = new mongoose.Schema({
    cle: { type: String, required: true, unique: true },
    seq: { type: Number, required: true, default: 0 },
});

module.exports = mongoose.model('MatriculeSequence', matriculeSequenceSchema);
