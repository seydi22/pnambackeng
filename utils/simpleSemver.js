/**
 * Semver simple major.minor.patch (entiers non négatifs), sans prérelease/metadata.
 */
const SEMVER_SIMPLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isSimpleSemver(version) {
    return typeof version === 'string' && SEMVER_SIMPLE.test(version.trim());
}

module.exports = { isSimpleSemver, SEMVER_SIMPLE };
