(function($) {
	/* 푸터 & 모바일 슬라이드 메뉴 & 헤더(추가) 네이버톡 & 카카오톡 & 네이버블로그 */
	$("#copyright i.fa-tripadvisor, #slide-out-widget-area i.fa-tripadvisor, #mobile-menu i.fa-tripadvisor, #header-outer i.fa-tripadvisor").attr('class', 'icon-naverblog');
	$("#copyright i.fa-telegram, #slide-out-widget-area i.fa-telegram, #mobile-menu i.fa-telegram, #header-outer i.fa-telegram").attr('class', 'icon-navertalk');
	$("#copyright i.fa-slack, #slide-out-widget-area i.fa-slack, #mobile-menu i.fa-slack, #header-outer i.fa-slack").attr('class', 'icon-kakaotalk');


	/* 박람회 신청하기 전화 mobile detact ('detectmobilebrowser.js' is necessary) */
	$("#call-me a.nectar-button:first-child, .call-me").on('click', function (e) {
		if (!jQuery.browser.mobile) {
			e.preventDefault();
			alert("통화는 휴대폰에서만 가능해요 :)");
		}
	});

	/* 신청게시판 주문방법 배너 스티키 */
	$("#apply-sticky .span_12").addClass("page-submenu");
	$("#apply-sticky .span_12").attr("data-sticky", "true");


	// contact form 7 여러번 submit 방지
	// http://epsiloncool.ru/programmirovanie/preventing-multiple-submits-in-contact-form-7
	$(".wpcf7-submit").on('click', function (e) {
		if ($(".ajax-loader").hasClass('is-active')) {
			e.preventDefault();
			return false;
		}
	});

	if ($(".your_phone").length) {
		var cleave_phone = new Cleave('.your_phone', {
			prefix: '010',
			delimiter: '-',
			numericOnly: true, // https://github.com/nosir/cleave.js/issues/266
			blocks: [3, 4, 4]
		});
	}
	
	
}(jQuery));