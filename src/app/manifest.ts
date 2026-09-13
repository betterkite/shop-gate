import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Shop Gate · 零售经营分析工作台',
    short_name: 'Shop Gate',
    description: '从真实经营行为数据与证据出发，生成、评测和治理可验证的零售经营看板。',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#de5d48',
    icons: [
      {
        src: '/icons/shopgate-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icons/shopgate-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  };
}
