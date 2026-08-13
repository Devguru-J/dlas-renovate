/*
 * 연락처 입력칸의 "010-" 접두사를 어떤 경우에도 유지한다.
 *
 * 배경:
 *  - 접두사는 마크업에 있는 값이 아니라 jian.custom.js가 만드는 Cleave 인스턴스의
 *    prefix 옵션으로 붙는다. .your_phone 필드의 HTML value는 빈 문자열이다.
 *  - Contact Form 7은 제출에 성공하면 form.reset()을 호출한다. 리셋은 값을 HTML의
 *    value 속성으로 되돌리므로 접두사가 사라진 빈 칸이 된다.
 *  - 더 나쁜 것은 Cleave가 내부 raw 값을 그대로 들고 있다는 점이다. 리셋 뒤 빈 칸에
 *    숫자 하나만 입력해도 직전 제출자의 번호 전체가 되살아난다(예: "0" -> "010-1234-5678").
 *    다음 사람이 이전 사람의 번호를 그대로 제출할 수 있는 상태다.
 *
 * 해결:
 *  값을 접두사로 되돌린 뒤 input 이벤트를 흘려보낸다. Cleave가 그 이벤트를 받아
 *  내부 상태를 다시 계산하므로 DOM과 내부 상태가 함께 정리된다.
 */
(function () {
  'use strict';

  var PREFIX = '010-';
  var SELECTOR = 'input.your_phone';

  function restore(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var inputs = scope.querySelectorAll(SELECTOR);

    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.value === PREFIX) continue;
      el.value = PREFIX;
      // Cleave가 이 이벤트를 받아 내부 raw 값까지 재동기화한다.
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // CF7은 모든 제출 결과에 wpcf7submit을 발생시키고, 성공한 경우에만 폼을 리셋한다.
  // 리셋은 이벤트 처리 이후에 일어나므로 다음 틱으로 미뤄서 복구한다.
  document.addEventListener('wpcf7submit', function (e) {
    var form = e.target;
    setTimeout(function () { restore(form); }, 0);
  }, false);

  // 사용자가 접두사까지 지운 경우에도 칸을 벗어날 때 되돌린다.
  document.addEventListener('blur', function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('your_phone')) return;
    if (el.value === '') restore(el.form || document);
  }, true);
})();
