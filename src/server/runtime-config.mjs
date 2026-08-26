const SUPPORTED_DATABASE_DRIVERS = new Set(['mysql', 'sqlite']);

export function resolveRuntimeDriver(env = process.env) {
  const nodeEnvironment = env.NODE_ENV ?? 'development';
  const databaseDriver = env.DB_DRIVER ?? (nodeEnvironment === 'production' ? 'mysql' : 'sqlite');

  if (!SUPPORTED_DATABASE_DRIVERS.has(databaseDriver)) {
    throw new Error(`Unsupported DB_DRIVER: ${databaseDriver}`);
  }
  if (nodeEnvironment === 'production' && databaseDriver !== 'mysql') {
    throw new Error('Production runtime requires DB_DRIVER=mysql');
  }
  return databaseDriver;
}

export function developmentLoginEnabled(env = process.env) {
  if (env.NODE_ENV === 'production' && env.ENABLE_DEVELOPMENT_LOGIN === 'true') {
    throw new Error('ENABLE_DEVELOPMENT_LOGIN cannot be enabled in production');
  }
  return env.ENABLE_DEVELOPMENT_LOGIN === 'true';
}
