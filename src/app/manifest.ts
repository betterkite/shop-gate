import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Shop Gate · 零售经营分析工作台',
    short_name: 'Shop Gate',
    description: '从订单、退款、成本和费用核对经营表现，向经营助手提问并查看账本依据。',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#0e879c',
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
