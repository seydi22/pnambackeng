const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const AppVersionConfig = require('../models/AppVersionConfig');
const authMiddleware = require('../middleware/authMiddleware');
const roleMiddleware = require('../middleware/roleMiddleware');
const { isSimpleSemver } = require('../utils/simpleSemver');

/** URL APK par défaut (hébergée sur le dashboard admin) si aucune config DB / env. */
const DEFAULT_ANDROID_DOWNLOAD_URL =
    'https://moov-money-admindashboard.vercel.app/releases/Souscripteur%20V%201.0.3.apk';

function trimOrNull(value) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    return s.length ? s : null;
}

function payloadFromEnv() {
    const rawMin = trimOrNull(process.env.APP_MINIMUM_VERSION) || '0.0.0';
    const minimumVersion = isSimpleSemver(rawMin) ? rawMin : '0.0.0';
    const rawLatest = trimOrNull(process.env.APP_LATEST_VERSION);
    return {
        minimumVersion,
        latestVersion: rawLatest && isSimpleSemver(rawLatest) ? rawLatest : null,
        androidDownloadUrl:
            trimOrNull(process.env.APP_ANDROID_DOWNLOAD_URL) || DEFAULT_ANDROID_DOWNLOAD_URL,
        webUrl: trimOrNull(process.env.APP_WEB_URL),
        iosDownloadUrl: trimOrNull(process.env.APP_IOS_DOWNLOAD_URL),
        updateMessage: trimOrNull(process.env.APP_UPDATE_MESSAGE),
    };
}

function docToPayload(doc) {
    return {
        minimumVersion: doc.minimumVersion,
        latestVersion: doc.latestVersion != null && String(doc.latestVersion).trim() !== '' ? String(doc.latestVersion).trim() : null,
        androidDownloadUrl: trimOrNull(doc.androidDownloadUrl),
        webUrl: trimOrNull(doc.webUrl),
        iosDownloadUrl: trimOrNull(doc.iosDownloadUrl),
        updateMessage: trimOrNull(doc.updateMessage),
    };
}

function withDefaultAndroidDownloadUrl(payload) {
    if (trimOrNull(payload.androidDownloadUrl)) return payload;
    return { ...payload, androidDownloadUrl: DEFAULT_ANDROID_DOWNLOAD_URL };
}

async function resolveVersionPayload() {
    if (mongoose.connection.readyState !== 1) {
        return payloadFromEnv();
    }
    try {
        const doc = await AppVersionConfig.findOne().sort({ updatedAt: -1 }).lean();
        if (doc && doc.minimumVersion) {
            return docToPayload(doc);
        }
    } catch (err) {
        console.error('AppVersionConfig lecture:', err.message);
    }
    return payloadFromEnv();
}

// @route   GET /api/app/version
// @desc    Politique de version app (Moov Money Agent) — public, sans auth
// @access  Public
router.get('/version', async (req, res) => {
    try {
        const payload = await resolveVersionPayload();
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(withDefaultAndroidDownloadUrl(payload));
    } catch (err) {
        console.error('GET /api/app/version:', err.message);
        res.status(200).json(withDefaultAndroidDownloadUrl(payloadFromEnv()));
    }
});

// @route   PUT /api/app/version
// @desc    Met à jour la config servie par GET (remplace l’enregistrement le plus récent ou en crée un)
// @access  Private (admin)
router.put(
    '/version',
    authMiddleware,
    roleMiddleware(['admin']),
    async (req, res) => {
        try {
            const {
                minimumVersion,
                latestVersion,
                androidDownloadUrl,
                webUrl,
                iosDownloadUrl,
                updateMessage,
            } = req.body;

            if (!minimumVersion || !isSimpleSemver(String(minimumVersion))) {
                return res.status(400).json({
                    msg: 'minimumVersion est requis (format semver simple : major.minor.patch).',
                });
            }
            if (latestVersion != null && String(latestVersion).trim() !== '' && !isSimpleSemver(String(latestVersion))) {
                return res.status(400).json({ msg: 'latestVersion doit respecter le format major.minor.patch.' });
            }

            const update = {
                minimumVersion: String(minimumVersion).trim(),
                latestVersion: latestVersion != null && String(latestVersion).trim() !== '' ? String(latestVersion).trim() : null,
                androidDownloadUrl: trimOrNull(androidDownloadUrl),
                webUrl: trimOrNull(webUrl),
                iosDownloadUrl: trimOrNull(iosDownloadUrl),
                updateMessage: trimOrNull(updateMessage),
            };

            let doc = await AppVersionConfig.findOne().sort({ updatedAt: -1 });
            if (doc) {
                Object.assign(doc, update);
                await doc.save();
            } else {
                doc = await AppVersionConfig.create(update);
            }

            res.json(docToPayload(doc.toObject ? doc.toObject() : doc));
        } catch (err) {
            console.error('PUT /api/app/version:', err.message);
            res.status(500).send('Erreur du serveur.');
        }
    }
);

module.exports = router;
