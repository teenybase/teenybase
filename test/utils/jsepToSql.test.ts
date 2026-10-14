import {describe, expect, test} from 'vitest'
import {queryToSqlQuery} from '../../src/sql/parse/parse'
import {literalToQuery} from '../../src'
import {createJsepContext, emptyGlobals} from '../../src/sql/parse/jsep'
import {logSQLQuery} from '../../src/sql/build/query'

const f = (input: string, table: string, simplify = true, autoNull = true) => {
    const jc = createJsepContext(table, [], {
        request: {
            ...emptyGlobals.request,
            method: 'GET',
            url: {
                ...emptyGlobals.request.url,
                pathname: '/jsepToSql/test',
            },
        }, auth: {
            ...emptyGlobals.auth,
            role: 'user',
            sid: 'test',
        }
    }, [table], undefined, autoNull, simplify)
    jc._checkColumns = false
    try {
        const sql = literalToQuery(queryToSqlQuery(input, jc))
        const d1Q = logSQLQuery(sql)
        return d1Q
    }catch (e: any){
        return e?.message
    }
}

describe('jsepToSql', () => {
    test('0', () => expect(f("a=='GET'", "test", true, true)).toBe("(([test].[a]) IS \"GET\")"))
    test('1', () => expect(f("!a", "test", true, true)).toBe("(NOT ([test].[a]))"))
    test('2', () => expect(f("! a == 1", "test", true, true)).toBe("((NOT ([test].[a])) IS 1)"))
    test('3', () => expect(f("request.method=='GET'", "test", false, true)).toBe("(\"GET\" IS \"GET\")"))
    test('4', () => expect(f("request.method=='GET'", "test", true, true)).toBe("1"))
    test('5', () => expect(f("status==200", "test", true, true)).toBe("(([test].[status]) IS 200)"))
    test('6', () => expect(f("a==\"GET\"", "user", true, true)).toBe("(([user].[a]) IS \"GET\")"))
    test('7', () => expect(f("request.status=200", "test", true, false)).toBe("ParseError - property does not exist \"status\" in \"request\""))
    test('8', () => expect(f("request.status=200", "test", false, true)).toBe("(NULL IS 200)"))
    test('9', () => expect(f("request.status=200", "test", true, true)).toBe("0"))
    test('10', () => expect(f("user.age>18", "user", true, true)).toBe("(([user].[age]) > 18)"))
    test('11', () => expect(f("\"a==\"GET\"\"", "user", true, true)).toBe("Not Supported type - Compound"))
    test('12', () => expect(f("\"a==\"GET\"", "user", true, true)).toBe("Unclosed quote after \"\" at character 9"))

    test('13', () => expect(f("b!='POST'", "test", true, true)).toBe("(([test].[b]) IS NOT \"POST\")"))
    test('14', () => expect(f("request.url.pathname=='/api/v1'", "test", false, true)).toBe("(\"/jsepToSql/test\" IS \"/api/v1\")"))
    test('15', () => expect(f("request.url.pathname=='/api/v1'", "test", true, true)).toBe("0"))
    test('16', () => expect(f("response.code<400", "test", true, true)).toBe("ParseError - object not found \"response\""))

    test('17', () => expect(f("user.role==\"admin\"", "user", true, true)).toBe("(([user].[role]) IS \"admin\")"))
    test('18', () => expect(f("!1", "test", true, true)).toBe("0"))
    test('19', () => expect(f("!''", "test", true, true)).toBe("1"))
    test('20', () => expect(f("!'asdf'", "test", true, true)).toBe("1"))
    test('21', () => expect(f("!0", "test", true, true)).toBe("1"))
    test('22', () => expect(f("! true", "test", true, true)).toBe("0"))
    test('23', () => expect(f("!1", "test", false, true)).toBe("(NOT 1)"))
    test('24', () => expect(f("!''", "test", false, true)).toBe("(NOT \"\")"))
    test('25', () => expect(f("!'asdf'", "test", false, true)).toBe("(NOT \"asdf\")"))
    test('26', () => expect(f("!0", "test", false, true)).toBe("(NOT 0)"))
    test('27', () => expect(f("! true", "test", false, true)).toBe("(NOT 1)"))

    test('28', () => expect(f("1432+34142", "test", false, true)).toBe("(1432 + 34142)"))
    test('29', () => expect(f("1311+34212", "test", true, true)).toBe("35523"))
    test('30', () => expect(f("1/false", "test", true, true)).toBe("null"))
    test('31', () => expect(f("1/0 + 1 * 100 - 401", "test", true, true)).toBe("NULL"))
    test('32', () => expect(f("1 + 1 * 100/0 - 401", "test", true, true)).toBe("NULL"))
    test('33', () => expect(f("1/false", "test", false, true)).toBe("(1 / 0)"))
    test('34', () => expect(f("true + true", "test", false, true)).toBe("(1 + 1)"))
    test('35', () => expect(f("true + true", "test", true, true)).toBe("2"))
    test('36', () => expect(f("true + 1", "test", false, true)).toBe("(1 + 1)"))
    test('37', () => expect(f("true + 1", "test", true, true)).toBe("2"))

    // todo floating precision and other operators?

    test('38', () => expect(f("null + 1", "test", true, true)).toBe("NULL"))
    test('39', () => expect(f("null + true", "test", true, true)).toBe("NULL"))
    test('40', () => expect(f("null - true", "test", true, true)).toBe("NULL"))

    // todo allow these expressions? since they are allowed in sql. these all throw error right now.

    // test('41', ()=> expect(f("(5 OR 0) + 1", "test", true, true)).toBe("2"))
    // test('42', ()=> expect(f("(5 OR 0 OR NULL OR FALSE + 231) + 102", "test", true, true)).toBe("103"))
    // test('43', ()=> expect(f("5 OR 0 OR NULL OR FALSE", "test", true, true)).toBe("1"))
    // test('44', ()=> expect(f("(5 OR NULL) + 1", "test", true, true)).toBe("2"))
    // test('45', ()=> expect(f("(5 OR 0) + 1", "test", false, true)).toBe("2"))
    // test('46', ()=> expect(f("(5 OR 0 OR NULL OR FALSE + 231) + 102", "test", false, true)).toBe("103"))
    // test('47', ()=> expect(f("(5 OR NULL) + 1", "test", false, true)).toBe("2"))

    // todo
    // test('48', ()=> expect(f("replace(\"hello\", \"he\", \"hi\")", "test", true, true)).toBe("hillo"))
    // test('49', () => expect(f("replace(\"hello\", \"he\", \"hi\")", "test", false, true)).toBe("(REPLACE(\"hello\", \"he\", \"hi\"))"))

    // todo headers.contentType
    test('50', () => expect(f("request.headers.contentType=='application/json'", "test", true, false)).toBe("ParseError - property does not exist \"contentType\" in \"request.headers\""))
    test('51', () => expect(f("request.headers.test.contentType=='application/json'", "test", true, false)).toBe("ParseError - property does not exist \"test\" in \"request.headers\""))
    test('52', () => expect(f("request.headers.contentType=='application/json'", "test", true, true)).toBe("0"))
    test('53', () => expect(f("request.headers.test.contentType=='application/json'", "test", true, true)).toBe("0"))
    test('54', () => expect(f("request.headers.contentType=='application/json'", "test", false, true)).toBe("(NULL IS \"application/json\")"))
    test('55', () => expect(f("product.price>=10.99", "product", true, true)).toBe("(([product].[price]) >= 10.99)"))
    test('56', () => expect(f("(a=='GET' & b=='POST')", "test", true, true)).toBe("((([test].[a]) IS \"GET\") AND (([test].[b]) IS \"POST\"))"))
    test('57', () => expect(f("name='John'", "user", true, true)).toBe("(([user].[name]) = \"John\")"))
    test('58', () => expect(f("count>100", "test", true, true)).toBe("(([test].[count]) > 100)"))
    test('59', () => expect(f("is_active==true", "user", true, true)).toBe("(([user].[is_active]) IS 1)"))
    test('60', () => expect(f("id==null", "user", true, true)).toBe("(([user].[id]) IS NULL)"))
    test('61', () => expect(f("id!=null", "user", true, true)).toBe("(([user].[id]) IS NOT NULL)"))
    test('62', () => expect(f("id==null", "user", false, true)).toBe("(([user].[id]) IS NULL)"))
    test('63', () => expect(f("user.tmp=null", "user", true, true)).toBe("(([user].[tmp]) IS NULL)"))
    test('64', () => expect(f("is_active!=null", "user", true, true)).toBe("(([user].[is_active]) IS NOT NULL)"))
    test('65', () => expect(f("request.method!='POST'", "test", false, true)).toBe("(\"GET\" IS NOT \"POST\")"))
    test('66', () => expect(f("request.method!='POST'", "test", true, true)).toBe("1"))
    test('67', () => expect(f("timestamp<=1641036000", "test", true, true)).toBe("(([test].[timestamp]) <= 1641036000)"))
    test('68', () => expect(f("email ~ '%@example.com'", "user", true, true)).toBe("(([user].[email]) LIKE \"%@example.com\" ESCAPE '\\')"))

    // todo write more from here
    // test('69', ()=> expect(f("product.category IN ('electronics', 'books')", "product", true, true)).toBe("ParseError - IN operator"))
    // test('70', ()=> expect(f("'status'=='active'", "test", true, true)).toBe("(\"active\" IS \"active\")"))
    // test('71', ()=> expect(f("user.age", "user", true, true)).toBe("ParseError - no comparison operator"))
    // test('72', ()=> expect(f("request.body.id==123", "test", true, true)).toBe("ParseError - nested property"))
    // test('73', ()=> expect(f("1+1==2", "test", true, true)).toBe("ParseError - arithmetic operation"))
    // test('74', ()=> expect(f("user.created>'2023-01-01'", "user", true, true)).toBe("((user.created) > \"2023-01-01\")"))
    // test('75', ()=> expect(f("NULL IS NULL", "test", true, true)).toBe("ParseError - IS NULL check"))
    // test('76', ()=> expect(f("((a=='GET') AND (b!='POST'))", "test", true, true)).toBe("(((test.a) IS \\\"GET\\\") AND ((test.b) IS NOT \\\"POST\\\"))"))
    // test('77', ()=> expect(f("(status==200 OR (response.type=='json' AND data!=null))", "test", true, true)).toBe("Not Supported type - Compound"))
    // test('78', ()=> expect(f("user.name IS NOT NULL", "user", true, true)).toBe("((user.name) IS NOT NULL)"))
    // test('79', ()=> expect(f("product.price IS NULL", "product", true, true)).toBe("((product.price) IS NULL)"))
    // test('80', ()=> expect(f("LOWER(user.email)=='john@example.com'", "user", true, true)).toBe("ParseError - SQL function"))
    // test('81', ()=> expect(f("LENGTH(product.description)>100", "product", true, true)).toBe("ParseError - SQL function"))
    // test('82', ()=> expect(f("DATE(order.created)==CURRENT_DATE()", "order", true, true)).toBe("ParseError - SQL function"))
    // test('83', ()=> expect(f("(((nested.level1).level2).level3)=='deep'", "nested", true, true)).toBe("ParseError - multiple nested properties"))
    // test('84', ()=> expect(f("COALESCE(user.middle_name, user.first_name)=='John'", "user", true, true)).toBe("ParseError - SQL function"))
    // test('85', ()=> expect(f("(CASE WHEN status=='active' THEN 1 ELSE 0 END)==1", "test", true, true)).toBe("ParseError - SQL CASE statement"))
});

