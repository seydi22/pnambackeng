/**
 * Numéro Moov Money mauritanien.
 * L'utilisateur saisit 8 chiffres qui commencent par 4, par exemple 48503366.
 * Le serveur conserve et envoie 22248503366.
 */
function digitsOnly(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '');
}

function localMoovNumber(raw) {
  let digits = digitsOnly(raw);
  if (digits.startsWith('00222')) digits = digits.slice(2);
  if (digits.startsWith('222') && digits.length === 11) digits = digits.slice(3);
  return digits;
}

function normalizeMoovMsisdn(raw) {
  const local = localMoovNumber(raw);
  if (!/^4\d{7}$/.test(local)) return '';
  return `222${local}`;
}

function isValidMoovMsisdn(raw) {
  return /^4\d{7}$/.test(localMoovNumber(raw));
}

module.exports = {
  normalizeMoovMsisdn,
  isValidMoovMsisdn,
};
