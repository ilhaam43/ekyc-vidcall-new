import knex from 'knex';
export const createDb = connection => knex({ client: 'pg', connection, pool: { min: 0, max: 10 }, acquireConnectionTimeout: 10000 });
export const now = () => new Date();
export const activeStates = ['waiting', 'assigned', 'preparing_recording', 'ringing', 'active', 'completing'];