describe('rowid and order parsing', () => {
    // Helper with column checking ENABLED (unlike the `f` function above which disables it)
    const fCol = (input: string, table: string) => {
        const tables = [{
            name: table,
            autoSetUid: false,
            fields: [
                { name: 'id', type: 'text', sqlType: 'text' },
                { name: 'title', type: 'text', sqlType: 'text' },
                { name: 'created', type: 'date', sqlType: 'timestamp' },
            ],
        }]
        const jc = createJsepContext(table, tables as any, {
            request: { ...emptyGlobals.request, method: 'GET', url: { ...emptyGlobals.request.url, pathname: '/test' } },
            auth: { ...emptyGlobals.auth, sid: 'test', role: 'user' }
        }, [table])
        // _checkColumns stays true (default) — unlike the f() helper
        try {
            const sql = literalToQuery(queryToSqlQuery(input, jc))
            return logSQLQuery(sql)
        } catch (e: any) {
            return e?.message
        }
    }

    // rowid is allowed as a column in queries with column checking enabled
    test('rowid in where clause', () => {
        expect(fCol('rowid > 10', 'posts')).toContain('[posts].[rowid]')
    })

    test('rowid equality', () => {
        expect(fCol('rowid == 5', 'posts')).toContain('[posts].[rowid]')
    })

    test('known column still works', () => {
        expect(fCol("title == 'hello'", 'posts')).toContain('[posts].[title]')
    })

    test('unknown column rejected', () => {
        expect(fCol('nonexistent > 1', 'posts')).toContain('Column not found')
    })

    // sort alias and DESC/ASC tested via the f() helper (no column checking needed)
    test('DESC keyword in order', () => expect(f('created DESC', 'test', true, true)).not.toContain('error'))
    test('ASC keyword in order', () => expect(f('title ASC', 'test', true, true)).not.toContain('error'))
});

