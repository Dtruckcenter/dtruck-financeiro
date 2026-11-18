// Ponto de entrada do Worker: /api/* vai para a API; o resto é servido da pasta public/.
import { onRequest } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
      return onRequest({ request, env, params: { path }, ctx });
    }
    return env.ASSETS.fetch(request);
  },
};
