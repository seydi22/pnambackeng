const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const org = require('../services/organizationService');
const geo = require('../services/geoReferentielService');
const zones = require('../services/zoneService');

router.use(authMiddleware, roleMiddleware(['admin']));

function handleError(res, err) {
    if (err && err.statusCode) {
        return res.status(err.statusCode).json({ msg: err.message });
    }
    if (err && err.code === 11000) {
        return res.status(400).json({ msg: 'Une valeur unique existe deja (NNI, MSISDN ou CAM).' });
    }
    console.error(err);
    return res.status(500).json({ msg: 'Erreur du serveur.' });
}

router.get('/territoire', async (req, res) => {
    try {
        res.json({ territoires: await geo.listTerritoires() });
    } catch (err) {
        handleError(res, err);
    }
});

router.put('/territoire', async (req, res) => {
    try {
        const territoires = await geo.updateReferentiel(req.body && req.body.territoires);
        res.json({ msg: 'Referentiel geographique mis a jour.', territoires });
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/zones', async (req, res) => {
    try {
        res.json(await zones.listZones());
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/zones', async (req, res) => {
    try {
        const zone = await zones.createZone(req.body || {});
        res.status(201).json(zone);
    } catch (err) {
        handleError(res, err);
    }
});

router.put('/zones/:id', async (req, res) => {
    try {
        const zone = await zones.updateZone(req.params.id, req.body || {});
        res.json(zone);
    } catch (err) {
        handleError(res, err);
    }
});

router.delete('/zones/:id', async (req, res) => {
    try {
        const result = await zones.deleteZone(req.params.id);
        res.json({ msg: 'Zone supprimée.', ...result });
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/prochain-code', async (req, res) => {
    try {
        const code = await org.previewCode(req.query || {});
        res.json({ code });
    } catch (err) {
        handleError(res, err);
    }
});

router.get('/', async (req, res) => {
    try {
        res.json(await org.getOverview());
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/pams', async (req, res) => {
    try {
        const pam = await org.createPam(req.body || {});
        res.status(201).json(pam);
    } catch (err) {
        handleError(res, err);
    }
});

router.put('/pams/:id', async (req, res) => {
    try {
        const pam = await org.updatePam(req.params.id, req.body || {});
        res.json(pam);
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/eams', async (req, res) => {
    try {
        const eam = await org.createEam(req.body || {});
        res.status(201).json(eam);
    } catch (err) {
        handleError(res, err);
    }
});

router.put('/eams/:id', async (req, res) => {
    try {
        const eam = await org.updateEam(req.params.id, req.body || {});
        res.json(eam);
    } catch (err) {
        handleError(res, err);
    }
});

router.post('/users', async (req, res) => {
    try {
        const user = await org.createOrgUser(req.body || {});
        res.status(201).json(user);
    } catch (err) {
        handleError(res, err);
    }
});

router.put('/users/:id', async (req, res) => {
    try {
        const user = await org.updateOrgUser(req.params.id, req.body || {});
        res.json(user);
    } catch (err) {
        handleError(res, err);
    }
});

module.exports = router;
