(function ($) {
    // https://css-tricks.com/finger-friendly-numerical-inputs-with-inputmode/
    $('.c_common').attr({ inputmode: "numeric", pattern: "[0-9]*" });
    /* 컨택폼 연락처 새로운 마스크 (cleave.min.js) **
    ** https://github.com/nosir/cleave.js/ **
    ** https://nosir.github.io/cleave.js/ 
    ** https://github.com/nosir/cleave.js/blob/master/doc/options.md#prefix */

    $('.c_common').toArray().forEach(function (field) { // https://github.com/nosir/cleave.js/issues/138
        new Cleave(field, {
            numeral: true,
            numeralThousandsGroupStyle: 'thousand'
            // prefix: ' 원',
            // tailPrefix: true,
            // noImmediatePrefix: true,
            // rawValueTrimPrefix: true
        })
    });

    function rate_cal() {
        var c4 = parseInt($('.c4').val());
        // https://stackoverflow.com/questions/42645797/remove-decimal-and-comma-and-digits-from-price-in-jquery
        // https://www.nicesnippets.com/blog/how-to-remove-comma-from-string-in-jquery
        var c5 = parseInt($('.c5').val().replace(/\,(\d\d)$/, ".$1").replace(/,/g, ""));
        var c6 = parseInt($('.c6').val().replace(/\,(\d\d)$/, ".$1").replace(/,/g, ""));
        var c7 = parseInt($('.c7').val().replace(/\,(\d\d)$/, ".$1").replace(/,/g, ""));
        var c8 = parseInt($('.c8').val().replace(/\,(\d\d)$/, ".$1").replace(/,/g, ""));
        $('.c9').val(c4 * c5 + c7 + c8 - c6);
        var cleave_c9 = new Cleave('.c9', {
            numeral: true,
            numeralThousandsGroupStyle: 'thousand'
        });
        var c9 = parseInt($('.c9').val().replace(/\,(\d\d)$/, ".$1").replace(/,/g, ""));

        $('.c10').val(Math.round(c9 / c4));
        var cleave_c10 = new Cleave('.c10', {
            numeral: true,
            numeralThousandsGroupStyle: 'thousand'
        });

        $('.c11').val(RATE(c4, c5, -c6 + c8, c7, 0, 0.0000001) * 1200); // https://gist.github.com/kucukharf/677d8f21660efaa33f72
        var cleave_c11 = new Cleave('.c11', {
            numeral: true,
            numeralDecimalScale: 4
        });
        
        $('.c12').val(c4 * c5 + c7 + c8);
        var cleave_c12 = new Cleave('.c12', {
            numeral: true,
            numeralThousandsGroupStyle: 'thousand'
        });
    }

    // $(".cal_btn").on('click', function () {
    //     rate_cal();
    // });
    $(".c_common").on('input', function () {
        rate_cal();
    });


}(jQuery));