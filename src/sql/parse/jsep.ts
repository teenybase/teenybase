import jsep from 'jsep'
import {Context, Env} from 'hono'
import {AuthContext} from '../../types/env'
import {literalToQuery, SQLLiteral, SQLQuery} from '../build/query'
import {sqlValSchema, tableColumnNameSchema} from '../../types/sql'

let jsepSetup = false
export function setupJsep(){
    if(jsepSetup) return
    jsepSetup = true
    // LIKE operator
    jsep.removeUnaryOp('~');
    jsep.addBinaryOp('~', jsep.binary_ops['==']);
    jsep.addBinaryOp('!~', jsep.binary_ops['==']);

    // IN operator
    jsep.addBinaryOp('in', 10);
    // = operator
    jsep.addBinaryOp('=', jsep.binary_ops['==']); // this is 6

    // as operator
    jsep.addBinaryOp('as', 10);
    jsep.addBinaryOp('=>', 10);

    // json operators - https://developers.cloudflare.com/d1/build-with-d1/query-json/#extract-values
    // The -> operator, which returns a JSON representation of the value.
    // The ->> operator, which returns an SQL representation of the value.
    jsep.addBinaryOp('->', 11);
    jsep.addBinaryOp('->>', 11);

    // jsep.addLiteral('all', '*')

    // jsep.removeBinaryOp('+')
    // jsep.addUnaryOp('+')
}

export interface JsepGlobals{
    request: {
        method: string
        url: {
            href: string
            protocol: string
            host: string
            hostname: string
            port: string
            pathname: string
            search: string
            hash: string
            origin: string
        }
        headers: Record<string, string>
        query: Record<string, string>
    },
    auth?: AuthContext
}

// Note, the user can access the whole context, so there shouldn't be any secret accessible from this object
export function honoToJsep(c: Context): JsepGlobals{
    const url = new URL(c.req.url)
    return {
        request: {
            method: c.req.method,
            url: {
                href: c.req.url,
                protocol: url.protocol,
                host: url.host,
                hostname: url.hostname,
                port: url.port,
                pathname: url.pathname,
                search: url.search,
                hash: url.hash,
                origin: url.origin,
            },
            headers: c.req.header(),
            query: c.req.query(),
            // auth
            // admin - separate just to be safe
        },
        auth: c.get('auth') ?? {uid: null, verified: false, admin: false, jwt: {}},
    }
}

const jsepCache = new Map<string, jsep.Expression>()

// literals should only have const literals, like PI etc, not dynamic like request.url
export function jsepParse(q: string, literals?: Record<string, any>){
    if(!literals && jsepCache.has(q)) {
        // console.log('using cache', q)
        return structuredClone(jsepCache.get(q)!)
    }

    if(literals) for (const key of Object.keys(literals)) {
        if(jsep.literals[key]){
            console.warn(`Literal ${key} already exists in jsep literals. Overwriting.`)
        }
        jsep.addLiteral(key, literals[key])
    }
    const tree = jsep(q)
    if(literals) for (const key of Object.keys(literals)) {
        jsep.removeLiteral(key)
    }
    if(!literals) {
        jsepCache.set(q, structuredClone(tree))
    }
    return tree
}

export interface JsepContext{
    tableName: string
    allowedTables: Record<string, string[]>
    globals: JsepGlobals
    extras: Record<string, {
        literals: Record<string, SQLQuery|SQLLiteral>
        table?: string
    }> // extra literal objects
    c: Context<Env>
    _checkColumns?: boolean

    // todo rename
    // automatically set unknown properties when accessing global objects to null.
    // default is true. throws error if false and property is not found.
    autoNullProps: boolean
    // automatically simplify expressions if possible during parsing
    // default is true
    autoSimplifyExpr: boolean
}

export function createJsepContext(tableName: string, data: {fields: {name: string}[]}, c: Context, allowedTables?: string[], extras?: JsepContext['extras'], autoNullProps = true, autoSimplifyExpr = true): JsepContext{
    setupJsep()
    return {
        tableName: columnify(tableName),
        globals: honoToJsep(c),
        allowedTables: Object.fromEntries(allowedTables?.map(t=>[columnify(t), data.fields.map(f=>columnify(f.name))]) ?? []),
        extras: extras || {},
        c,
        autoNullProps: autoNullProps,
        autoSimplifyExpr: autoSimplifyExpr,
    }
}

