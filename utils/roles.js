/** Roles terrain V1, conserves, et roles organisation V2. */

const FIELD_AGENT_ROLES = ['agent', 'aam'];
const FIELD_SUPERVISOR_ROLES = ['superviseur', 'sam'];
const ORG_ROLES = ['pam', 'cam', 'sam', 'aam'];

function isFieldAgent(role) {
    return FIELD_AGENT_ROLES.includes(role);
}

function isFieldSupervisor(role) {
    return FIELD_SUPERVISOR_ROLES.includes(role);
}

/**
 * Une route qui autorise "agent" autorise aussi "aam".
 * Une route qui autorise "superviseur" autorise aussi "sam".
 * Le flux marchand V1 reste utilisable par les nouveaux comptes terrain.
 */
function expandRoles(roles) {
    const allowed = new Set(roles);
    for (const role of roles) {
        if (role === 'agent' || role === 'aam') {
            FIELD_AGENT_ROLES.forEach((item) => allowed.add(item));
        }
        if (role === 'superviseur' || role === 'sam') {
            FIELD_SUPERVISOR_ROLES.forEach((item) => allowed.add(item));
        }
    }
    return allowed;
}

module.exports = {
    FIELD_AGENT_ROLES,
    FIELD_SUPERVISOR_ROLES,
    ORG_ROLES,
    isFieldAgent,
    isFieldSupervisor,
    expandRoles,
};
