/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    // NOTE (Next 14 constraint): this key was renamed to
    // `serverExternalPackages` (moved out of `experimental`) in Next 15.
    // If this project is ever upgraded to Next 15+, remove the
    // `experimental` wrapper and use the top-level key instead:
    //   serverExternalPackages: ['@duckdb/node-api']
    // Leaving it here under `experimental` will silently have no effect
    // on Next 15 without this change.
    serverComponentsExternalPackages: ['@duckdb/node-api'],
  },
}

module.exports = nextConfig