// Note use ==(is) if both sides are nullable (so always). NULL = NULL is false. NUll IS NULL is true. Its fine when comparing with a constant.
const operatorMapping = {
    '==': 'IS',
    '!=': 'IS NOT',
    '=': '=',
    '~': 'LIKE',
    '!~': 'NOT LIKE',
    '<': '<',
    '<=': '<=',
    '>': '>',
    '>=': '>=',
    '&': 'AND',
    '|': 'OR',
    '+': '+',
    '-': '-',
    '*': '*',
    '/': '/',
    'in': 'IN',
    'IN': 'IN',
    '!': 'NOT',

    // '&&': 'AND',
    '||': '||', // || is string concatenation in sql

    '->': '->',
    '->>': '->>',
    // '%': '%',
    // '^': '^',
    // '<<': '<<',
    // '>>': '>>',
    // '>>>': '>>>',

    // '=>' : '', // dont uncomment, it must be explicitly parsed if required, see parseColumnList
    // 'as' : '', // dont uncomment
    // 'AS' : '', // dont uncomment
} as const
type FOperators = keyof typeof operatorMapping
type BOperators = typeof operatorMapping[FOperators]

const functionMapping = {
    'lower': 'LOWER',
    'upper': 'UPPER',
    'count': 'COUNT',
    'substring': 'SUBSTRING',
    'length': 'LENGTH',
    'unixepoch': 'UNIXEPOCH',
    'datetime': 'DATETIME',
    'date': 'DATE',
    'time': 'TIME',
    'concat': 'CONCAT',
    'sum': 'SUM',
    // 'trim': 'TRIM',
    'replace': 'REPLACE',
    // 'regexp_replace': 'REGEXP_REPLACE',
    // 'regexp_match': 'REGEXP_MATCH',
    // 'regexp_split': 'REGEXP_SPLIT',
    // 'regexp_extract': 'REGEXP_EXTRACT',
    // 'regexp_extract_all': 'REGEXP_EXTRACT_ALL',
    // 'regexp_like': 'REGEXP_LIKE',
    // 'json_extract': 'JSON_EXTRACT', // use -> or ->> operator
    // 'json_array_length': 'JSON_ARRAY_LENGTH',
    // 'json_valid': 'JSON_VALID',
    // 'json' : 'JSON',
    'json_set': 'JSON_SET',
    'json_insert': 'JSON_INSERT', // like set but does not overwrite
    'json_replace': 'JSON_REPLACE',
    // 'json_each': 'JSON_EACH', see json_contains
    'json_patch': 'JSON_PATCH', // Merge Patch https://datatracker.ietf.org/doc/html/rfc7396
    'json_contains': (args: SQLQuery[], c: JsepContext)=>{
        // https://developers.cloudflare.com/d1/build-with-d1/query-json/#expand-arrays-for-in-queries
        // todo is it possible to optimize/shorten? what if function is called 10 times in a rule?
        // EXISTS (SELECT 1 FROM json_each(arg[0]) WHERE value = arg[1])
        if(args.length !== 2) throw new Error('json_contains requires 2 arguments')
        return `EXISTS (SELECT 1 FROM json_each(${args[0].q}) WHERE value = ${args[1].q})`
    },

    // more -  https://developers.cloudflare.com/d1/build-with-d1/query-json/#supported-functions
} as const
type FFunctions = keyof typeof functionMapping
type BFunctions = typeof functionMapping[FFunctions]

export function columnify(s: string){
    return `[${tableColumnNameSchema.parse(s)}]`
}

export function resolveIdentifier(exp: jsep.Identifier, context: JsepContext) {
    if(exp.type !== 'Identifier') {
        throw new Error('Not supported, expected Identifier, got ' + exp.type)
    }
    return ident(exp.name, context)
}

export function ident(exp: string, context: JsepContext) {
    // assume column
    const column = columnify(exp)
    if(!context.allowedTables[context.tableName]?.includes(column) && context._checkColumns!==false ) {
        // console.log(context.allowedTables, context.tableName, column)
        throw new Error('Column not found ' + column + ' in ' + context.tableName)
    }
    return context.tableName + '.' + column
}


