import {describe, it, assert} from 'vitest'
import {normalizeEmail} from '../../src/worker/util/normalizeEmail'

// extended from - https://github.com/johno/normalize-email/blob/master/test/test.js
const gmailEmailsToNormalize = [
    'johnotander@gmail.com',
    'johnotander@googlemail.com',
    'johnotander@GMAIL.com',
    'johnotander+foobar@gmail.com',
    'john.o.t.a.n.d.er+foobar@gmail.com',
    'JOHN.o.t.a.n.d.er+foobar@googlemail.com',
    'john.otander@gmail.com'
]

const hotmailEmailsToNormalize = [
    'johnotander@hotmail.com',
    'johnotander@hotmail.com',
    'johnotander@HOTMAIL.com',
    'Johnotander@hotmail.com'
]

const liveEmailsToNormalize = [
    'johnotander@live.com',
    'johnotander@live.com',
    'johnotander@live.com',
    'johnotander+foobar@live.com',
    'john.o.t.a.n.d.er+foobar@live.com',
    'JOHN.o.t.a.n.d.er+foobar@live.com',
    'john.otander@live.com'
]

const outlookEmailsToNormalize = [
    'john.otander@outlook.com',
    'JOHN.otander@outlook.com',
    'john.Otander+any.label@outlook.com',
    'john.otander+foobar@outlook.com',
]

const asciiNormalizationCases = {
    'user@exámple.com': 'user@xn--exmple-qta.com', // IDN -> ASCII
    'user@bücherf.de': 'user@xn--bcherf-3ya.de', // IDN -> ASCII
    'USER@EXÁMPLE.COM': 'user@xn--exmple-qta.com', // IDN + case normalization
    'test@fsaß.de': 'test@xn--fsa-7ka.de', // IDN -> ASCII
    'test@MÜNCHEN.de': 'test@xn--mnchen-3ya.de', // IDN + case normalization
    '你好s@例子.测试': '你好s@xn--fsqu00a.xn--0zwm56d', // Full IDN -> ASCII
    'примеcр@пример.рф': 'примеcр@xn--e1afmkfd.xn--p1ai', // Cyrillic IDN -> ASCII
    'test@EXAMPLE.co.uk': 'test@example.co.uk', // ASCII domain + case normalization
    'TEST@EXAMPLE.COM': 'test@example.com', // Case normalization
    'üser@EXAMPLE.COM': 'üser@example.com', // IDN local part normalized
    'user@xn--fa-hica.de': 'user@xn--fa-hica.de', // Already normalized IDN unchanged
    'user@xn--mnxchen-3ya.de': 'user@xn--mnxchen-3ya.de' // Already normalized IDN unchanged
};

describe('normalize-email', function() {

    it('should normalize gmail emails', function() {
        gmailEmailsToNormalize.forEach(function(email) {
            assert.equal(normalizeEmail(email), 'johnotander@gmail.com')
        })
    })

    it('should normalize hotmail emails', function() {
        hotmailEmailsToNormalize.forEach(function(email) {
            assert.equal(normalizeEmail(email), 'johnotander@hotmail.com')
        })
    })

    it('should not remove dots from hotmail emails', function() {
        assert.equal(normalizeEmail('john.otander@hotmail.com'), 'john.otander@hotmail.com')
    })

    it('should normalize live emails', function() {
        liveEmailsToNormalize.forEach(function(email) {
            assert.equal(normalizeEmail(email), 'johnotander@live.com')
        })
    })

    it('should normalize outlook emails', function() {
        outlookEmailsToNormalize.forEach(function(email) {
            assert.equal(normalizeEmail(email), 'john.otander@outlook.com')
        })
    })

    it('should normalize ascii emails', function() {
        for (const [input, expected] of Object.entries(asciiNormalizationCases)) {
            assert.equal(normalizeEmail(input), expected);
        }
    })

})
