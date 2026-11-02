/* eslint-disable no-console */
require('dotenv').config();
const keys = [
  'CPS_THIRD_PARTY_ID',
  'CPS_INITIATOR_IDENTIFIER',
  'CPS_INITIATOR_IDENTIFIER_TYPE',
  'CPS_PASSWORD',
  'CPS_INITIATOR_SECURITY_CREDENTIAL',
  'CPS_URL',
  'CPS_COMMISSION_PRIMARY_PARTY_ID',
];
for (const k of keys) {
  const v = process.env[k] || '';
  console.log(
    `${k}: len=${v.length} empty=${v.length === 0} hasSlash=${v.includes('/')} hasPlus=${v.includes('+')}`
  );
}
