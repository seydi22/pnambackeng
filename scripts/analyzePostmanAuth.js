const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'Moov Money Internal API(Testbed).postman_collection.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));

function walk(items, acc = []) {
  for (const it of items || []) {
    if (it.request) acc.push(it);
    if (it.item) walk(it.item, acc);
  }
  return acc;
}

function extract(raw, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}>([^<]*)</(?:[\\w.-]+:)?${tag}>`, 'i');
  const m = String(raw || '').match(re);
  return m ? m[1] : '';
}

function extractAfter(raw, section, tag) {
  const sec = String(raw || '').match(
    new RegExp(`<(?:[\\w.-]+:)?${section}[\\s\\S]*?</(?:[\\w.-]+:)?${section}>`, 'i')
  );
  if (!sec) return '';
  return extract(sec[0], tag);
}

const all = walk(j.item);
const rows = [];

for (const it of all) {
  const raw = (it.request && it.request.body && it.request.body.raw) || '';
  if (!raw.includes('CommandID') && !raw.includes('soapenv')) continue;
  const command = extract(raw, 'CommandID');
  const thirdParty = extract(raw, 'ThirdPartyID');
  const callerType = extract(raw, 'CallerType');
  const keyOwner = extract(raw, 'KeyOwner');
  const timestamp = extract(raw, 'Timestamp');
  const resultUrl = extract(raw, 'ResultURL');
  const initType = extractAfter(raw, 'Initiator', 'IdentifierType') || extract(raw, 'IdentifierType');
  // better: first IdentifierType inside Initiator
  const initBlock = (raw.match(/<(?:[\w.-]+:)?Initiator[\s\S]*?<\/(?:[\w.-]+:)?Initiator>/i) || [])[0] || '';
  const initiatorType = extract(initBlock, 'IdentifierType');
  const initiatorId = extract(initBlock, 'Identifier');
  const pwd = extract(raw, 'Password');
  const sec = extract(initBlock, 'SecurityCredential');
  const recvBlock = (raw.match(/<(?:[\w.-]+:)?ReceiverParty[\s\S]*?<\/(?:[\w.-]+:)?ReceiverParty>/i) || [])[0] || '';
  const recvType = extract(recvBlock, 'IdentifierType');
  const recvId = extract(recvBlock, 'Identifier');
  const url = (it.request.url && (it.request.url.raw || it.request.url)) || '';

  rows.push({
    name: it.name,
    command,
    url: typeof url === 'string' ? url : JSON.stringify(url),
    callerType,
    thirdParty,
    keyOwner,
    timestamp,
    hasResultURL: Boolean(resultUrl),
    resultUrl: resultUrl ? resultUrl.slice(0, 40) + '...' : '',
    initiatorType,
    initiatorId,
    pwdLen: pwd.length,
    secLen: sec.length,
    pwdEqSec: pwd && sec ? pwd === sec : null,
    pwdStart: pwd.slice(0, 8),
    recvType,
    recvId,
  });
}

const byCommand = {};
for (const r of rows) {
  const k = r.command || '(none)';
  if (!byCommand[k]) byCommand[k] = [];
  byCommand[k].push(r);
}

console.log('Total SOAP-ish requests:', rows.length);
console.log('Commands:', Object.keys(byCommand).sort().join(', '));
console.log('\n=== Auth fingerprints by CommandID ===');
for (const [cmd, list] of Object.entries(byCommand).sort()) {
  const uniq = new Map();
  for (const r of list) {
    const key = [
      r.thirdParty,
      r.initiatorType,
      r.initiatorId,
      r.callerType,
      r.keyOwner,
      r.pwdLen,
      r.secLen,
      r.pwdEqSec,
      r.hasResultURL,
      r.timestamp,
    ].join('|');
    if (!uniq.has(key)) uniq.set(key, r);
  }
  console.log(`\n[${cmd}] count=${list.length} uniqueAuth=${uniq.size}`);
  for (const r of uniq.values()) {
    console.log(
      JSON.stringify(
        {
          sampleName: r.name,
          thirdParty: r.thirdParty,
          initiatorType: r.initiatorType,
          initiatorId: r.initiatorId,
          callerType: r.callerType,
          keyOwner: r.keyOwner,
          pwdLen: r.pwdLen,
          secLen: r.secLen,
          pwdEqSec: r.pwdEqSec,
          pwdStart: r.pwdStart,
          timestamp: r.timestamp,
          hasResultURL: r.hasResultURL,
          recvType: r.recvType,
          recvId: r.recvId,
        },
        null,
        0
      )
    );
  }
}

const sync = rows.filter((r) => /SyncQueryOrgTxn|QueryOrganization/i.test(r.name + r.command));
console.log('\n=== SyncQuery / QueryOrgTxn requests ===');
console.log(JSON.stringify(sync, null, 2));

const promo = rows.filter((r) =>
  /Prevalidation|Promotional|InitTrans/i.test(r.name + r.command)
);
console.log('\n=== Commission-related ===');
for (const r of promo) {
  console.log(
    r.name,
    r.command,
    '3P=',
    r.thirdParty,
    'initType=',
    r.initiatorType,
    'initId=',
    r.initiatorId,
    'pwdLen=',
    r.pwdLen
  );
}
