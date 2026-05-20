/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
    // Reduz Router Cache do client: páginas dinâmicas não devem ficar paradas
    // no cache local após autosave de aposta / edição de resultado.
    // Next 14.2+: dynamic = 0s (sem cache), static = 180s.
    staleTimes: { dynamic: 0, static: 180 },
  },
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
};

module.exports = nextConfig;
