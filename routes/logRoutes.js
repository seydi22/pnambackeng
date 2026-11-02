const express = require("express");
const router = express.Router();
const { getLogs } = require("../controllers/logController");
const protect = require("../middleware/authMiddleware");
const authorize = require("../middleware/roleMiddleware");

// @route   GET /api/logs
// @desc    Récupérer tous les logs
// @access  Private/Admin
router.get("/", protect, authorize(["admin"]), getLogs);

module.exports = router;
