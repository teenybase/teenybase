import {describe, expect, test} from 'vitest'
import {normalizeFileName} from '../../src/worker/util/string'
import {randomString} from '../../src'

describe('normalizeFileName', () => {
    test('test', ()=> expect(normalizeFileName('test123', '_asd')).toBe('test123_asd.dat'))
    test('test 1', ()=> expect(normalizeFileName('test 1', '_asd')).toBe('test_1_asd.dat'))
    test('test-1', ()=> expect(normalizeFileName('test-1', '_asd')).toBe('test_1_asd.dat'))
    test('test-1 2', ()=> expect(normalizeFileName('test-1 2.png', '_asd')).toBe('test_1_2_asd.png'))
    test('TEsT-1 2 3', ()=> expect(normalizeFileName('test-1 2 3', '_asd')).toBe('test_1_2_3_asd.dat'))
    test('test-1 2 3 4', ()=> expect(normalizeFileName('test-1 2 3 4.asdsdas', '_asd')).toBe('test_1_2_3_4_asd.asdsdas'))
    test('special chars', ()=> expect(normalizeFileName('!@#$%-^&*.(s){df}', '_asd')).toMatch(/[a-z0-9]{0,5}_asd.sdf/))
    test('ext 1', ()=> expect(normalizeFileName('file.png-a', '_asd')).toBe('file_asd.png-a'))
    test('ext 1', ()=> expect(normalizeFileName('file.gfd+a', '_asd')).toBe('file_asd.gfd+a'))
    test('underscore', ()=> expect(normalizeFileName('_123', '_asd')).toBe('123_asd.dat'))
    test('underscore 2', ()=> expect(normalizeFileName('_', '_asd')).toMatch(/[a-z0-9]{0,5}_asd.dat/))
    test('underscore 3', ()=> expect(normalizeFileName('_123_', '_asd')).toBe('123_asd.dat'))
    test('underscore 4', ()=> expect(normalizeFileName('_123_.png', '_asd')).toBe('123_asd.png'))
    test('uvs_debug_59bd8f531e.png', ()=> expect(normalizeFileName('uvs_debug_59bd8f531e.png', '')).toBe('uvs_debug_59bd8f531e.png'))
    test('small', ()=> {
        const res = normalizeFileName('ab', '_asd')
        expect(res.endsWith('_asd.dat')).toBe(true)
        expect(res.length).toBe(15)
        expect(res.startsWith('_')).toBe(false)
        expect(res.startsWith('ab')).toBe(true)
    })
    test('empty', ()=> {
        const res = normalizeFileName('', '_asd')
        expect(res.endsWith('_asd.dat')).toBe(true)
        expect(res.length).toBe(13)
        expect(res.startsWith('_')).toBe(false)
    })
    test('random string', ()=> expect(randomString(20).length).toBe(20))
    test('random string', ()=> expect(randomString(19).length).toBe(19))
    test('random string', ()=> expect(randomString(5).length).toBe(5))
})
