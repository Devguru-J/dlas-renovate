/*
 * 전송 중에는 제출 버튼을 한 번만 받는다.
 *
 * 배경:
 *  - Contact Form 7은 제출 버튼을 잠그지 않는다. 응답이 오기 전에 다시 누르면
 *    누른 횟수만큼 fetch가 나가고, 그만큼 레코드와 CRM 리드가 생긴다.
 *    (실측: 5번 연타 → 요청 5건)
 *  - 테마의 jian.custom.js에도 같은 목적의 가드가 있지만 `.ajax-loader`를 본다.
 *    그 엘리먼트는 CF7 5.x까지의 것이고 6.0.6에는 존재하지 않아(`.wpcf7-spinner`로 바뀜)
 *    조건이 항상 거짓이라 아무것도 막지 못한다. 원본 테마 파일은 건드리지 않고
 *    여기서 6.0.6 기준으로 다시 막는다.
 *
 * 방법:
 *  - 클릭을 캡처 단계에서 먼저 받아, 폼이 이미 `submitting` 상태면 삼킨다.
 *    CF7은 제출 핸들러 안에서 동기적으로 이 클래스를 붙이므로 첫 클릭은 통과한다.
 *  - wpcf7beforesubmit에서 버튼을 disabled로 만들고 wpcf7submit(성공·실패 무관)에서 푼다.
 *  - 네트워크 오류로 응답이 영영 오지 않으면 CF7은 wpcf7submit을 발생시키지 않는다.
 *    그 경우 버튼이 영구히 잠기지 않도록 워치독으로 되돌린다.
 *
 * 이것은 화면 쪽 방어일 뿐이다. 서버도 같은 제출을 중복 저장하지 않는다
 * (src/lib/forms/dedupe.ts + dedupe_key 유니크 인덱스).
 */
(function () {
  'use strict';

  var WATCHDOG_MS = 30000;
  var timers = new WeakMap();

  function buttons(form) {
    return form.querySelectorAll('.wpcf7-submit');
  }

  function lock(form) {
    var list = buttons(form);
    for (var i = 0; i < list.length; i++) {
      list[i].disabled = true;
      list[i].style.opacity = '0.6';
      list[i].style.cursor = 'not-allowed';
    }
    clearTimeout(timers.get(form));
    timers.set(form, setTimeout(function () { unlock(form); }, WATCHDOG_MS));
  }

  function unlock(form) {
    var list = buttons(form);
    for (var i = 0; i < list.length; i++) {
      list[i].disabled = false;
      list[i].style.opacity = '';
      list[i].style.cursor = '';
    }
    clearTimeout(timers.get(form));
    timers.delete(form);
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    var btn = el.closest('.wpcf7-submit');
    if (!btn) return;

    var form = btn.form || btn.closest('form');
    if (!form) return;

    if (btn.disabled || form.classList.contains('submitting')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('wpcf7beforesubmit', function (e) { lock(e.target); }, false);
  document.addEventListener('wpcf7submit', function (e) { unlock(e.target); }, false);
})();