// these are for inline evaluation
type TLi = string | number | boolean | null | undefined
const genOps = {
    '=': (l: TLi, r: TLi) => l === r,
    'IS': (l: TLi, r: TLi) => l === r,
    // '==': (l: TLi, r: TLi) => l === r,
    'IS NOT': (l: TLi, r: TLi) => l !== r,
} as const satisfies Partial<Record<BOperators, (l: TLi, r: TLi) => TLi>>
const numOps = {
    '<': (l: number, r: number) => l < r,
    '<=': (l: number, r: number) => l <= r,
    '>': (l: number, r: number) => l > r,
    '>=': (l: number, r: number) => l >= r,
    '+': (l: number, r: number) => l + r,
    '-': (l: number, r: number) => l - r,
    '*': (l: number, r: number) => l * r,
    '/': (l: number, r: number) => l / r,
} as const satisfies Partial<Record<BOperators, (l: number, r: number) => TLi>>
const boolOps = {
    'AND': (l: boolean, r: boolean) => l && r,
    'OR': (l: boolean, r: boolean) => l || r,
} as const satisfies Partial<Record<BOperators, (l: boolean, r: boolean) => TLi>>
function handleNull(operator: BOperators, other: SQLQuery|SQLLiteral): SQLQuery|SQLLiteral | null {
    if (operator === 'AND') {
        return {l: null}
    } else if (operator === 'OR') {
        // todo - this is not right if `other` is not a literal. since sql also casts it to a bool(1 or 0) after applying the OR operator.
        //  as an example `(5 OR NULL) + 1 = 2` in sqlite
        //  maybe as a fix, we can add (or 0) to the end of the expression. So (5 OR 0 OR NULL OR FALSE...) will become simplify to 5 then (5 OR 0)
        return other
    } else if (operator === 'LIKE') { // null LIKE null is also false
        return {l: false}
    } else if (operator === 'NOT LIKE') { // null NOT LIKE null is also true
        return {l: true}
    } else if (operator === '=' ||
        operator === '+' ||
        operator === '-' ||
        operator === '*' ||
        operator === '/') { // todo add more
        return {l: null}
    }
    const l = (other as SQLLiteral).l
    if(l === undefined) return null // not a literal
    if (operator === 'IS') {
        return {l: l === null}
    } else if (operator === 'IS NOT') {
        return {l: l !== null}
    } /*else if (operator === '!=') {
        return {l: true}
    }*/
    return null
}
function handleBool(lit: boolean, operator: keyof typeof boolOps | BOperators, other: SQLQuery|SQLLiteral): SQLQuery|SQLLiteral | null {
    // todo - this is not right if `other` is not a literal. since sql also casts it to a bool(1 or 0) after applying the AND/OR operator.
    //  as an example `(5 OR 0) + 1 = 2` in sqlite
    //  maybe as a fix, we can add (or 0) to the end of the expression. So (5 OR 0 OR NULL OR FALSE...) will become simplify to 5 then (5 OR 0)
    if (operator === 'AND') {
        return lit === false ? {l: false} : other
    }
    if (operator === 'OR') {
        return lit === true ? {l: true} : other
    }
    // const l = (other as SQLLiteral).l
    // if(l === undefined) return null // not a literal
    // if (operator === '+') {
    //     if(typeof l === 'number')
    // }
    return null
}

function applyLiteralOperator(l: SQLLiteral['l'], r: SQLLiteral['l'], operator: BOperators): SQLLiteral | null {
    const isObj = typeof l === 'object'
    const isNum = typeof l === 'number'
    const isBool = typeof l === 'boolean'
    const isStr = typeof l === 'string' // todo handle string stuff?
    if (!isObj || (l === null && r === null)) {
        // string, number, boolean, null, undefined
        let op: ((l: TLi, r: TLi) => boolean) | null = null
        if (!op && (genOps as any)[operator]) op = (genOps as any)[operator]
        if (!op && isBool && (boolOps as any)[operator]) op = (boolOps as any)[operator]
        if (!op && (isNum || isBool) && (numOps as any)[operator]) op = (numOps as any)[operator] // bool and num operations work similar in js and sql
        if (op !== null) {
            // not required anymore.
            // if (isNum && !isFinite(l as number) || isNum && !isFinite(r as number)) {
            //     throw new Error(`Invalid number in expression ${l} ${operator} ${r}`)
            // }
            return {l: op(l, r as any)}
            // console.log('Simplified', l, operator, r, 'to', res.l)
            // return res
        }
    } else {
        // todo both are objects or arrays or regexp
    }
    return null
}

