import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  devToolbar: { enabled: false },
  site: 'https://dlas.co.kr',
  integrations: [
    sitemap({
      // 404 페이지는 색인 대상이 아니므로 제외한다.
      filter: (page) => !/\/404\/?$/.test(page),
    }),
  ],
});
