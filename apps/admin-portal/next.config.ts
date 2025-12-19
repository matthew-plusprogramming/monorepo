import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: 'export',
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@ui/components'],
};

export default nextConfig;