export function applyBinaryOperator(left: SQLQuery | SQLLiteral, right: SQLQuery | SQLLiteral, operator: BOperators, simplify: boolean) {
    // special case for IS NULL. Anyone is literal and null
    if(operator === '='){
        if((left as SQLLiteral).l === null || (right as SQLLiteral).l === null) operator = 'IS'
    }

    // todo implement simply for function operators.
    // todo write tests for simplification
    if (simplify) {
        let res: SQLQuery | SQLLiteral | null = null

        const leftLit = (left as SQLLiteral).l !== undefined
        const rightLit = (right as SQLLiteral).l !== undefined

        // both literals - direct evaluation
        if (leftLit && rightLit) {
            // try to evaluate
            let l = (left as SQLLiteral).l
            let r = (right as SQLLiteral).l
            if(typeof l === 'number' && !isFinite(l)) l = null
            if(typeof r === 'number' && !isFinite(r)) r = null
            // console.log(l, r)
            if (typeof l === typeof r) {
                res = applyLiteralOperator(l, r, operator)
            } else {
                // one side null
                if (l === null || r === null) {
                    const other = l === null ? r : l
                    // todo use applyLiteralOperator?
                    res = handleNull(operator, {l: other})
                }
                // one side boolean
                if (!res && (typeof l === 'boolean' || typeof r === 'boolean')) {
                    // const bool = typeof l === 'boolean' ? l : (r as boolean)
                    // const other = typeof l === 'boolean' ? r : l
                    res = applyLiteralOperator(l, r, operator)
                    // res = handleBool(bool, operator, {l: other})
                }
            }
        } else if (leftLit || rightLit) {
            // partial evaluation
            const lit = ((leftLit ? left : right) as SQLLiteral).l
            const other = (leftLit ? right : left)

            // boolean
            if (typeof lit === 'boolean') {
                res = handleBool(lit, operator, other)
            }
            // null
            if (!res && lit === null) {
                res = handleNull(operator, other)
            }

        }
        if (res) {
            // console.log('Simplified', left, operator, right, 'to', res)
            return res
        }
        // console.log('Cannot simplify', left, operator, right)
    }

    const left1 = literalToQuery(left)
    const right1 = literalToQuery(right)

    // console.log(left, operator, right)
    return {
        q: `${left1.q} ${operator} ${right1.q}${(operator.includes('LIKE') ? ` ESCAPE '\\'` : '')}`,
        p: {...left1.p, ...right1.p}
    } as SQLQuery
}

export function applyBoolJoinOperator(args: (SQLQuery | SQLLiteral)[], operator: 'AND' | 'OR', simplify: boolean) {
    if (operator !== 'AND' && operator !== 'OR') throw new Error('Invalid operator, only AND and OR are supported')

    if (simplify) {
        let res: SQLLiteral | null = null

        const literals = args.map(a=>(a as SQLLiteral).l !== undefined)

        // both any known literal
        if(literals.length){

            const bools = args.filter(a=>typeof (a as SQLLiteral).l === 'boolean')
            if(operator === 'AND') {
                if(!bools.every(b=>b)){
                    res = {l: false}
                } else {
                    // no nothing, ignore all (AND true)
                }
            }else if(operator === 'OR') {
                if(bools.some(b=>b)){
                    res = {l: true}
                } else {
                    // no nothing, ignore all (OR false)
                }
            }
            if(!res) {
                const nulls = args.filter(a => (a as SQLLiteral).l === null)
                if (operator === 'AND' && nulls.length) {
                    res = {l: null}
                } else if (operator === 'OR' && nulls.length) {
                    // do nothing, ignore all the (OR null)
                }

                args = args.filter(a => (a as SQLLiteral).l !== null && typeof (a as SQLLiteral).l !== 'boolean')
            }
        }
        if (res) {
            // console.log('Simplified', args, operator, 'to', res)
            return res
        }
        // console.log('Cannot simplify', args, operator)
    }

    const args1 = args.map(a=>literalToQuery(a))

    return {
        q: args1.map(a=>a.q).join(` ${operator} `),
        p: args1.reduce((acc, a)=>({...acc, ...a.p}), {})
    } as SQLQuery
}

