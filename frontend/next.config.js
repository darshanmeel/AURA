/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['@duckdb/node-api'],
  },
}

module.exports = nextConfig
