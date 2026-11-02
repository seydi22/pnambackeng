const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const positions = require('../services/positionService');

router.get('/', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
    try {
        res.json(await positions.mapForDay(req.query.jour));
    } catch (err) {
        console.error(err);
        res.status(500).json({ msg: 'Erreur du serveur.' });
    }
});

module.exports = router;