export function applyUnaryOperator(arg: SQLQuery | SQLLiteral, operator: BOperators, simplify: boolean) {
    const l = (arg as SQLLiteral).l
    if(simplify && l !== undefined) {
        let res: SQLLiteral | null = null
        if(operator === 'NOT'){
            // ┌──────────┬───────┬───────┬──────────┬────────┬───────────┬────────┬───────────┬────────────────┐
            // │ not true │ not 1 │ not 0 │ not null │ not '' │ not 'asd' │ not -1 │ not false │ not json('{}') │
            // ├──────────┼───────┼───────┼──────────┼────────┼───────────┼────────┼───────────┼────────────────┤
            // │ 0        │ 0     │ 1     │ null     │ 1      │ 1         │ 0      │ 1         │ 1              │
            // └──────────┴───────┴───────┴──────────┴────────┴───────────┴────────┴───────────┴────────────────┘
            const type = typeof l
            if(type === 'boolean'){
                res = {l: !l ? 1 : 0}
            }else if(l === null){
                res = {l: null} // NOT NULL is NULL
            }else if(type === 'number'){
                res = {l: l === 0 ? 1 : 0}
            }else if(type === 'string'){
                const f = parseFloat(l as string)
                res = {l: isFinite(f) ? (!f? 1 : 0) : 1} // todo verify. its based on the fact that sqlite casts string to number and tests on that
            }else {
                // todo
            }
        }

        if (res) {
            // console.log('Simplified', left, operator, right, 'to', res)
            return res
        }
        // console.log('Cannot simplify', left, operator, right)
    }

    const arg1 = literalToQuery(arg)
    return {
        q: `${operator} ${arg1.q}`,
        p: arg1.p
    } as SQLQuery
}

export function treeToSql(tree: jsep.Expression, context: JsepContext): SQLQuery | SQLLiteral{
    // console.log(tree)
    if(tree.type === 'Identifier'){
        const exp = tree as jsep.Identifier
        const res = {q: resolveIdentifier(exp, context)}
        // console.log('Identifier', exp.name, res, context.tableName)
        return res
    }
    if(tree.type === 'Literal'){
        const exp = tree as jsep.Literal
        // todo check for globals/objects?
        return {l: sqlValSchema.parse(exp.value)} // literalToQuery is called later at the end
    }
    if(tree.type === 'BinaryExpression') {
        const exp = tree as jsep.BinaryExpression
        const left = treeToSql(exp.left, context)
        const right = treeToSql(exp.right, context)
        let operator = operatorMapping[exp.operator as keyof typeof operatorMapping]
        if(!operator){
            throw new Error(`Operator ${exp.operator} not supported`)
        }
        return applyBinaryOperator(left, right, operator, context.autoSimplifyExpr)
    }
    if(tree.type === 'UnaryExpression') {
        const exp = tree as jsep.UnaryExpression
        const arg = treeToSql(exp.argument, context)
        let operator = operatorMapping[exp.operator as keyof typeof operatorMapping]
        if(!operator){
            throw new Error(`Operator ${exp.operator} not supported`)
        }
        return applyUnaryOperator(arg, operator, context.autoSimplifyExpr)
    }
    if(tree.type === 'MemberExpression') {
        const exp = tree as jsep.MemberExpression
        if(exp.computed) throw new Error('Not supported - computed') // what is computed here?
        if(exp.property.type !== 'Identifier') throw new Error('Not supported, not an identifier')
        const prop = exp.property as jsep.Identifier
        let obj: SQLLiteral | undefined
        if(exp.object.type === 'Identifier'){
            const ob = exp.object as jsep.Identifier
            if((context.globals as any)[ob.name]){
                obj = {l: (context.globals as any)[ob.name], key: ob.name}
            }else {
                let table = columnify(ob.name)
                const extra = context.extras[table] // for new. stuff. see parseUpdateQuery
                if (extra) {
                    const v = extra.literals[prop.name]
                    if (v) return literalToQuery(v)
                    if (extra.table) table = extra.table // replace new. with users. to match the current val in the table
                }
                const column = columnify(prop.name)
                if (context.allowedTables[table]?.includes(column) || (context.tableName === table && context._checkColumns===false))
                    return {q: `${table}.${column}`}
            }
        }
        if(!obj) obj = treeToSql(exp.object, context) as SQLLiteral
        if(obj.l === null && context.autoNullProps) obj.l = {}
        if(obj.l === undefined || obj.l === null) {
            // console.log(obj, context.globals.auth)
            if((exp.object as jsep.Identifier).name) throw new Error(`ParseError - object not found "${exp.object.name}"`)
            throw new Error('ParseError - object does not have value ' + JSON.stringify(exp.object))
        }
        if(typeof obj.l !== 'object') throw new Error('ParseError - object is not an object')
        let val = obj.l[prop.name]
        if(val === undefined) {
            // console.log(exp.object, obj)
            if(context.autoNullProps) val = null
            else throw new Error(`ParseError - property does not exist "${prop.name}" in "${obj.key ?? exp.object.name ?? ''}"`)
        }
        return {l: val, key: (obj.key || '?') + '.' + prop.name}
    }
    if(tree.type === 'CallExpression') {
        const exp = tree as jsep.CallExpression
        if(exp.callee.type !== 'Identifier') throw new Error('Not supported, not an identifier')
        const callee = exp.callee as jsep.Identifier
        const func = functionMapping[callee.name.toLowerCase() as keyof typeof functionMapping]
        if(!func) throw new Error(`Function ${callee.name} not supported`)

        // special case for count() and count(*)
        if(func === 'COUNT' && (exp.arguments.length === 0 /*|| exp.arguments.length === 1 && exp.arguments[0].type === 'Literal' && (exp.arguments[0] as jsep.Literal).name === '*'*/)) {
            return {q: 'COUNT(*)'}
        }

        const args = exp.arguments.map(arg => literalToQuery(treeToSql(arg, context)))
        const q = typeof func === 'function' ?
            (func as Function)(args, context) : // this could update args...
            `${func}(${args.map(a => a.q).join(', ')})`
        return {
            q: q,
            p: args.reduce((acc, a) => ({...acc, ...a.p}), {})
        }
    }
    // console.log(tree)
    throw new Error('Not Supported type - ' + tree.type)
}

