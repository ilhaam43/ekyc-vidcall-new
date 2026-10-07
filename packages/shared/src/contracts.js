import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { AppError } from './errors.js';
const ajv = new Ajv({ allErrors: true, removeAdditional: false });
addFormats(ajv);
const id = { type: 'string', format: 'uuid' };
const text = { type: 'string', minLength: 1, maxLength: 500 };
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
export const schemas = {
  login: object({ username: text, password: { type: 'string', minLength: 1, maxLength: 128 } }, ['username', 'password']),
  password: object({ current_password: text, new_password: { type: 'string', minLength: 12, maxLength: 72 } }, ['current_password', 'new_password']),
  register: object({ user_id: id, actor_id: id, notif_provider: { type: 'array', items: { enum: ['socketio', 'apn'] }, uniqueItems: true }, device_token: { type: 'string', maxLength: 256 } }, ['user_id']),
  decision: object({ outcome: { enum: ['verified', 'not_verified'] }, reason: { type: 'string', maxLength: 2000 } }, ['outcome']),
  consent: object({ accepted: { const: true }, version: { const: 'recording-v1' } }, ['accepted', 'version']),
  recordingEvent: object({ event_id: id, call_id: id, recording_id: id, status: { enum: ['started', 'stopped', 'failed', 'heartbeat'] }, worker_id: text }, ['event_id', 'call_id', 'recording_id', 'status', 'worker_id']),
  recordingStored: object({ event_id: id, recording_id: id, key: { type: 'string', maxLength: 1024 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 1 } }, ['event_id', 'recording_id', 'key', 'sha256', 'bytes']),
  customer: object({ id: id, actor_id: id, name: text, id_number: text, phone_number: text, email: { type: 'string', format: 'email' }, birth_date: { type: 'string', format: 'date' }, birth_place: text, sex: { enum: [0, 1] }, marital_status: text, religion: text, mother_maiden_name: text, occupation_id: { type: ['integer', 'null'] }, occupation_detail: { type: 'object' }, addresses: { type: 'object' }, fund: { type: 'object' }, bank_account: { type: 'object' }, face_verification_score: { type: 'number', minimum: 0, maximum: 1 }, face_verification_epsilon: { type: 'number', minimum: 0, maximum: 1 } }),
};
export function validate(name, data) {
  const check = ajv.getSchema(name) || ajv.addSchema(schemas[name], name).getSchema(name);
  if (!check(data)) throw new AppError(422, 'VALIDATION_ERROR', check.errors.map(e => `${e.instancePath || '/'} ${e.message}`).join('; '));
  return data;
}
export const body = name => (req, _res, next) => { validate(name, req.body); next(); };
export const events = ['queue.change', 'call.start', 'call.end', 'call.missed', 'call.rejected', 'call.state', 'online.changed'];
