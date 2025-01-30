import {describe, expect, test} from 'vitest'
import {replaceTemplateVariables} from '../../src/worker/util/replaceTemplateVariables'

const f = replaceTemplateVariables
describe('replaceTemplateVariables', () => {
    test('a', ()=> expect(f('{{a}}', {a: 1})).toBe('1'))
    test('a | 2', ()=> expect(f('{{a | 2}}', {a: 1})).toBe('1'))
    test('a | 2 default', ()=> expect(f('{{a | 2}}', {})).toBe('2'))
    test('no default', ()=> expect(f('asdg{{a}}|}4324cx', {})).toBe('asdg|}4324cx'))
    test('a | 2 default empty', ()=> expect(f('{{a | 2}}', {a: ''})).toBe('2'))
    test('a | 2 default empty', ()=> expect(f('{{a | 2}}', {a: null as any})).toBe('2'))
    test('multiple', ()=> expect(f('start {{a}} middle; {{b | sadaf3}} end', {a: '123'})).toBe('start 123 middle; sadaf3 end'))
    test('multi line', ()=> expect(f('<html>\nstart {{NAME | 12eds | {daf} 23}} \r\nmiddle;\n test {{test | sa {daf} 3}} end</html>', {test: '123'})).toBe('<html>\nstart 12eds | {daf} 23 \r\nmiddle;\n test 123 end</html>'))
    test('empty', ()=> expect(f('asd {{}} ad', {a: '123'})).toBe('asd  ad'))
    test('single {}', ()=> expect(f('asd {} ad', {a: '123'})).toBe('asd {} ad'))
    test('recurse', ()=> expect(f('asd {{hello | qwe {{1234}} asde}} ad', {a: '123'})).toBe('asd qwe {{1234 asde}} ad'))
    test('recurse 2', ()=> expect(f('asd {{hello | qw}} ad', {hello: 'e {{asd}} asde', asd: 'test'})).toBe('asd e {{asd}} asde ad'))
    test('recurse 3', ()=> expect(f('asd {{hello | qw}} ad', {hello: 'e {{asd}} asde', asd: 'test'}, 2)).toBe('asd e test asde ad'))
    test('longer data', ()=> expect(f('asd {{TEST | asd187y2s    q dh| sda | &}  a7d6 }} ad', {TEST: 'hello'})).toBe('asd hello ad'))
    test('longer data', ()=> expect(f('asd {{TEST | asd187y2s    q dh| sda | &}  a7d6 }} ad', {a: '123'})).toBe('asd asd187y2s    q dh| sda | &}  a7d6 ad'))
})
