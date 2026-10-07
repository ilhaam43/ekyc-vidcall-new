import { value, required } from '@ekyc/shared/config';
export function dashboardConfig() {
  const production = value('NODE_ENV') === 'production';
  const mockExternal = !production && value('DASHBOARD_MOCK_EXTERNALS', 'false') === 'true';
  if (production && mockExternal) throw new Error('External mocks are forbidden in production');
  const kongMock = value('DASHBOARD_KONG_MOCK', String(mockExternal)) === 'true';
  if (production && kongMock) throw new Error('Kong mock is forbidden in production');
  return {
    production, mockExternal, kongMock, databaseUrl: required('DATABASE_URL'), valkeyUrl: required('VALKEY_URL'),
    origin: value('DASHBOARD_ORIGIN', 'http://127.0.0.1:5301'), port: Number(value('DASHBOARD_PORT', '5301')),
    masterUrl: value('MASTER_URL', 'http://master:8080'), gatewaySecret: required('GATEWAY_SECRET'),
    kongUrl: value('KONG_ADMIN_URL'), kongToken: value('KONG_ADMIN_TOKEN'), searchUrl: value('ELASTICSEARCH_URL'),
    kongAdminTokenHeader: value('KONG_ADMIN_TOKEN_HEADER', 'Kong-Admin-Token'), kongApiRouteId: value('KONG_API_ROUTE_ID'),
    kongRateLimitPolicy: value('KONG_RATE_LIMIT_POLICY', 'local'), kongRateRedisHost: value('KONG_RATE_REDIS_HOST'),
    kongRateRedisPort: Number(value('KONG_RATE_REDIS_PORT', '6379')), kongRateRedisDatabase: Number(value('KONG_RATE_REDIS_DATABASE', '0')),
    kongRateRedisPassword: value('KONG_RATE_REDIS_PASSWORD'), kongRateRedisUsername: value('KONG_RATE_REDIS_USERNAME'),
    kongRateRedisSsl: value('KONG_RATE_REDIS_SSL', 'false') === 'true', trustKongConsumerHeader: value('KONG_TRUST_CONSUMER_HEADER') === 'true',
    callsUrl: value('CALLS_URL', 'http://calls:5030'),
    searchUser: value('ELASTICSEARCH_USERNAME'), searchPassword: value('ELASTICSEARCH_PASSWORD'),
    emailUrl: value('EMAIL_SERVICE_URL'), emailToken: value('EMAIL_SERVICE_TOKEN'),
    exportBucket: value('DASHBOARD_EXPORT_BUCKET', 'ekyc-dashboard-exports'),
    objectEndpoint: required('OBJECT_ENDPOINT'), objectAccess: required('OBJECT_ACCESS_KEY'), objectSecret: required('OBJECT_SECRET_KEY'),
    legacyDatabaseUrl: value('LEGACY_DATABASE_URL'), encryptionUrl: value('ENCRYPTION_URL'),
  };
}
