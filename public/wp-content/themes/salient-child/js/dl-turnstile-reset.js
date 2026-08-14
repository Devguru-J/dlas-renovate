/*
 * 제출이 끝날 때마다 Turnstile 토큰을 새로 받는다.
 *
 * 왜 필요한가:
 *  - Turnstile 토큰은 1회용이다. 서버가 siteverify로 한 번 검증하면 그 토큰은 소진된다.
 *  - CF7은 제출에 실패해도(검증 실패 등) 폼을 그대로 두고 재제출을 허용한다.
 *    그때 소진된 토큰을 그대로 다시 보내면 서버가 스팸으로 판정해, 차종 하나 빠뜨린
 *    정상 고객이 두 번째 제출부터 영영 막히게 된다.
 *  - 그래서 성공·실패 무관하게 제출이 끝나면 위젯을 리셋해 새 토큰을 받아둔다.
 *
 * invisible 위젯이라 화면에는 아무것도 그리지 않는다. 원본 사이트의 겉모습은 그대로다.
 */
(function () {
  'use strict';

  document.addEventListener(
    'wpcf7submit',
    function (e) {
      if (typeof window.turnstile === 'undefined') return;

      var form = e.target;
      var widget = form.querySelector('.cf-turnstile');
      if (!widget) return;

      try {
        // 렌더된 위젯 id를 넘겨야 그 폼의 위젯만 리셋된다. 자동 렌더 위젯은
        // data-widget-id 없이도 엘리먼트로 찾을 수 있다.
        window.turnstile.reset(widget);
      } catch (err) {
        // 리셋에 실패하면 다음 제출이 스팸으로 막힐 수 있으므로 조용히 넘기지 않고 남긴다.
        if (window.console && console.warn) console.warn('turnstile reset 실패', err);
      }
    },
    false,
  );
})();
