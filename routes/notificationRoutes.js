const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const notes = require('../services/notificationService');

router.use(authMiddleware, roleMiddleware(['admin', 'superviseur', 'agent', 'cam', 'pam']));

router.get('/', async (req, res) => {
    try {
        res.json(await notes.listForUser(req.user.id));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Erreur du serveur.' });
    }
});

router.post('/:id/lu', async (req, res) => {
    try {
        await notes.markRead(req.user.id, req.params.id);
        res.json({ ok: true });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Erreur du serveur.' });
    }
});

module.exports = router;
