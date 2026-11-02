function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Masque Password / SecurityCredential dans un XML SOAP CPS.
 * Ne jamais persister ni renvoyer le XML brut contenant des secrets.
 */
function redactCpsXml(xml) {
  if (xml == null || xml === '') return xml;
  return String(xml)
    .replace(
      /<(?:[\w.-]+:)?Password\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?Password>/gi,
      '<Password>***REDACTED***</Password>'
    )
    .replace(
      /<(?:[\w.-]+:)?SecurityCredential\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?SecurityCredential>/gi,
      '<SecurityCredential>***REDACTED***</SecurityCredential>'
    );
}

function soapCallMeta(xml, resp, parsed) {
  return {
    httpStatus: resp.status,
    // XML redacte uniquement (jamais de secrets en clair cote appelant)
    requestXml: redactCpsXml(xml),
    responseXml: redactCpsXml(resp.body),
    ...parsed,
  };
}

function nowTimestamp() {
  // yyyyMMddHHmmss
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function makeConversationId(prefix = 'AG') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function pickFirst(text, re) {
  const m = String(text).match(re);
  return m ? m[1] : '';
}

function parseSoapResult(xml) {
  // Tolérant: les balises varient selon mapping CPS / namespaces.
  const resultCode =
    pickFirst(xml, /<\w*:ResultCode>([^<]+)<\/\w*:ResultCode>/) ||
    pickFirst(xml, /<ResultCode>([^<]+)<\/ResultCode>/);
  const resultDesc =
    pickFirst(xml, /<\w*:ResultDesc>([^<]+)<\/\w*:ResultDesc>/) ||
    pickFirst(xml, /<ResultDesc>([^<]+)<\/ResultDesc>/);
  const conversationId =
    pickFirst(xml, /<\w*:ConversationID>([^<]+)<\/\w*:ConversationID>/) ||
    pickFirst(xml, /<ConversationID>([^<]+)<\/ConversationID>/);
  const transactionId =
    pickFirst(xml, /<\w*:TransactionID>([^<]+)<\/\w*:TransactionID>/) ||
    pickFirst(xml, /<TransactionID>([^<]+)<\/TransactionID>/);

  return { resultCode, resultDesc, conversationId, transactionId };
}

function buildSoapHeaders({ soapAction } = {}) {
  const headers = {
    'Content-Type': 'text/xml; charset=utf-8',
    'Accept': 'text/xml',
  };

  // Beaucoup de stacks SOAP (CXF/Axis) routent l’opération via SOAPAction.
  // Si l’action n’est pas fournie, certains serveurs renvoient "WSA Action = null".
  // CPS_SOAP_ACTION (si défini) doit être PRIORITAIRE.
  // NOTE: si CPS_SOAP_ACTION est défini mais vide (ex: CPS_SOAP_ACTION=),
  // on l’ignore pour permettre l’auto-détection par commande (CreateTopOrg, CreateOrgOperator, ...).
  if (process.env.CPS_SOAP_ACTION !== undefined) {
    const envAction = String(process.env.CPS_SOAP_ACTION).trim();
    if (envAction !== '') {
      headers.SOAPAction = envAction;
    }
  } else if (soapAction !== undefined) {
    const action = String(soapAction);
    headers.SOAPAction = action === '' ? '""' : action;
  }

  return headers;
}

async function postSoap({ url, xml, timeoutMs = 60000, soapAction }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildSoapHeaders({ soapAction }),
      },
      body: xml,
      signal: controller.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function buildCreateTopOrgXml({
  thirdPartyId,
  password,
  initiatorIdentifierType,
  initiatorIdentifier,
  initiatorSecurityCredential,
  receiverIdentifierType,
  receiverIdentifier,
  shortCode,
  organizationName,
  msisdn,
  productId,
  preferredNotificationLanguage = 'fr',
  preferredNotificationChannel = '1001',
  countryValue,
  cityValue,
  nifValue,
  commercialRegisterValue,
  organizationTypeValue,
  contactTypeValue,
  contactFirstNameValue,
  remark = '',
  version = '1.0',
}) {
  const timestamp = nowTimestamp();
  const originatorConversationId = `S_${timestamp}`;

  // XML aligné 1:1 sur le template Postman "CreateTopOrg".
  const callerType = process.env.CPS_CALLER_TYPE || '2';
  const keyOwner = process.env.CPS_KEY_OWNER || '1';
  const resultURL =
    process.env.CPS_RESULT_URL || 'http://10.74.189.145:8087/mockAPIResultMgrBinding';
  const trustLevel = process.env.CPS_TRUST_LEVEL || '1';

  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://cps.huawei.com/synccpsinterface/api_requestmgr" xmlns:req="http://cps.huawei.com/synccpsinterface/request" xmlns:com="http://cps.huawei.com/synccpsinterface/common" xmlns:cus="http://cps.huawei.com/cpsinterface/customizedrequest">
  <soapenv:Header/>
  <soapenv:Body>
    <api:Request>
      <req:Header>
        <req:Version>${escapeXml(version)}</req:Version>
        <req:CommandID>CreateTopOrg</req:CommandID>
        <req:OriginatorConversationID>${escapeXml(originatorConversationId)}</req:OriginatorConversationID>
        <req:Caller>
          <req:CallerType>${escapeXml(callerType)}</req:CallerType>
          <req:ThirdPartyID>${escapeXml(thirdPartyId)}</req:ThirdPartyID>
          <req:Password>${escapeXml(password)}</req:Password>
          <req:ResultURL>${escapeXml(resultURL)}</req:ResultURL>
        </req:Caller>
        <req:KeyOwner>${escapeXml(keyOwner)}</req:KeyOwner>
        <req:Timestamp>${escapeXml(timestamp)}</req:Timestamp>
      </req:Header>
      <req:Body>
        <req:Identity>
          <req:Initiator>
            <req:IdentifierType>${escapeXml(initiatorIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(initiatorIdentifier)}</req:Identifier>
            <req:SecurityCredential>${escapeXml(initiatorSecurityCredential)}</req:SecurityCredential>
          </req:Initiator>
        </req:Identity>
        <req:CreateTopOrgRequest>
          <req:ShortCode>${escapeXml(shortCode)}</req:ShortCode>
          <req:OrganizationName>${escapeXml(organizationName)}</req:OrganizationName>
          <req:TrustLevel>${escapeXml(trustLevel)}</req:TrustLevel>
          <req:SimpleKYCUpdateData>
            <req:AddField>
              <com:KYCName>[KYC][Address Details][Country]</com:KYCName>
              <com:KYCValue>${escapeXml(countryValue)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Address Details][City]</com:KYCName>
              <com:KYCValue>${escapeXml(cityValue)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Corporate Information][NIF]</com:KYCName>
              <com:KYCValue>${escapeXml(nifValue)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Corporate Information][Commercial Register]</com:KYCName>
              <com:KYCValue>${escapeXml(commercialRegisterValue)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Organization Type][Organization Type]</com:KYCName>
              <com:KYCValue>${escapeXml(organizationTypeValue)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Organization Contact Details][Contact Type]</com:KYCName>
              <com:KYCValue>${escapeXml(contactTypeValue)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Organization Contact Details][Contact First Name]</com:KYCName>
              <com:KYCValue>${escapeXml(contactFirstNameValue)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Contact Details][Preferred Notification Channel]</com:KYCName>
              <com:KYCValue>${escapeXml(preferredNotificationChannel)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Contact Details][Notification Receiving MSISDN]</com:KYCName>
              <com:KYCValue>${escapeXml(msisdn)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Contact Details][Preferred Notification Language]</com:KYCName>
              <com:KYCValue>${escapeXml(preferredNotificationLanguage)}</com:KYCValue>
            </req:AddField>
          </req:SimpleKYCUpdateData>
          <req:UpdateProductsData>
            <req:AddProduct>
              <req:ProductID>${escapeXml(productId)}</req:ProductID>
            </req:AddProduct>
          </req:UpdateProductsData>
        </req:CreateTopOrgRequest>
      </req:Body>
    </api:Request>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildCreateOrgOperatorXml({
  thirdPartyId,
  password,
  initiatorIdentifierType,
  initiatorIdentifier,
  initiatorSecurityCredential,
  receiverIdentifierType,
  receiverIdentifier,
  shortCode,
  languageCode = 'fr',
  authenticationType = 'HANDSET',
  userName,
  operatorId,
  msisdn,
  roleId,
  roleEffectiveDate, // yyyyMMdd
  roleExpiryDate = '',
  firstName,
  preferredNotificationChannel = '1001',
  notificationMsisdn,
  idTypeValue = '01',
  idNumber,
  documentReceived = 'Y',
  version = '1.0',
}) {
  const timestamp = nowTimestamp();
  const originatorConversationId = `S_${timestamp}`;

  // XML aligné 1:1 sur le template Postman "CreateOrgOperator".
  const callerType = process.env.CPS_CALLER_TYPE || '2';
  const keyOwner = process.env.CPS_KEY_OWNER || '1';
  const resultURL =
    process.env.CPS_RESULT_URL || 'http://10.74.189.145:8087/mockAPIResultMgrBinding';
  const roleExpiry = roleExpiryDate || process.env.CPS_OPERATOR_ROLE_EXPIRY_DATE || '20990320';

  const msisdnXml = msisdn ? `<com:MSISDN>${escapeXml(msisdn)}</com:MSISDN>` : ``;
  const notificationMsisdnField = `<req:AddField>
              <com:KYCName>[KYC][Contact Details][Notification Receiving MSISDN]</com:KYCName>
              <com:KYCValue>${escapeXml(notificationMsisdn)}</com:KYCValue>
            </req:AddField>`;

  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://cps.huawei.com/synccpsinterface/api_requestmgr" xmlns:req="http://cps.huawei.com/synccpsinterface/request" xmlns:com="http://cps.huawei.com/synccpsinterface/common" xmlns:cus="http://cps.huawei.com/cpsinterface/customizedrequest">
  <soapenv:Header/>
  <soapenv:Body>
    <api:Request>
      <req:Header>
        <req:Version>${escapeXml(version)}</req:Version>
        <req:CommandID>CreateOrgOperator</req:CommandID>
        <req:OriginatorConversationID>${escapeXml(originatorConversationId)}</req:OriginatorConversationID>
        <req:Caller>
          <req:CallerType>${escapeXml(callerType)}</req:CallerType>
          <req:ThirdPartyID>${escapeXml(thirdPartyId)}</req:ThirdPartyID>
          <req:Password>${escapeXml(password)}</req:Password>
          <req:ResultURL>${escapeXml(resultURL)}</req:ResultURL>
        </req:Caller>
        <req:KeyOwner>${escapeXml(keyOwner)}</req:KeyOwner>
        <req:Timestamp>${escapeXml(timestamp)}</req:Timestamp>
      </req:Header>
      <req:Body>
        <req:Identity>
          <req:Initiator>
            <req:IdentifierType>${escapeXml(initiatorIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(initiatorIdentifier)}</req:Identifier>
            <req:SecurityCredential>${escapeXml(initiatorSecurityCredential)}</req:SecurityCredential>
          </req:Initiator>
        </req:Identity>
        <req:CreateOrgOperatorRequest>
          <req:ShortCode>${escapeXml(shortCode)}</req:ShortCode>
          <req:LanguageCode>${escapeXml(languageCode)}</req:LanguageCode>
          <req:RoleUpdateData>
            <req:RoleItem>
              <req:RoleID>${escapeXml(roleId)}</req:RoleID>
              <req:EffectiveDate>${escapeXml(roleEffectiveDate)}</req:EffectiveDate>
              <req:ExpiryDate>${escapeXml(roleExpiry)}</req:ExpiryDate>
            </req:RoleItem>
          </req:RoleUpdateData>
          <req:AuthenticationTypeData>
            <com:AuthenticationItem>
              <com:AuthenticationType>${escapeXml(authenticationType)}</com:AuthenticationType>
              <com:UserName>${escapeXml(userName)}</com:UserName>
              <com:OperatorID>${escapeXml(operatorId)}</com:OperatorID>
              ${msisdnXml}
            </com:AuthenticationItem>
          </req:AuthenticationTypeData>
          <req:SimpleKYCUpdateData>
            <req:AddField>
              <com:KYCName>[KYC][Personal Details][First Name]</com:KYCName>
              <com:KYCValue>${escapeXml(firstName)}</com:KYCValue>
            </req:AddField>
            <req:AddField>
              <com:KYCName>[KYC][Contact Details][Preferred Notification Channel]</com:KYCName>
              <com:KYCValue>${escapeXml(preferredNotificationChannel)}</com:KYCValue>
            </req:AddField>
            ${notificationMsisdnField}
          </req:SimpleKYCUpdateData>
          <req:UpdateIDDetails>
            <req:AddIDRecord>
              <com:IDTypeValue>${escapeXml(idTypeValue)}</com:IDTypeValue>
              <com:IDNumber>${escapeXml(idNumber)}</com:IDNumber>
              <com:DocumentReceived>${escapeXml(documentReceived)}</com:DocumentReceived>
            </req:AddIDRecord>
          </req:UpdateIDDetails>
        </req:CreateOrgOperatorRequest>
      </req:Body>
    </api:Request>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function todayYYYYMMDD() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function buildQueryOrgOperatorInfoXml({
  thirdPartyId,
  password,
  initiatorIdentifierType,
  initiatorIdentifier,
  initiatorSecurityCredential,
  operatorIdentifierType,
  operatorIdentifier,
  shortCode,
  version = '1.0',
}) {
  const timestamp = nowTimestamp();
  const originatorConversationId = `S_${timestamp}`;

  const callerType = process.env.CPS_CALLER_TYPE || '2';
  const keyOwner = process.env.CPS_KEY_OWNER || '1';

  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://cps.huawei.com/synccpsinterface/api_requestmgr" xmlns:req="http://cps.huawei.com/synccpsinterface/request" xmlns:com="http://cps.huawei.com/synccpsinterface/common" xmlns:cus="http://cps.huawei.com/cpsinterface/customizedrequest">
  <soapenv:Header/>
  <soapenv:Body>
    <api:Request>
      <req:Header>
        <req:Version>${escapeXml(version)}</req:Version>
        <req:CommandID>QueryOrgOperatorInfo</req:CommandID>
        <req:OriginatorConversationID>${escapeXml(originatorConversationId)}</req:OriginatorConversationID>
        <req:Caller>
          <req:CallerType>${escapeXml(callerType)}</req:CallerType>
          <req:ThirdPartyID>${escapeXml(thirdPartyId)}</req:ThirdPartyID>
          <req:Password>${escapeXml(password)}</req:Password>
        </req:Caller>
        <req:KeyOwner>${escapeXml(keyOwner)}</req:KeyOwner>
        <req:Timestamp>${escapeXml(timestamp)}</req:Timestamp>
      </req:Header>
      <req:Body>
        <req:Identity>
          <req:Initiator>
            <req:IdentifierType>${escapeXml(initiatorIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(initiatorIdentifier)}</req:Identifier>
            <req:SecurityCredential>${escapeXml(initiatorSecurityCredential)}</req:SecurityCredential>
          </req:Initiator>
          <req:ReceiverParty>
            <req:IdentifierType>${escapeXml(operatorIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(operatorIdentifier)}</req:Identifier>
            <req:ShortCode>${escapeXml(shortCode)}</req:ShortCode>
          </req:ReceiverParty>
        </req:Identity>
        <req:QueryOrgOperatorInfoRequest/>
      </req:Body>
    </api:Request>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildQueryCustomerInfoXml({
  thirdPartyId,
  password,
  initiatorIdentifierType,
  initiatorIdentifier,
  initiatorSecurityCredential,
  receiverIdentifierType,
  receiverIdentifier,
  version = '1.0',
}) {
  const timestamp = nowTimestamp();
  const originatorConversationId = `S_${timestamp}`;

  const callerType = process.env.CPS_CALLER_TYPE || '2';
  const keyOwner = process.env.CPS_KEY_OWNER || '1';

  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://cps.huawei.com/synccpsinterface/api_requestmgr" xmlns:req="http://cps.huawei.com/synccpsinterface/request" xmlns:com="http://cps.huawei.com/synccpsinterface/common" xmlns:cus="http://cps.huawei.com/cpsinterface/customizedrequest">
  <soapenv:Header/>
  <soapenv:Body>
    <api:Request>
      <req:Header>
        <req:Version>${escapeXml(version)}</req:Version>
        <req:CommandID>QueryCustomerInfo</req:CommandID>
        <req:OriginatorConversationID>${escapeXml(originatorConversationId)}</req:OriginatorConversationID>
        <req:Caller>
          <req:CallerType>${escapeXml(callerType)}</req:CallerType>
          <req:ThirdPartyID>${escapeXml(thirdPartyId)}</req:ThirdPartyID>
          <req:Password>${escapeXml(password)}</req:Password>
        </req:Caller>
        <req:KeyOwner>${escapeXml(keyOwner)}</req:KeyOwner>
        <req:Timestamp>${escapeXml(timestamp)}</req:Timestamp>
      </req:Header>
      <req:Body>
        <req:Identity>
          <req:Initiator>
            <req:IdentifierType>${escapeXml(initiatorIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(initiatorIdentifier)}</req:Identifier>
            <req:SecurityCredential>${escapeXml(initiatorSecurityCredential)}</req:SecurityCredential>
          </req:Initiator>
          <req:ReceiverParty>
            <req:IdentifierType>${escapeXml(receiverIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(receiverIdentifier)}</req:Identifier>
          </req:ReceiverParty>
        </req:Identity>
        <req:QueryCustomerInfoRequest/>
      </req:Body>
    </api:Request>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function cpsCreateTopOrg({ url, payload }) {
  const xml = buildCreateTopOrgXml(payload);
  const soapActionMode = (process.env.CPS_SOAP_ACTION_MODE || 'command').toLowerCase();
  const soapAction =
    process.env.CPS_SOAP_ACTION !== undefined
      ? undefined
      : soapActionMode === 'none'
        ? undefined
        : soapActionMode === 'empty'
          ? ''
          : 'CreateTopOrg';
  const resp = await postSoap({ url, xml, soapAction, timeoutMs: payload.timeoutMs || 60000 });
  const parsed = parseSoapResult(resp.body);
  return soapCallMeta(xml, resp, parsed);
}

async function cpsCreateOrgOperator({ url, payload }) {
  const xml = buildCreateOrgOperatorXml(payload);
  const soapActionMode = (process.env.CPS_SOAP_ACTION_MODE || 'command').toLowerCase();
  const soapAction =
    process.env.CPS_SOAP_ACTION !== undefined
      ? undefined
      : soapActionMode === 'none'
        ? undefined
        : soapActionMode === 'empty'
          ? ''
          : 'CreateOrgOperator';
  const resp = await postSoap({ url, xml, soapAction, timeoutMs: payload.timeoutMs || 60000 });
  const parsed = parseSoapResult(resp.body);
  return soapCallMeta(xml, resp, parsed);
}

async function cpsQueryOrgOperatorInfo({ url, payload }) {
  const xml = buildQueryOrgOperatorInfoXml(payload);
  const resp = await postSoap({ url, xml, timeoutMs: payload.timeoutMs || 60000 });
  const parsed = parseSoapResult(resp.body);
  return soapCallMeta(xml, resp, parsed);
}

async function cpsQueryCustomerInfo({ url, payload }) {
  const xml = buildQueryCustomerInfoXml(payload);
  const resp = await postSoap({ url, xml, timeoutMs: payload.timeoutMs || 60000 });
  const parsed = parseSoapResult(resp.body);
  return soapCallMeta(xml, resp, parsed);
}

function buildStandardPrevalidationXml({
  thirdPartyId,
  password,
  initiatorIdentifierType,
  initiatorIdentifier,
  initiatorSecurityCredential,
  primaryPartyIdentifierType = '4',
  primaryPartyIdentifier,
  receiverIdentifierType = '1',
  receiverIdentifier,
  amount,
  currency = 'MRU',
  service = 'Promotional Commission',
  prevalidationType = '1',
  remark = 'Agent promotional commission',
  originatorConversationId,
  timestamp,
}) {
  const callerType = process.env.CPS_CALLER_TYPE || '2';
  const keyOwner = process.env.CPS_KEY_OWNER || '1';
  const convId = originatorConversationId || makeConversationId('PREV');
  const ts = timestamp || nowTimestamp();

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://cps.huawei.com/synccpsinterface/api_requestmgr" xmlns:req="http://cps.huawei.com/synccpsinterface/request" xmlns:com="http://cps.huawei.com/synccpsinterface/common">
  <soapenv:Header/>
  <soapenv:Body>
    <api:Request>
      <req:Header>
        <req:Version>1.0</req:Version>
        <req:CommandID>StandardPrevalidation</req:CommandID>
        <req:OriginatorConversationID>${escapeXml(convId)}</req:OriginatorConversationID>
        <req:Caller>
          <req:CallerType>${escapeXml(callerType)}</req:CallerType>
          <req:ThirdPartyID>${escapeXml(thirdPartyId)}</req:ThirdPartyID>
          <req:Password>${escapeXml(password)}</req:Password>
        </req:Caller>
        <req:KeyOwner>${escapeXml(keyOwner)}</req:KeyOwner>
        <req:Timestamp>${escapeXml(ts)}</req:Timestamp>
      </req:Header>
      <req:Body>
        <req:Identity>
          <req:Initiator>
            <req:IdentifierType>${escapeXml(initiatorIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(initiatorIdentifier)}</req:Identifier>
            <req:SecurityCredential>${escapeXml(initiatorSecurityCredential)}</req:SecurityCredential>
          </req:Initiator>
          <req:PrimaryParty>
            <req:IdentifierType>${escapeXml(primaryPartyIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(primaryPartyIdentifier)}</req:Identifier>
          </req:PrimaryParty>
          <req:ReceiverParty>
            <req:IdentifierType>${escapeXml(receiverIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(receiverIdentifier)}</req:Identifier>
          </req:ReceiverParty>
        </req:Identity>
        <req:StandardPrevalidationRequest>
          <req:RequestContext>
            <req:Parameter>
              <com:key>Service</com:key>
              <com:value>${escapeXml(service)}</com:value>
            </req:Parameter>
            <req:Parameter>
              <com:key>Currency</com:key>
              <com:value>${escapeXml(currency)}</com:value>
            </req:Parameter>
            <req:Parameter>
              <com:key>Amount</com:key>
              <com:value>${escapeXml(amount)}</com:value>
            </req:Parameter>
            <req:Parameter>
              <com:key>PrevalidationType</com:key>
              <com:value>${escapeXml(prevalidationType)}</com:value>
            </req:Parameter>
          </req:RequestContext>
        </req:StandardPrevalidationRequest>
        <req:Remark>${escapeXml(remark)}</req:Remark>
      </req:Body>
    </api:Request>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildInitPromotionalCommissionXml({
  thirdPartyId,
  password,
  initiatorIdentifierType,
  initiatorIdentifier,
  initiatorSecurityCredential,
  primaryPartyIdentifierType = '4',
  primaryPartyIdentifier,
  receiverIdentifierType = '1',
  receiverIdentifier,
  amount,
  currency = 'MRU',
  originatorConversationId,
  timestamp,
}) {
  const callerType = process.env.CPS_CALLER_TYPE || '2';
  const keyOwner = process.env.CPS_KEY_OWNER || '1';
  const convId = originatorConversationId || makeConversationId('PAY');
  const ts = timestamp || nowTimestamp();

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <api:Request xmlns:api="http://cps.huawei.com/synccpsinterface/api_requestmgr" xmlns:req="http://cps.huawei.com/synccpsinterface/request">
      <req:Header>
        <req:Version>1.0</req:Version>
        <req:CommandID>InitTrans_Promotional Commission</req:CommandID>
        <req:OriginatorConversationID>${escapeXml(convId)}</req:OriginatorConversationID>
        <req:Caller>
          <req:CallerType>${escapeXml(callerType)}</req:CallerType>
          <req:ThirdPartyID>${escapeXml(thirdPartyId)}</req:ThirdPartyID>
          <req:Password>${escapeXml(password)}</req:Password>
        </req:Caller>
        <req:KeyOwner>${escapeXml(keyOwner)}</req:KeyOwner>
        <req:Timestamp>${escapeXml(ts)}</req:Timestamp>
      </req:Header>
      <req:Body>
        <req:Identity>
          <req:Initiator>
            <req:IdentifierType>${escapeXml(initiatorIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(initiatorIdentifier)}</req:Identifier>
            <req:SecurityCredential>${escapeXml(initiatorSecurityCredential)}</req:SecurityCredential>
          </req:Initiator>
          <req:PrimaryParty>
            <req:IdentifierType>${escapeXml(primaryPartyIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(primaryPartyIdentifier)}</req:Identifier>
          </req:PrimaryParty>
          <req:ReceiverParty>
            <req:IdentifierType>${escapeXml(receiverIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(receiverIdentifier)}</req:Identifier>
          </req:ReceiverParty>
        </req:Identity>
        <req:TransactionRequest>
          <req:Parameters>
            <req:Amount>${escapeXml(amount)}</req:Amount>
            <req:Currency>${escapeXml(currency)}</req:Currency>
          </req:Parameters>
        </req:TransactionRequest>
      </req:Body>
    </api:Request>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildSyncQueryOrgTxnXml({
  thirdPartyId,
  password,
  initiatorIdentifierType,
  initiatorIdentifier,
  initiatorSecurityCredential,
  orgIdentifierType = '4',
  orgIdentifier,
  startDateTime,
  endDateTime,
  transactionStatus = 'Completed',
  currency = 'MRU',
  accountType = 'Organization E-Money Account',
  originatorConversationId,
  timestamp,
}) {
  const callerType = process.env.CPS_CALLER_TYPE || '2';
  const keyOwner = process.env.CPS_KEY_OWNER || '1';
  const ts = timestamp || process.env.CPS_FIXED_TIMESTAMP || nowTimestamp();
  // Postman SyncQuery: OriginatorConversationID = S_X2013012921001
  const convId = originatorConversationId || `S_X${ts}`;

  // Aligne Postman SyncQueryOrgTxn : pas de ResultURL dans Caller.
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="http://cps.huawei.com/synccpsinterface/api_requestmgr" xmlns:req="http://cps.huawei.com/synccpsinterface/request" xmlns:com="http://cps.huawei.com/synccpsinterface/common">
  <soapenv:Header/>
  <soapenv:Body>
    <api:Request>
      <req:Header>
        <req:Version>1.0</req:Version>
        <req:CommandID>SyncQueryOrgTxn</req:CommandID>
        <req:OriginatorConversationID>${escapeXml(convId)}</req:OriginatorConversationID>
        <req:Caller>
          <req:CallerType>${escapeXml(callerType)}</req:CallerType>
          <req:ThirdPartyID>${escapeXml(thirdPartyId)}</req:ThirdPartyID>
          <req:Password>${escapeXml(password)}</req:Password>
        </req:Caller>
        <req:KeyOwner>${escapeXml(keyOwner)}</req:KeyOwner>
        <req:Timestamp>${escapeXml(ts)}</req:Timestamp>
      </req:Header>
      <req:Body>
        <req:Identity>
          <req:Initiator>
            <req:IdentifierType>${escapeXml(initiatorIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(initiatorIdentifier)}</req:Identifier>
            <req:SecurityCredential>${escapeXml(initiatorSecurityCredential)}</req:SecurityCredential>
          </req:Initiator>
          <req:ReceiverParty>
            <req:IdentifierType>${escapeXml(orgIdentifierType)}</req:IdentifierType>
            <req:Identifier>${escapeXml(orgIdentifier)}</req:Identifier>
          </req:ReceiverParty>
        </req:Identity>
        <req:SyncQueryOrgTxnRequest>
          <req:AccountType>${escapeXml(accountType)}</req:AccountType>
          <req:StartDateTime>${escapeXml(startDateTime)}</req:StartDateTime>
          <req:EndDateTime>${escapeXml(endDateTime)}</req:EndDateTime>
          <req:TransactionStatus>${escapeXml(transactionStatus)}</req:TransactionStatus>
          <req:Currency>${escapeXml(currency)}</req:Currency>
        </req:SyncQueryOrgTxnRequest>
      </req:Body>
    </api:Request>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function cpsStandardPrevalidation({ url, payload }) {
  const xml = buildStandardPrevalidationXml(payload);
  const resp = await postSoap({
    url,
    xml,
    soapAction: 'StandardPrevalidation',
    timeoutMs: payload.timeoutMs || 60000,
  });
  const parsed = parseSoapResult(resp.body);
  return soapCallMeta(xml, resp, parsed);
}

async function cpsInitPromotionalCommission({ url, payload }) {
  const xml = buildInitPromotionalCommissionXml(payload);
  const resp = await postSoap({
    url,
    xml,
    soapAction: 'InitTrans_Promotional Commission',
    timeoutMs: payload.timeoutMs || 60000,
  });
  const parsed = parseSoapResult(resp.body);
  return soapCallMeta(xml, resp, parsed);
}

async function cpsSyncQueryOrgTxn({ url, payload }) {
  const xml = buildSyncQueryOrgTxnXml(payload);
  // Postman testbed: aucun header SOAPAction (headers []).
  const resp = await postSoap({
    url,
    xml,
    soapAction: undefined,
    timeoutMs: payload.timeoutMs || 60000,
  });
  const parsed = parseSoapResult(resp.body);
  const body = String(resp.body || '');

  // Reponse Postman: TransactionItem + ReceiptNumber + NbrOfTotal (pas forcement TransactionID).
  const nbrTotal =
    Number(
      (body.match(/<(?:\w*:)?NbrOfTotal>(\d+)<\/(?:\w*:)?NbrOfTotal>/i) || [])[1] || ''
    ) || 0;
  const nbrReturned =
    Number(
      (body.match(/<(?:\w*:)?NbrOfReturned>(\d+)<\/(?:\w*:)?NbrOfReturned>/i) || [])[1] ||
        ''
    ) || 0;
  const itemCount = (body.match(/<(?:\w*:)?TransactionItem\b/gi) || []).length;
  const receiptCount = (body.match(/<(?:\w*:)?ReceiptNumber>/gi) || []).length;
  const legacyTxnIdCount = (body.match(/<(?:\w*:)?TransactionID>/gi) || []).length;
  const transactionCount = Math.max(nbrTotal, nbrReturned, itemCount, receiptCount, legacyTxnIdCount);

  return {
    ...soapCallMeta(xml, resp, parsed),
    transactionCount,
    hasCompletedTransactions: transactionCount > 0 && String(parsed.resultCode) === '0',
  };
}

module.exports = {
  cpsCreateTopOrg,
  cpsCreateOrgOperator,
  cpsQueryOrgOperatorInfo,
  cpsQueryCustomerInfo,
  cpsStandardPrevalidation,
  cpsInitPromotionalCommission,
  cpsSyncQueryOrgTxn,
  todayYYYYMMDD,
  redactCpsXml,
  nowTimestamp,
};