export function parseColumnList(q: string|string[], context: JsepContext, allowExpr = false, allowAs = false): string[] {
    if(Array.isArray(q)) q = q.join(', ')
    if(q === '*') return ['*']
    let tree = jsepParse(q as string)
    if(tree.type !== 'Compound') {
        tree = {type: 'Compound', body: [tree]}
    }
    const exp = tree as jsep.Compound
    const res = [] as string[]
    for (let item of exp.body) {
        if(!allowExpr) res.push(resolveIdentifier(item as jsep.Identifier, context))
        else {
            let name = ''
            if(allowAs && item.type === 'BinaryExpression'){
                const exp1 = item as jsep.BinaryExpression
                if(exp1.operator !== 'as' && exp1.operator !== '=>') throw new Error('Not supported, expected => or as')
                if(exp1.right.type !== 'Identifier') throw new Error('Not supported, expected identifier')
                item = exp1.left
                name = ' AS ' + columnify((exp1.right as jsep.Identifier).name)
            }
            const sql = treeToSql(item, context)
            if((sql as SQLLiteral).l) throw new Error('Not supported - literal')
            const sql1 = sql as SQLQuery
            if(!sql1.q || (sql1.p && Object.keys(sql1.p).length)) {
                // console.log(sql)
                throw new Error('Not supported - params/invalid')
            }
            if(name && sql1.q[sql1.q.length-1]==='*') throw new Error('Not supported, cannot use * with AS')
            res.push(sql1.q + name)
        }
    }
    return res
}

export function parseColumnListOrder(q: string | string[], context: JsepContext): string[] {
    if(Array.isArray(q)) q = q.join(', ')
    let tree = jsepParse(q as string)
    if(tree.type !== 'Compound') {
        tree = {type: 'Compound', body: [tree]}
    }
    const exp = tree as jsep.Compound
    const res = [] as string[]
    for (const item of exp.body) {
        if(item.type === 'UnaryExpression') {
            const exp1 = item as jsep.UnaryExpression
            const asc = exp1.operator === '+' ? 'ASC' : (exp1.operator === '-' ? 'DESC' : null)
            if(!asc) throw new Error('Not supported, expected + or -, got ' + exp1.operator)
            res.push(resolveIdentifier(exp1.argument as jsep.Identifier, context) + ' ' + asc)
            continue
        }
        res.push(resolveIdentifier(item as jsep.Identifier, context))
    }
    return res
}
