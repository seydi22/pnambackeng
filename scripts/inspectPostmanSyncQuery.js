const fs = require('fs');
const path = require('path');
const file = path.join(
  process.env.USERPROFILE || '',
  'Downloads',
  'Moov Money Internal API(Testbed).postman_collection.json'
);
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
function walk(items, acc = []) {
  for (const it of items || []) {
    if (it.request) acc.push(it);
    if (it.item) walk(it.item, acc);
  }
  return acc;
}
const all = walk(j.item);
const sync = all.find(
  (x) =>
    (x.name || '').includes('SyncQueryOrgTxn') ||
    JSON.stringify(x.request || {}).includes('SyncQueryOrgTxn')
);
if (!sync) {
  console.log('no SyncQuery found, names=', all.map((x) => x.name).slice(0, 30));
  process.exit(0);
}
const raw = (sync.request.body && sync.request.body.raw) || '';
const tp = (raw.match(/ThirdPartyID>([^<]+)/) || [])[1];
const idt = (raw.match(/Initiator>[\s\S]*?IdentifierType>([^<]+)/) || [])[1];
const id = (raw.match(/Initiator>[\s\S]*?Identifier>([^<]+)/) || [])[1];
const pwd = (raw.match(/<req:Password>([^<]+)/) || [])[1];
const ts = (raw.match(/Timestamp>([^<]+)/) || [])[1];
const hasResultUrl = /ResultURL>/.test(raw);
console.log('name=', sync.name);
console.log('ThirdPartyID=', tp);
console.log('InitiatorType=', idt);
console.log('Identifier=', id);
console.log('PasswordLen=', pwd && pwd.length);
console.log('Timestamp=', ts);
console.log('hasResultURL=', hasResultUrl);
