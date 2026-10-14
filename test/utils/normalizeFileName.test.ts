import {describe, expect, test} from 'vitest'
import {normalizeFileName, Snakecase} from '../../src/worker/util/string'
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

    // Regression: pre-fix the splitter regex was '[\W_]+' as a STRING literal,
    // which evaluated to /[W_]+/ — silently consuming any capital W in the name.
    test('W bug: White prefix preserved', () => expect(normalizeFileName('White Lab Diamond.dmat', '_id')).toBe('white_lab_diamond_id.dmat'))
    test('W bug: isolated W word', () => expect(normalizeFileName('a W b.dat', '_id')).toBe('a_w_b_id.dat'))
    test('W bug: camelCase boundary at W', () => expect(normalizeFileName('newWidget.png', '_id')).toBe('new_widget_id.png'))

    // camelCase / digits
    test('camelCase to snake_case (docstring example)', () => expect(normalizeFileName('myTestDB.json', '_id')).toBe('my_test_db_id.json'))
    test('digits inside camel name', () => expect(normalizeFileName('Model123Variant.glb', '_id')).toBe('model123_variant_id.glb'))

    // Separators in name part collapse to a single underscore
    test('multiple spaces collapse', () => expect(normalizeFileName('a   b  c.txt', '_id')).toBe('a_b_c_id.txt'))
    test('repeated dashes collapse', () => expect(normalizeFileName('a-b---c.txt', '_id')).toBe('a_b_c_id.txt'))
    test('mixed separators collapse', () => expect(normalizeFileName('Foo Bar-Baz_Qux.png', '_id')).toBe('foo_bar_baz_qux_id.png'))

    // Extension handling
    test('uppercase extension preserved', () => expect(normalizeFileName('photo.PNG', '_id')).toBe('photo_id.PNG'))
    test('no extension defaults to dat', () => expect(normalizeFileName('readme', '_id')).toBe('readme_id.dat'))
    test('trailing dot defaults extension to dat', () => expect(normalizeFileName('test.', '_id')).toBe('test_id.dat'))
    test('multi-dot keeps only last segment as extension', () => expect(normalizeFileName('archive.tar.gz', '_id')).toBe('archive_tar_id.gz'))
    test('extension keeps allowed special chars (+, -)', () => expect(normalizeFileName('file.gltf+lod-2', '_id')).toBe('file_id.gltf+lod-2'))

    // Idempotency
    test('already-snake_case name unchanged', () => expect(normalizeFileName('hello_world.png', '_id')).toBe('hello_world_id.png'))

    // Unicode → underscore (replacer regex on line 9 of string.ts is ASCII-only)
    test('non-ascii characters in name become underscore', () => expect(normalizeFileName('café résumé.pdf', '_id')).toBe('caf_r_sum_id.pdf'))

    // Length edges
    test('long name truncated at 93 chars', () => {
        const res = normalizeFileName('a'.repeat(200) + '.png', '_id')
        expect(res).toBe('a'.repeat(93) + '_id.png')
    })
    test('all-separator name padded with random hex', () => {
        const res = normalizeFileName('---', '_id')
        expect(res.endsWith('_id.dat')).toBe(true)
        // 5 hex chars (randomString) + '_id' + '.dat' = 12
        expect(res.length).toBe(12)
        expect(res.slice(0, 5)).toMatch(/^[0-9a-f]{5}$/)
    })

    // Direct Snakecase coverage — W-bug
    test('Snakecase: empty input', () => expect(Snakecase('')).toBe(''))
    // Empty return is intentional: matches change-case upstream, and `normalizeFileName`
    // pads short results with randomString(5) — see the 'all-separator name padded' test above.
    test('Snakecase: only separators returns empty', () => expect(Snakecase('___')).toBe(''))
    test('Snakecase: single capital W (W bug)', () => expect(Snakecase('White')).toBe('white'))
    test('Snakecase: leading W word (W bug)', () => expect(Snakecase('Was')).toBe('was'))
    test('Snakecase: camelCase split', () => expect(Snakecase('newWords')).toBe('new_words'))

    // Direct Snakecase coverage — case-comparison off-by-one (audit #24)
    // Old code used `prev > 'A' && prev < 'Z'` (exclusive). New port uses change-case's
    // regex-based boundaries which handle these correctly.
    test('Snakecase: AA preserves abbreviation', () => expect(Snakecase('AA')).toBe('aa'))
    test('Snakecase: AZ preserves abbreviation', () => expect(Snakecase('AZ')).toBe('az'))
    test('Snakecase: XYZW all-uppercase preserved', () => expect(Snakecase('XYZW')).toBe('xyzw'))
    test('Snakecase: ABBREVIATIONS preserved', () => expect(Snakecase('ABBREVIATIONS')).toBe('abbreviations'))
    test('Snakecase: XMLHttpRequest splits abbreviation correctly', () => expect(Snakecase('XMLHttpRequest')).toBe('xml_http_request'))
    test('Snakecase: myTestDB (docstring example)', () => expect(Snakecase('myTestDB')).toBe('my_test_db'))
})
