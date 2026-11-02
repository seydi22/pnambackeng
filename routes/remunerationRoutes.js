// backend/routes/remunerationRoutes.js

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const Merchant = require('../models/Merchant');
const {
  getRemunerationSettings,
  updateRemunerationSettings,
  toPublicSettings,
} = require('../services/remunerationSettingsService');
const {
  runMonthlyAgentRewards,
  previewEligibleRewards,
  monthWindow,
} = require('../services/agentMonthlyReward');

function parseMonthBody(month) {
  if (!month) return undefined;
  const m = /^(\d{4})-(\d{2})$/.exec(String(month).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex0 = Number(m[2]) - 1;
  if (monthIndex0 < 0 || monthIndex0 > 11) return null;
  return monthWindow(year, monthIndex0);
}

// @route   GET /api/remuneration/settings
router.get(
  '/settings',
  [authMiddleware, roleMiddleware(['admin'])],
  async (req, res) => {
    try {
      const doc = await getRemunerationSettings();
      res.json(toPublicSettings(doc));
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ msg: 'Erreur du serveur.' });
    }
  }
);

// @route   PUT /api/remuneration/settings
// @desc    Uniquement merchantStatuses (montant/devise/mode fixes)
router.put(
  '/settings',
  [authMiddleware, roleMiddleware(['admin'])],
  async (req, res) => {
    try {
      const doc = await updateRemunerationSettings(
        {
          merchantStatuses: req.body?.merchantStatuses,
          amountPerMerchant: req.body?.amountPerMerchant,
        },
        req.user.id
      );
      res.json({
        msg: 'Parametres remuneration mis a jour.',
        settings: toPublicSettings(doc),
      });
    } catch (err) {
      if (err.statusCode === 400) {
        return res.status(400).json({ msg: err.message });
      }
      console.error(err.message);
      res.status(500).json({ msg: 'Erreur du serveur.' });
    }
  }
);

// @route   POST /api/remuneration/preview
// @desc    Verification visuelle des marchands eligibles (sans paiement)
router.post(
  '/preview',
  [authMiddleware, roleMiddleware(['admin'])],
  async (req, res) => {
    try {
      const period = parseMonthBody(req.body?.month);
      if (req.body?.month && !period) {
        return res.status(400).json({ msg: 'Format month invalide (YYYY-MM).' });
      }
      const preview = await previewEligibleRewards({ period });
      if (!preview.ok) {
        return res.status(400).json(preview);
      }
      res.json(preview);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ msg: 'Erreur lors de la verification.', error: err.message });
    }
  }
);

// @route   POST /api/remuneration/run-job
router.post(
  '/run-job',
  [authMiddleware, roleMiddleware(['admin'])],
  async (req, res) => {
    try {
      const { dryRun } = req.body || {};
      const period = parseMonthBody(req.body?.month);
      if (req.body?.month && !period) {
        return res.status(400).json({ msg: 'Format month invalide (YYYY-MM).' });
      }

      const report = await runMonthlyAgentRewards({
        period,
        dryRun: Boolean(dryRun),
        force: true,
      });
      res.json(report);
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ msg: 'Erreur lors du job remuneration.', error: err.message });
    }
  }
);

// @route   GET /api/remuneration/report
// @desc    Rapport remunerations marchands (filtre mois / statut / agent)
// @access  Private (admin)
router.get(
  '/report',
  [authMiddleware, roleMiddleware(['admin'])],
  async (req, res) => {
    try {
      const {
        month,
        status,
        agentId,
        page: pageRaw,
        limit: limitRaw,
      } = req.query;

      const page = Math.max(1, parseInt(pageRaw, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(limitRaw, 10) || 25));
      const skip = (page - 1) * limit;

      const filter = {
        'remuneration.status': { $in: ['paid', 'failed', 'eligible'] },
      };

      if (status && ['paid', 'failed', 'eligible', 'none'].includes(status)) {
        if (status === 'none') {
          filter['remuneration.status'] = { $in: ['none', null] };
        } else {
          filter['remuneration.status'] = status;
        }
      }

      if (month && /^\d{4}-\d{2}$/.test(String(month).trim())) {
        filter['remuneration.paidForMonth'] = String(month).trim();
      }

      if (agentId) {
        filter.agentRecruteurId = agentId;
      }

      const [total, rows, summaryAgg] = await Promise.all([
        Merchant.countDocuments(filter),
        Merchant.find(filter)
          .populate('agentRecruteurId', 'matricule moovMoneyMsisdn')
          .sort({ 'remuneration.paidAt': -1, updatedAt: -1 })
          .skip(skip)
          .limit(limit)
          .select(
            'nom shortCode contact statut agentRecruteurId remuneration createdAt'
          )
          .lean(),
        Merchant.aggregate([
          { $match: filter },
          {
            $group: {
              _id: '$remuneration.status',
              count: { $sum: 1 },
              totalAmount: {
                $sum: {
                  $cond: [
                    { $eq: ['$remuneration.status', 'paid'] },
                    { $ifNull: ['$remuneration.amount', 0] },
                    0,
                  ],
                },
              },
            },
          },
        ]),
      ]);

      const summary = {
        paidCount: 0,
        failedCount: 0,
        eligibleCount: 0,
        paidTotalAmount: 0,
      };
      for (const row of summaryAgg) {
        if (row._id === 'paid') {
          summary.paidCount = row.count;
          summary.paidTotalAmount = row.totalAmount || 0;
        } else if (row._id === 'failed') {
          summary.failedCount = row.count;
        } else if (row._id === 'eligible') {
          summary.eligibleCount = row.count;
        }
      }

      res.json({
        summary,
        filters: { month: month || null, status: status || null, agentId: agentId || null },
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
        items: rows.map((m) => ({
          _id: m._id,
          nom: m.nom,
          shortCode: m.shortCode,
          contact: m.contact,
          statut: m.statut,
          agentMatricule: m.agentRecruteurId?.matricule || null,
          agentMsisdn: m.agentRecruteurId?.moovMoneyMsisdn || null,
          remuneration: m.remuneration || null,
        })),
      });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ msg: 'Erreur du serveur.' });
    }
  }
);

module.exports = router;
