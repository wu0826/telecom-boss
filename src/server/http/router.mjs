const METHOD_PATTERN = /^[A-Z]+$/;
const PARAMETER_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const STATIC_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;
const AUTHENTICATION_MODES = new Set(['public', 'required']);

function compilePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.endsWith('/')) {
    throw new TypeError(`Invalid route path: ${path}`);
  }

  const segments = path.slice(1).split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw new TypeError(`Invalid route path: ${path}`);
  }

  const parameterNames = new Set();
  const compiledSegments = segments.map((segment) => {
    if (!segment.startsWith(':')) {
      if (!STATIC_SEGMENT_PATTERN.test(segment)) {
        throw new TypeError(`Invalid static route segment: ${segment}`);
      }
      return { kind: 'static', value: segment };
    }

    const name = segment.slice(1);
    if (!PARAMETER_PATTERN.test(name) || parameterNames.has(name)) {
      throw new TypeError(`Invalid route parameter: ${segment}`);
    }
    parameterNames.add(name);
    return { kind: 'parameter', name };
  });

  return {
    segments: compiledSegments,
    signature: compiledSegments
      .map((segment) => (segment.kind === 'static' ? segment.value : ':'))
      .join('/'),
  };
}

function matchPath(compiledPath, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  const requestSegments = pathname.slice(1).split('/');
  if (requestSegments.length !== compiledPath.segments.length) return null;

  const params = {};
  for (let index = 0; index < compiledPath.segments.length; index += 1) {
    const routeSegment = compiledPath.segments[index];
    const requestSegment = requestSegments[index];
    if (requestSegment.length === 0) return null;
    if (routeSegment.kind === 'static') {
      if (routeSegment.value !== requestSegment) return null;
      continue;
    }
    params[routeSegment.name] = requestSegment;
  }
  return params;
}

export function createRouter() {
  const routes = [];
  const routeKeys = new Set();

  return {
    register({
      method,
      path,
      handler,
      authentication = 'public',
      permission = null,
    }) {
      const normalizedMethod = String(method).toUpperCase();
      if (!METHOD_PATTERN.test(normalizedMethod)) {
        throw new TypeError(`Invalid route method: ${method}`);
      }
      if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
      if (!AUTHENTICATION_MODES.has(authentication)) {
        throw new TypeError(`Invalid authentication mode: ${authentication}`);
      }
      if (authentication === 'required' && !permission) {
        throw new TypeError('Authenticated routes require permission metadata');
      }
      if (permission !== null && !PERMISSION_PATTERN.test(permission)) {
        throw new TypeError(`Invalid route permission: ${permission}`);
      }

      const compiledPath = compilePath(path);
      const routeKey = `${normalizedMethod} ${compiledPath.signature}`;
      if (routeKeys.has(routeKey)) throw new TypeError(`Route already registered: ${method} ${path}`);

      routeKeys.add(routeKey);
      routes.push({
        method: normalizedMethod,
        path,
        compiledPath,
        handler,
        authentication,
        permission,
      });
    },

    resolve(method, pathname) {
      const normalizedMethod = String(method).toUpperCase();
      const pathMatches = [];

      for (const route of routes) {
        const params = matchPath(route.compiledPath, pathname);
        if (params === null) continue;
        pathMatches.push(route);
        if (route.method === normalizedMethod) {
          return {
            kind: 'match',
            handler: route.handler,
            path: route.path,
            params,
            authentication: route.authentication,
            permission: route.permission,
          };
        }
      }

      if (pathMatches.length === 0) return { kind: 'not-found' };
      return {
        kind: 'method-not-allowed',
        allowedMethods: [...new Set(pathMatches.map((route) => route.method))],
      };
    },
  };
}
