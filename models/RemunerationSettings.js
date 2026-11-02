// backend/models/RemunerationSettings.js
// Document singleton : paramètres métier de la rémunération agents (paiement mensuel).

const mongoose = require('mongoose');

const SINGLETON_KEY = 'default';

const remunerationSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: SINGLETON_KEY,
    },
    /** Active / désactive le job de rémunération. */
    enabled: {
      type: Boolean,
      default: false,
    },
    /**
     * Mode de paiement. V1 : uniquement mensuel (évite complexité multi-modes).
     * Champ réservé pour évolution future.
     */
    paymentMode: {
      type: String,
      enum: ['monthly'],
      default: 'monthly',
    },
    /** Montant CPS par marchand éligible (préval = paiement). */
    amountPerMerchant: {
      type: Number,
      default: 50,
      min: 0,
    },
    currency: {
      type: String,
      default: 'MRU',
      trim: true,
    },
    /**
     * Identifiant org primaire CPS (IdentifierType 4) pour Promotional Commission.
     * Les secrets SOAP restent dans .env.
     */
    primaryPartyId: {
      type: String,
      default: '',
      trim: true,
    },
    /**
     * URL CPS commission (optionnel). Si vide → CPS_COMMISSION_URL ou CPS_URL (.env).
     */
    commissionUrl: {
      type: String,
      default: '',
      trim: true,
    },
    /** Exiger ≥ 1 transaction Completed sur le shortCode dans la période. */
    requireCompletedTxn: {
      type: Boolean,
      default: true,
    },
    /** Un marchand déjà payé n'est jamais re-inclus (idempotence). */
    payOncePerMerchant: {
      type: Boolean,
      default: true,
    },
    /** Statuts marchands inclus dans le lot. */
    merchantStatuses: {
      type: [String],
      default: ['cree', 'livré'],
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agent',
    },
  },
  { timestamps: true }
);

remunerationSettingsSchema.statics.SINGLETON_KEY = SINGLETON_KEY;

module.exports = mongoose.model('RemunerationSettings', remunerationSettingsSchema);
