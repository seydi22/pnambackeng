// backend/services/remunerationSettingsService.js

const RemunerationSettings = require('../models/RemunerationSettings');

const ALLOWED_STATUSES = ['cree', 'livré'];

function fixedCurrencyFromEnv() {
  return process.env.AGENT_REWARD_CURRENCY || 'MRU';
}

function defaultAmountFromEnv() {
  const amount = Number(process.env.AGENT_REWARD_AMOUNT_MRU || 50);
  return Number.isFinite(amount) && amount > 0 ? amount : 50;
}

function envFallbackDefaults() {
  return {
    enabled: true,
    paymentMode: 'monthly',
    amountPerMerchant: defaultAmountFromEnv(),
    currency: fixedCurrencyFromEnv(),
    primaryPartyId: '',
    commissionUrl: '',
    requireCompletedTxn: true,
    payOncePerMerchant: true,
    merchantStatuses: ['cree', 'livré'],
    notes: '',
  };
}

/**
 * Charge (ou crée) le document singleton des paramètres rémunération.
 */
async function getRemunerationSettings() {
  let doc = await RemunerationSettings.findOne({
    key: RemunerationSettings.SINGLETON_KEY,
  });
  if (!doc) {
    doc = await RemunerationSettings.create({
      key: RemunerationSettings.SINGLETON_KEY,
      ...envFallbackDefaults(),
    });
  }
  return doc;
}

/**
 * Admin : montant + statuts marchands. Devise / mode fixes.
 */
async function updateRemunerationSettings(patch, adminId) {
  const doc = await getRemunerationSettings();

  if (patch.amountPerMerchant !== undefined) {
    const n = Number(patch.amountPerMerchant);
    if (!Number.isFinite(n) || n <= 0) {
      const err = new Error('Montant invalide (nombre > 0 requis).');
      err.statusCode = 400;
      throw err;
    }
    doc.amountPerMerchant = n;
  }

  if (patch.merchantStatuses !== undefined) {
    if (!Array.isArray(patch.merchantStatuses) || patch.merchantStatuses.length === 0) {
      const err = new Error('Selectionnez au moins un statut marchand.');
      err.statusCode = 400;
      throw err;
    }
    const cleaned = [
      ...new Set(
        patch.merchantStatuses
          .map((s) => String(s).trim())
          .filter((s) => ALLOWED_STATUSES.includes(s))
      ),
    ];
    if (cleaned.length === 0) {
      const err = new Error('Statuts marchands invalides (cree / livré uniquement).');
      err.statusCode = 400;
      throw err;
    }
    doc.merchantStatuses = cleaned;
  }

  doc.paymentMode = 'monthly';
  doc.currency = fixedCurrencyFromEnv();
  doc.requireCompletedTxn = true;
  doc.payOncePerMerchant = true;

  if (adminId) doc.updatedBy = adminId;
  await doc.save();
  return doc;
}

/**
 * Config effective pour le job CPS.
 * Devise / URL / Primary Party = .env.
 * Montant + statuts = admin (DB).
 */
async function resolveCommissionConfig() {
  const doc = await getRemunerationSettings();

  return {
    enabled: true,
    paymentMode: 'monthly',
    amountPerMerchant: Number(doc.amountPerMerchant) || defaultAmountFromEnv(),
    currency: fixedCurrencyFromEnv(),
    primaryPartyId: process.env.CPS_COMMISSION_PRIMARY_PARTY_ID || '',
    url: process.env.CPS_COMMISSION_URL || process.env.CPS_URL || '',
    requireCompletedTxn: true,
    payOncePerMerchant: true,
    merchantStatuses:
      Array.isArray(doc.merchantStatuses) && doc.merchantStatuses.length
        ? doc.merchantStatuses
        : ['cree', 'livré'],
    settingsId: String(doc._id),
    updatedAt: doc.updatedAt,
  };
}

function toPublicSettings(doc) {
  return {
    paymentMode: 'monthly',
    amountPerMerchant: doc.amountPerMerchant ?? defaultAmountFromEnv(),
    currency: fixedCurrencyFromEnv(),
    requireCompletedTxn: true,
    payOncePerMerchant: true,
    merchantStatuses: doc.merchantStatuses,
    allowedMerchantStatuses: ALLOWED_STATUSES,
    updatedAt: doc.updatedAt,
  };
}

module.exports = {
  getRemunerationSettings,
  updateRemunerationSettings,
  resolveCommissionConfig,
  toPublicSettings,
  fixedCurrencyFromEnv,
  defaultAmountFromEnv,
  ALLOWED_STATUSES,
};
