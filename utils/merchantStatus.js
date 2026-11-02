const REJETE_DEFINITIF = 'rejet\u00e9_d\u00e9finitivement';
const STATUT_CREE = 'cree';
const STATUT_LIVRE = 'livr\u00e9';
const STATUTS_REUSSITE = [STATUT_CREE, STATUT_LIVRE];

function isMerchantLocked(merchant) {
    return merchant && merchant.statut === REJETE_DEFINITIF;
}

function isStatutReussi(statut) {
    return STATUTS_REUSSITE.includes(statut);
}

module.exports = {
    REJETE_DEFINITIF,
    STATUT_CREE,
    STATUT_LIVRE,
    STATUTS_REUSSITE,
    isMerchantLocked,
    isStatutReussi,
};