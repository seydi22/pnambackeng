const Log = require("../models/Log");
const asyncHandler = require("express-async-handler");
const { escapeRegex } = require("../utils/escapeRegex");

/**
 * @desc    Recuperer tous les logs avec pagination et filtre
 * @route   GET /api/logs
 * @access  Private/Admin
 */
const getLogs = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 15, 100);
  const search = req.query.search || "";

  const query = search
    ? {
        $or: [
          { matricule: { $regex: escapeRegex(search), $options: "i" } },
          { acteur: { $regex: escapeRegex(search), $options: "i" } },
          { role: { $regex: escapeRegex(search), $options: "i" } },
          { action: { $regex: escapeRegex(search), $options: "i" } },
          { cible: { $regex: escapeRegex(search), $options: "i" } },
          { detail: { $regex: escapeRegex(search), $options: "i" } },
        ],
      }
    : {};

  const totalLogs = await Log.countDocuments(query);
  const totalPages = Math.ceil(totalLogs / limit);

  const logs = await Log.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  res.status(200).json({
    logs,
    totalPages,
    currentPage: page,
    totalLogs,
  });
});

module.exports = {
  getLogs,
};
