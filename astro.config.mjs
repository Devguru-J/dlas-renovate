import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import sitemapMetadata from './src/data/sitemap-metadata.json' with { type: 'json' };

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
      // 중고차 맞춤 컨설팅은 신차 페이지로 301 통합했으므로(public/_redirects) 함께 뺀다.
      filter: (page) => !/\/(404|consulting-used-car)\/?$/.test(page),

      // 원본 사이트(Yoast)가 제공하던 lastmod와 페이지별 이미지를 되살린다.
      // lastmod는 검색엔진의 재크롤링 우선순위 판단에, 이미지는 이미지 검색 노출에 쓰인다.
      // 데이터는 src/data/sitemap-metadata.json에 스냅샷해 두었다 — 빌드가 원본 서버에
      // 의존하지 않도록 하기 위함이며, 원본이 사라져도 재현 가능하다.
      //
      // 원본 사이트맵에는 미러에 존재하지 않는 이미지 21개가 섞여 있었다(미디어 라이브러리에
      // 첨부됐을 뿐 페이지에 렌더링되지 않는 것들). 그대로 실으면 404를 가리키게 되므로
      // 스냅샷 생성 시 public/ 에 실재하는 것만 남겼다.
      serialize(item) {
        const path = new URL(item.url).pathname;
        const meta = sitemapMetadata[path];
        if (!meta) return item;

        if (meta.lastmod) item.lastmod = meta.lastmod;
        if (meta.images?.length) {
          item.img = meta.images.map((url) => ({ url }));
        }
        return item;
      },
    }),
  ],
});
