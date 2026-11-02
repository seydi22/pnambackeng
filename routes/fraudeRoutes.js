const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const fraude = require('../services/fraudeService');

function handleError(res, err) {
    if (err && err.statusCode) return res.status(err.statusCode).json({ msg: err.message });
    console.error(err);
    return res.status(500).json({ msg: 'Erreur du serveur.' });
}

router.get('/', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
    try {
        res.json({ seuil: fraude.SEUIL, alertes: await fraude.list(req.query.statut) });
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/:id', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
    try {
        res.json(await fraude.detail(req.params.id));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/:id/ecarter', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
    try {
        res.json(await fraude.ecarter(req.params.id));
    } catch (err) {
        handleError(res, err);
    }
});

module.exports = router;
