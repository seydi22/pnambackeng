const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const tours = require('../services/tourneeService');
const positions = require('../services/positionService');

function handleError(res, err) {
    if (err && err.statusCode) return res.status(err.statusCode).json({ msg: err.message });
    console.error(err);
    return res.status(500).json({ msg: 'Erreur du serveur.' });
}

router.get('/courante', authMiddleware, roleMiddleware(['aam']), async (req, res) => {
    try {
        res.json(await tours.current(req.user.id));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/debut', authMiddleware, roleMiddleware(['aam']), async (req, res) => {
    try {
        const tournee = await tours.start(req.user.id);
        await positions.recordForUser(req.user.id, { ...req.body, action: 'debut_tournee' });
        res.status(201).json(tournee);
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/position', authMiddleware, roleMiddleware(['aam']), async (req, res) => {
    try {
        const etat = await tours.current(req.user.id);
        if (!etat.ouverte) return res.status(400).json({ msg: 'Aucune tournée en cours.' });
        await positions.recordForUser(req.user.id, { ...req.body, action: 'suivi' });
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/fin', authMiddleware, roleMiddleware(['aam']), async (req, res) => {
    try {
        const tournee = await tours.stop(req.user.id);
        await positions.recordForUser(req.user.id, { ...req.body, action: 'fin_tournee' });
        res.json(tournee);
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/', authMiddleware, roleMiddleware(['admin']), async (req, res) => {
    try {
        res.json(await tours.listForDay(req.query.jour));
    } catch (err) {
        handleError(res, err);
    }
});

module.exports = router;
