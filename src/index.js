// Ponto de entrada do Worker: /api/* vai para a API; o resto são as telas (embutidas no Worker).
import { onRequest } from './api.js';
import indexHtml from '../public/index.html';
import apiClient from '../public/api-client.txt';
import favicon from '../public/favicon.png';

const STATIC = {
  '/': [indexHtml, 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': [indexHtml, 'text/html; charset=utf-8', 'no-cache'],
  '/api-client.js': [apiClient, 'text/javascript; charset=utf-8', 'no-cache'],
  '/favicon.png': [favicon, 'image/png', 'public, max-age=86400'],
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
      return onRequest({ request, env, params: { path }, ctx });
    }
    const hit = STATIC[url.pathname] || STATIC['/'];
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Método não permitido', { status: 405 });
    return new Response(request.method === 'HEAD' ? null : hit[0], {
      headers: { 'content-type': hit[1], 'cache-control': hit[2], ...SECURITY_HEADERS },
    });
  },
};
