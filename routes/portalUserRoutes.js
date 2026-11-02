const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const portal = require('../services/portalUserService');

const central = [authMiddleware, roleMiddleware(['admin'], { centralOnly: true })];

function handleError(res, err) {
    if (err && err.statusCode) return res.status(err.statusCode).json({ msg: err.message });
    console.error(err);
    return res.status(500).json({ msg: 'Erreur du serveur.' });
}

router.get('/', ...central, async (req, res) => {
    try {
        res.json(await portal.list());
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/', ...central, async (req, res) => {
    try {
        res.status(201).json(await portal.create(req.body || {}));
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/logisticiens', ...central, async (req, res) => {
    try {
        res.json(await portal.listLogisticiens());
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/logisticiens', ...central, async (req, res) => {
    try {
        res.status(201).json(await portal.createLogisticien(req.body || {}));
    } catch (err) {
        handleError(res, err);
    }
});

router.put('/logisticiens/:id', ...central, async (req, res) => {
    try {
        res.json(await portal.updateLogisticien(req.params.id, req.body || {}));
    } catch (err) {
        handleError(res, err);
    }
});

router.put('/:id', ...central, async (req, res) => {
    try {
        res.json(await portal.update(req.params.id, req.body || {}));
    } catch (err) {
        handleError(res, err);
    }
});

module.exports = router;
