const Notification = require('../models/Notification');

function motifOf(merchant) {
    return String(merchant.rejectionReason || '')
        .replace(/^Rejeté, à corriger :\s*/i, '')
        .trim();
}

async function notifyCorrection(merchant) {
    if (!merchant || !merchant.agentRecruteurId) return;
    try {
        await Notification.findOneAndUpdate(
            { destinataireId: merchant.agentRecruteurId, merchantId: merchant._id, lu: false },
            {
                $set: {
                    merchantNom: merchant.nom || '',
                    motif: motifOf(merchant),
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (err) {
        console.error('Notification correction:', err.message);
    }
}

async function notifyMateriel(destinataireId, kitNom) {
    if (!destinataireId || !kitNom) return;
    await Notification.create({
        destinataireId,
        sujet: 'materiel',
        merchantNom: kitNom,
        motif: `Le kit ${kitNom} vous a été remis. Confirmez la réception dans Mon matériel.`,
    });
}

async function listForUser(userId) {
    return Notification.find({ destinataireId: userId, lu: false })
        .sort({ updatedAt: -1 })
        .limit(30)
        .select('sujet merchantId merchantNom motif updatedAt')
        .lean();
}

async function markRead(userId, notificationId) {
    await Notification.updateOne(
        { _id: notificationId, destinataireId: userId },
        { $set: { lu: true } }
    );
}

async function markMerchantRead(merchantId) {
    if (!merchantId) return;
    await Notification.updateMany({ merchantId, lu: false }, { $set: { lu: true } });
}

module.exports = {
    notifyCorrection,
    notifyMateriel,
    listForUser,
    markRead,
    markMerchantRead,
};
