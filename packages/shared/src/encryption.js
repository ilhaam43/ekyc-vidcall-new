import { assert } from './errors.js';
import { required } from './config.js';
const columns = ['name', 'id_number', 'phone_number', 'email', 'birth_place', 'birth_date', 'mother_maiden_name'];
export class Encryption {
  constructor(cfg) { this.cfg = cfg; assert(!(cfg.production && cfg.encryptionMock), 500, 'MOCK_ENCRYPTION_FORBIDDEN'); }
  async request(operation, payload) {
    assert(this.cfg.encryptionUrl, 503, 'ENCRYPTION_NOT_CONFIGURED');
    const response = await fetch(`${this.cfg.encryptionUrl}/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    const data = await response.json(); assert(response.ok && data.success, 503, 'ENCRYPTION_UNAVAILABLE'); return data.data;
  }
  async keys(tenant) {
    return this.request('decrypt', { key: required('MASTER_ENCRYPTION_KEY'), IV: required('MASTER_ENCRYPTION_IV'), data: tenant.encryption });
  }
  async transform(operation, tenant, data) {
    if (this.cfg.encryptionMock) return structuredClone(data);
    const keys = await this.keys(tenant); const payload = { key: keys.encryption_key, IV: keys.iv };
    const result = await this.request(operation, { ...payload, data, whitelist: columns });
    for (const [field, whitelist] of [['occupation_detail', ['company_name', 'business_sector', 'position', 'date_start']], ['bank_account', ['account_number', 'card_type']]]) {
      if (data[field]) result[field] = await this.request(operation, { ...payload, data: data[field], whitelist });
    }
    if (data.addresses) {
      result.addresses = {};
      for (const [type, address] of Object.entries(data.addresses)) result.addresses[type] = await this.request(operation, { ...payload, data: address, whitelist: ['address'] });
    }
    return result;
  }
}
