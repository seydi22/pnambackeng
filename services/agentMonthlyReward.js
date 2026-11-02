const Agent = require('../models/Agent');
const Merchant = require('../models/Merchant');
const {
  cpsStandardPrevalidation,
  cpsInitPromotionalCommission,
  cpsSyncQueryOrgTxn,
  nowTimestamp,
} = require('./cpsSyncApi');
const { resolveCommissionConfig } = require('./remunerationSettingsService');

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Retourne { year, monthIndex0, label 'YYYY-MM', start, end, startDateTime, endDateTime } pour un mois civil. */
function monthWindow(year, monthIndex0) {
  const start = new Date(Date.UTC(year, monthIndex0, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex0 + 1, 0, 23, 59, 59, 999));
  const fmt = (d) =>
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  return {
    year,
    monthIndex0,
    label: `${year}-${pad2(monthIndex0 + 1)}`,
    start,
    end,
    startDateTime: fmt(start),
    endDateTime: fmt(end),
  };
}

/** Mois civil précédent (défaut job fin de mois). */
function previousCalendarMonth(ref = new Date()) {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  if (m === 0) return monthWindow(y - 1, 11);
  return monthWindow(y, m - 1);
}

function formatCpsDateTime(d) {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

/**
 * Fenêtre CPS pour ≥ 1 txn Completed :
 * du début du mois de création (cohorte) jusqu'à maintenant
 * (la 1re txn peut arriver des mois plus tard).
 */
function txnSearchWindow(period, ref = new Date()) {
  const now = ref instanceof Date ? ref : new Date();
  const end = now.getTime() < period.start.getTime() ? period.end : now;
  return {
    start: period.start,
    end,
    startDateTime: period.startDateTime,
    endDateTime: formatCpsDateTime(end),
  };
}

function cpsAuthPayload() {
  return {
    thirdPartyId: process.env.CPS_THIRD_PARTY_ID,
    password: process.env.CPS_PASSWORD,
    initiatorIdentifierType: process.env.CPS_INITIATOR_IDENTIFIER_TYPE,
    initiatorIdentifier: process.env.CPS_INITIATOR_IDENTIFIER,
    initiatorSecurityCredential: process.env.CPS_INITIATOR_SECURITY_CREDENTIAL,
  };
}

/** @deprecated Prefere resolveCommissionConfig() (DB admin). Conserve pour compat scripts. */
function commissionConfig() {
  const amountPerMerchant = Number(process.env.AGENT_REWARD_AMOUNT_MRU || 50);
  const currency = process.env.AGENT_REWARD_CURRENCY || 'MRU';
  const primaryPartyId = process.env.CPS_COMMISSION_PRIMARY_PARTY_ID || '';
  const url = process.env.CPS_COMMISSION_URL || process.env.CPS_URL || '';
  const enabled = String(process.env.AGENT_REWARD_ENABLED || '').trim() === '1';
  return {
    amountPerMerchant,
    currency,
    primaryPartyId,
    url,
    enabled,
    requireCompletedTxn: true,
    payOncePerMerchant: true,
    merchantStatuses: ['cree', 'livré'],
  };
}

function missingCpsEnv() {
  const required = [
    'CPS_THIRD_PARTY_ID',
    'CPS_PASSWORD',
    'CPS_INITIATOR_IDENTIFIER_TYPE',
    'CPS_INITIATOR_IDENTIFIER',
    'CPS_INITIATOR_SECURITY_CREDENTIAL',
  ];
  return required.filter((k) => !String(process.env[k] || '').trim());
}

/**
 * Pour un marchand : true si SyncQueryOrgTxn trouve au moins 1 TransactionID (ResultCode 0).
 * Tente shortCode tel quel puis sans zeros de tete (CPS IdentifierType 4).
 */
async function merchantHadCompletedTxn({ url, shortCode, startDateTime, endDateTime, currency }) {
  const auth = cpsAuthPayload();
  const variants = [];
  const raw = String(shortCode || '').trim();
  if (raw) variants.push(raw);
  const stripped = raw.replace(/^0+/, '');
  if (stripped && stripped !== raw) variants.push(stripped);

  let last = {
    ok: false,
    resultCode: '',
    resultDesc: '',
    transactionCount: 0,
    queriedAs: raw,
  };

  for (const orgIdentifier of variants) {
    // eslint-disable-next-line no-await-in-loop
    const result = await cpsSyncQueryOrgTxn({
      url,
      payload: {
        ...auth,
        orgIdentifier,
        startDateTime,
        endDateTime,
        currency,
        transactionStatus: 'Completed',
      },
    });
    last = {
      ok: String(result.resultCode) === '0' && result.transactionCount > 0,
      resultCode: result.resultCode,
      resultDesc: result.resultDesc,
      transactionCount: result.transactionCount || 0,
      queriedAs: orgIdentifier,
    };
    // Succes txn, ou ResultCode 0 sans txn (org existe) → stop
    if (last.ok || String(result.resultCode) === '0') {
      return last;
    }
    // 3004 = identity inexistante → essayer variante shortCode
    if (!/^3004$|does not exist/i.test(`${result.resultCode} ${result.resultDesc}`)) {
      return last;
    }
  }
  return last;
}

/**
 * Traite un agent : éligibilité marchands + préval + paiement agrégé.
 */
async function processAgentReward(agent, period, cfg) {
  const summary = {
    agentId: String(agent._id),
    matricule: agent.matricule,
    msisdn: agent.moovMoneyMsisdn,
    eligibleCount: 0,
    totalAmount: 0,
    merchantIds: [],
    status: 'skipped',
    error: null,
    transactionId: null,
    conversationId: null,
  };

  // Cohorte = marchands crees dans le mois choisi ; fenetre CPS = debut cohorte → maintenant.
  const txnWin = txnSearchWindow(period);
  const merchantFilter = {
    agentRecruteurId: agent._id,
    statut: { $in: cfg.merchantStatuses || ['cree', 'livré'] },
    shortCode: { $exists: true, $nin: [null, ''] },
    createdAt: { $gte: period.start, $lte: period.end },
  };
  if (cfg.payOncePerMerchant !== false) {
    merchantFilter['remuneration.status'] = { $ne: 'paid' };
  }

  const merchants = await Merchant.find(merchantFilter).select('_id shortCode nom remuneration');

  const eligible = [];
  for (const m of merchants) {
    try {
      let ok = true;
      if (cfg.requireCompletedTxn !== false) {
        const check = await merchantHadCompletedTxn({
          url: cfg.url,
          shortCode: m.shortCode,
          startDateTime: txnWin.startDateTime,
          endDateTime: txnWin.endDateTime,
          currency: cfg.currency,
        });
        ok = check.ok;
        if (!ok) {
          console.log(
            `[reward] eligibilite skip shortCode=${m.shortCode} code=${check.resultCode || 'n/a'} ` +
              `(SyncQueryOrgTxn — pas le paiement agent)`
          );
        }
      }
      if (ok) {
        eligible.push(m);
        m.remuneration = m.remuneration || {};
        m.remuneration.status = 'eligible';
        await m.save();
      }
    } catch (err) {
      console.error(`[reward] query txn fail merchant=${m._id}:`, err.message);
    }
  }

  summary.eligibleCount = eligible.length;
  summary.merchantIds = eligible.map((m) => String(m._id));
  if (eligible.length === 0) {
    summary.status = 'no_eligible';
    return summary;
  }

  const total = eligible.length * cfg.amountPerMerchant;
  summary.totalAmount = total;
  const auth = cpsAuthPayload();
  const commonParties = {
    ...auth,
    primaryPartyIdentifier: cfg.primaryPartyId,
    receiverIdentifier: agent.moovMoneyMsisdn,
    amount: String(total),
    currency: cfg.currency,
    timestamp: nowTimestamp(),
  };

  console.log(
    `[reward] paiement debut agent=${agent.matricule} ` +
      `debitPrimaryParty=${cfg.primaryPartyId} creditMsisdn=${agent.moovMoneyMsisdn} ` +
      `amount=${total} ${cfg.currency} eligibleShortCodes=${eligible.map((x) => x.shortCode).join(',')}`
  );

  let preval;
  try {
    preval = await cpsStandardPrevalidation({
      url: cfg.url,
      payload: {
        ...commonParties,
        remark: `Monthly reward ${period.label} x${eligible.length}`,
      },
    });
  } catch (err) {
    summary.status = 'preval_error';
    summary.error = err.message;
    console.error(`[reward] preval_error agent=${agent.matricule}:`, err.message);
    await markMerchantsFailed(eligible, err.message, period.label, total);
    return summary;
  }

  if (String(preval.resultCode) !== '0') {
    summary.status = 'preval_failed';
    summary.error = `${preval.resultCode}: ${preval.resultDesc}`;
    console.error(
      `[reward] preval_failed agent=${agent.matricule} ` +
        `code=${preval.resultCode} desc=${preval.resultDesc} ` +
        `primary=${cfg.primaryPartyId} msisdn=${agent.moovMoneyMsisdn}`
    );
    await markMerchantsFailed(eligible, summary.error, period.label, total);
    return summary;
  }

  console.log(
    `[reward] preval_ok agent=${agent.matricule} conversationId=${preval.conversationId || ''}`
  );

  let pay;
  try {
    pay = await cpsInitPromotionalCommission({
      url: cfg.url,
      payload: { ...commonParties },
    });
  } catch (err) {
    summary.status = 'pay_error';
    summary.error = err.message;
    console.error(`[reward] pay_error agent=${agent.matricule}:`, err.message);
    await markMerchantsFailed(eligible, err.message, period.label, total);
    return summary;
  }

  if (String(pay.resultCode) !== '0') {
    summary.status = 'pay_failed';
    summary.error = `${pay.resultCode}: ${pay.resultDesc}`;
    console.error(
      `[reward] pay_failed agent=${agent.matricule} code=${pay.resultCode} desc=${pay.resultDesc}`
    );
    await markMerchantsFailed(eligible, summary.error, period.label, total);
    return summary;
  }

  console.log(
    `[reward] pay_ok agent=${agent.matricule} transactionId=${pay.transactionId || ''} ` +
      `conversationId=${pay.conversationId || ''}`
  );

  const paidAt = new Date();
  for (const m of eligible) {
    m.remuneration = {
      status: 'paid',
      amount: cfg.amountPerMerchant,
      paidAt,
      paidForMonth: period.label,
      conversationId: pay.conversationId || preval.conversationId,
      transactionId: pay.transactionId || '',
      lastError: undefined,
    };
    await m.save();
  }

  summary.status = 'paid';
  summary.transactionId = pay.transactionId || null;
  summary.conversationId = pay.conversationId || null;
  return summary;
}

async function markMerchantsFailed(merchants, error, monthLabel, totalAmount) {
  const perMerchant =
    merchants.length > 0 ? totalAmount / merchants.length : undefined;
  for (const m of merchants) {
    m.remuneration = {
      ...(m.remuneration?.toObject?.() || m.remuneration || {}),
      status: 'failed',
      amount: perMerchant,
      paidForMonth: monthLabel,
      lastError: String(error || '').slice(0, 500),
    };
    await m.save();
  }
}

/**
 * Job principal.
 * @param {{ period?: ReturnType<typeof previousCalendarMonth>, dryRun?: boolean, force?: boolean }} opts
 */
async function runMonthlyAgentRewards(opts = {}) {
  const cfg = await resolveCommissionConfig();
  const period = opts.period || previousCalendarMonth();

  if (!cfg.enabled && !opts.force) {
    return {
      skipped: true,
      reason: 'Remuneration desactivee (parametres admin)',
      period: period.label,
    };
  }

  const missing = missingCpsEnv();
  if (!cfg.url || !cfg.primaryPartyId || missing.length) {
    return {
      skipped: true,
      reason: `Config CPS incomplete (url/primaryParty/${missing.join(',')})`,
      period: period.label,
    };
  }

  if (cfg.amountPerMerchant <= 0 || Number.isNaN(cfg.amountPerMerchant)) {
    return { skipped: true, reason: 'Montant remuneration invalide', period: period.label };
  }

  const agents = await Agent.find({
    role: { $in: ['agent', 'aam'] },
    moovMoneyMsisdn: { $exists: true, $nin: [null, ''] },
  }).select('_id matricule moovMoneyMsisdn');

  const results = [];
  for (const agent of agents) {
    if (opts.dryRun) {
      results.push({
        agentId: String(agent._id),
        matricule: agent.matricule,
        status: 'dry_run',
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await processAgentReward(agent, period, cfg);
    results.push(r);
    console.log(
      `[reward] ${agent.matricule}: ${r.status} eligible=${r.eligibleCount} total=${r.totalAmount}` +
        (r.error ? ` error=${r.error}` : '') +
        (r.transactionId ? ` txn=${r.transactionId}` : '')
    );
  }

  return {
    skipped: false,
    period: period.label,
    amountPerMerchant: cfg.amountPerMerchant,
    currency: cfg.currency,
    paymentMode: cfg.paymentMode,
    agentCount: agents.length,
    results,
  };
}

/**
 * Prévisualisation : cohorte = marchands créés dans le mois choisi ;
 * SyncQueryOrgTxn du début de ce mois jusqu'à maintenant (≥ 1 txn Completed).
 * Indépendant du MSISDN agent (le MSISDN ne sert qu'au paiement ensuite).
 */
async function previewEligibleRewards(opts = {}) {
  const cfg = await resolveCommissionConfig();
  const period = opts.period || previousCalendarMonth();
  const txnWin = txnSearchWindow(period);

  const missing = missingCpsEnv();
  if (!cfg.url || missing.length) {
    return {
      ok: false,
      reason: `Config CPS incomplete (url/${missing.join(',')})`,
      period: period.label,
    };
  }

  const merchantFilter = {
    statut: { $in: cfg.merchantStatuses || ['cree', 'livré'] },
    shortCode: { $exists: true, $nin: [null, ''] },
    createdAt: { $gte: period.start, $lte: period.end },
  };
  if (cfg.payOncePerMerchant !== false) {
    merchantFilter['remuneration.status'] = { $ne: 'paid' };
  }

  const merchants = await Merchant.find(merchantFilter)
    .populate('agentRecruteurId', 'matricule moovMoneyMsisdn')
    .select('_id nom shortCode contact statut remuneration agentRecruteurId createdAt')
    .lean();

  const eligibleMerchants = [];
  const skippedMerchants = [];
  const byAgentMap = new Map();

  const ensureAgentBucket = (agent) => {
    const key = agent?._id ? String(agent._id) : 'sans-agent';
    if (!byAgentMap.has(key)) {
      byAgentMap.set(key, {
        agentId: agent?._id ? String(agent._id) : null,
        matricule: agent?.matricule || 'N/A',
        msisdn: agent?.moovMoneyMsisdn || null,
        candidateCount: 0,
        eligibleCount: 0,
        estimatedAmount: 0,
      });
    }
    return byAgentMap.get(key);
  };

  for (const m of merchants) {
    const agent = m.agentRecruteurId;
    const bucket = ensureAgentBucket(agent);
    bucket.candidateCount += 1;

    const base = {
      merchantId: String(m._id),
      nom: m.nom,
      shortCode: m.shortCode,
      contact: m.contact,
      statut: m.statut,
      agentId: agent?._id ? String(agent._id) : null,
      agentMatricule: agent?.matricule || null,
      agentMsisdn: agent?.moovMoneyMsisdn || null,
      remunerationStatus: m.remuneration?.status || 'none',
    };

    if (cfg.requireCompletedTxn === false) {
      eligibleMerchants.push({ ...base, transactionCount: null, reason: null });
      bucket.eligibleCount += 1;
      bucket.estimatedAmount = bucket.eligibleCount * cfg.amountPerMerchant;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const check = await merchantHadCompletedTxn({
        url: cfg.url,
        shortCode: m.shortCode,
        startDateTime: txnWin.startDateTime,
        endDateTime: txnWin.endDateTime,
        currency: cfg.currency,
      });
      if (check.ok) {
        eligibleMerchants.push({
          ...base,
          transactionCount: check.transactionCount,
          reason: null,
          resultCode: check.resultCode,
        });
        bucket.eligibleCount += 1;
        bucket.estimatedAmount = bucket.eligibleCount * cfg.amountPerMerchant;
      } else {
        const code = String(check.resultCode || '');
        const desc = String(check.resultDesc || '');
        let reason = `Aucune txn Completed depuis ${period.label} jusqu'a maintenant`;
        if (code && code !== '0') {
          if (/GV50113|does not exist/i.test(`${code} ${desc}`)) {
            reason = `Org absente CPS (GV50113) pour shortCode ${check.queriedAs || base.shortCode}`;
          } else {
            reason = `CPS ${code}: ${desc || 'echec query'}`;
          }
        }
        skippedMerchants.push({
          ...base,
          transactionCount: check.transactionCount || 0,
          resultCode: code,
          resultDesc: desc,
          queriedAs: check.queriedAs || base.shortCode,
          reason,
        });
      }
    } catch (err) {
      skippedMerchants.push({
        ...base,
        transactionCount: 0,
        reason: `Erreur CPS: ${err.message}`,
      });
    }
  }

  const byAgent = [...byAgentMap.values()];
  const eligibleCount = eligibleMerchants.length;
  const agentsWithMsisdn = await Agent.countDocuments({
    role: { $in: ['agent', 'aam'] },
    moovMoneyMsisdn: { $exists: true, $nin: [null, ''] },
  });
  const agentsWithoutMsisdn = await Agent.countDocuments({
    role: { $in: ['agent', 'aam'] },
    $or: [
      { moovMoneyMsisdn: { $exists: false } },
      { moovMoneyMsisdn: null },
      { moovMoneyMsisdn: '' },
    ],
  });

  const cpsAuthErrors = skippedMerchants.filter((s) =>
    /TP40087/i.test(`${s.resultCode || ''} ${s.resultDesc || ''} ${s.reason || ''}`)
  );
  const orgMissingErrors = skippedMerchants.filter((s) =>
    /GV50113|organization.*does not exist|short code does not exist/i.test(
      `${s.resultCode || ''} ${s.resultDesc || ''} ${s.reason || ''}`
    )
  );

  const eligibleWithoutAgentMsisdn = eligibleMerchants.filter((m) => !m.agentMsisdn).length;

  return {
    ok: true,
    period: period.label,
    startDateTime: period.startDateTime,
    endDateTime: period.endDateTime,
    txnStartDateTime: txnWin.startDateTime,
    txnEndDateTime: txnWin.endDateTime,
    amountPerMerchant: cfg.amountPerMerchant,
    currency: cfg.currency,
    merchantStatuses: cfg.merchantStatuses,
    agentsWithMsisdn,
    agentsWithoutMsisdn,
    candidateTotal: merchants.length,
    eligibleCount,
    skippedCount: skippedMerchants.length,
    estimatedTotal: eligibleCount * cfg.amountPerMerchant,
    warning:
      merchants.length === 0
        ? `Aucun marchand cree en ${period.label} avec shortCode (statuts: ${(cfg.merchantStatuses || []).join(', ') || 'n/a'}).`
        : cpsAuthErrors.length > 0
          ? `Echec auth CPS (TP40087): identifiants Password/SecurityCredential refuses.`
          : orgMissingErrors.length > 0 && eligibleCount === 0
            ? `CPS GV50113: aucun shortCode trouve cote Moov Money (${orgMissingErrors.length}/${skippedMerchants.length}). Les marchands existent en base locale mais l'organisation n'existe pas (ou pas encore) sur le testbed CPS.`
            : eligibleWithoutAgentMsisdn > 0
              ? `${eligibleWithoutAgentMsisdn} marchand(s) eligibile(s) mais agent sans MSISDN — non payables tant que le numero n'est pas renseigne.`
              : null,
    byAgent,
    eligibleMerchants,
    skippedMerchants,
  };
}

module.exports = {
  runMonthlyAgentRewards,
  previewEligibleRewards,
  previousCalendarMonth,
  monthWindow,
  commissionConfig,
  resolveCommissionConfig,
};
