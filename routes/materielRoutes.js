const express = require('express');
const multer = require('multer');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const materiels = require('../services/materielService');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

const stock = [authMiddleware, roleMiddleware(['admin', 'logisticien'])];

function handleError(res, err) {
    if (err && err.statusCode) return res.status(err.statusCode).json({ msg: err.message });
    console.error(err);
    return res.status(500).json({ msg: 'Erreur du serveur.' });
}

router.get('/export', ...stock, async (req, res) => {
    try {
        const data = await materiels.list();
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="materiel.csv"');
        res.send(materiels.toCsv(data.lignes));
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/mien', authMiddleware, roleMiddleware(['aam']), async (req, res) => {
    try {
        res.json(await materiels.mine(req.user.id));
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/kits', ...stock, async (req, res) => {
    try {
        res.json(await materiels.listKits());
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/sav', ...stock, async (req, res) => {
    try {
        res.json(await materiels.sav());
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/code/:code', ...stock, async (req, res) => {
    try {
        res.json(await materiels.chercherCode(req.params.code));
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/', ...stock, async (req, res) => {
    try {
        res.json(await materiels.list());
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/import', ...stock, upload.single('fichier'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'Choisissez un fichier Excel ou CSV.' });
        res.status(201).json(await materiels.importer(req.file.buffer, req.file.originalname));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/kits', ...stock, async (req, res) => {
    try {
        res.status(201).json(await materiels.creerKit(req.body || {}));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/dispatch', ...stock, async (req, res) => {
    try {
        const body = req.body || {};
        res.json(await materiels.dispatcher({ nom: body.nom, eamId: body.eamId }));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/lot', ...stock, async (req, res) => {
    try {
        const body = req.body || {};
        res.json(await materiels.assignLot(body.ids, body.eamId));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/restituer', ...stock, async (req, res) => {
    try {
        const body = req.body || {};
        res.json(await materiels.restituer(body.code, body.etat));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/', ...stock, async (req, res) => {
    try {
        res.status(201).json(await materiels.create(req.body || {}));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/reception-scan', authMiddleware, roleMiddleware(['aam']), async (req, res) => {
    try {
        res.json(await materiels.recevoirScan(req.user.id, req.body && req.body.code));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/:id/reception', authMiddleware, roleMiddleware(['aam']), async (req, res) => {
    try {
        const identifiants = req.body && req.body.identifiants;
        res.json(await materiels.recevoirMaitre(req.user.id, req.params.id, identifiants));
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/:id/incident', authMiddleware, roleMiddleware(['aam']), async (req, res) => {
    try {
        res.json(await materiels.signaler(req.user.id, req.params.id, req.body && req.body.motif));
    } catch (err) {
        handleError(res, err);
    }
});

router.delete('/:id', ...stock, async (req, res) => {
    try {
        await materiels.remove(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        handleError(res, err);
    }
});

module.exports = router;
