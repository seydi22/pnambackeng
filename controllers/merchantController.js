const Merchant = require('../models/Merchant');
const asyncHandler = require('express-async-handler');
const { isMerchantLocked, STATUT_CREE, STATUT_LIVRE } = require('../utils/merchantStatus');

// @desc    Confirm QR code delivery, upload photos, and update merchant status
// @route   POST /api/merchants/:id/deliver
// @access  Private/Agent
const deliverMerchant = asyncHandler(async (req, res) => {
    const merchant = await Merchant.findById(req.params.id);

    if (!merchant) {
        return res.status(404).json({ msg: 'Marchand non trouve.' });
    }

    if (merchant.agentRecruteurId.toString() !== req.user.id) {
        return res.status(403).json({
            msg: 'Action non autorisee. Vous ne pouvez mettre a jour que vos propres marchands.',
        });
    }

    if (isMerchantLocked(merchant)) {
        return res.status(403).json({
            msg: 'Cet enrolement est rejete definitivement et ne peut plus etre modifie.',
        });
    }

    if (merchant.statut !== STATUT_CREE) {
        return res.status(400).json({
            msg: `Le marchand n'est pas pret pour la livraison. Statut actuel: ${merchant.statut}`,
        });
    }

    const qrCodePhotoUrl =
        req.files && req.files['qrCodePhoto'] ? req.files['qrCodePhoto'][0].path : null;
    const paymentTestPhotoUrl =
        req.files && req.files['paymentTestPhoto'] ? req.files['paymentTestPhoto'][0].path : null;

    if (!qrCodePhotoUrl) {
        return res.status(400).json({ msg: 'La photo du QR code est obligatoire.' });
    }

    merchant.statut = STATUT_LIVRE;
    merchant.qrCodePhotoUrl = qrCodePhotoUrl;
    merchant.paymentTestPhotoUrl = paymentTestPhotoUrl;
    merchant.deliveredAt = Date.now();
    merchant.deliveredBy = req.user.id;

    const updatedMerchant = await merchant.save();

    res.json(updatedMerchant);
});

module.exports = {
    deliverMerchant,
};
