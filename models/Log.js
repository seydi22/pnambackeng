const mongoose = require("mongoose");

const logSchema = new mongoose.Schema({
  matricule: {
    type: String,
    required: true,
  },
  role: {
    type: String,
  },
  acteur: {
    type: String,
  },
  action: {
    type: String,
    required: true,
  },
  outcome: {
    type: String,
    enum: ["succes", "echec"],
  },
  statusCode: {
    type: Number,
  },
  cible: {
    type: String,
  },
  cibleId: {
    type: String,
  },
  detail: {
    type: String,
    maxlength: 400,
  },
  ipAddress: {
    type: String,
  },
  userAgent: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

logSchema.index({ createdAt: -1 });
logSchema.index({ matricule: 1, createdAt: -1 });

module.exports = mongoose.model("Log", logSchema);
