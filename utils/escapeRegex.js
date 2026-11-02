/**
 * Echappe les metacaracteres regex pour eviter ReDoS / injection.
 */
function escapeRegex(input) {
    return String(input ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { escapeRegex };
