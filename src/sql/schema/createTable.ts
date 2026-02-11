import {TableData} from '../../types/table'
import {createTableQuery} from './tableQueries'
import {tableDataSchema} from '../../types/zod/tableDataSchema';
import {tableExtensionSchemas} from '../../types/zod/tableExtensionsSchema'
import {zParseWithPath} from '../../utils/zod'

export function createTable(data: TableData, others: TableData[], _rnd?: string) {
    data = zParseWithPath(tableDataSchema, data, ['table', data.name])
    if (data.name !== data.name.toLowerCase()) throw new Error('Table name must be lowercase')
    // if(data.name !== data.id) throw new Error('Table name must be equal to id') // todo
    if (others.find(t => t.name === data.name)) throw new Error('Table already exists with this name ' + data.name)

    // todo this is done in validateSettingsChange also, required here?
    // const extensions = data.extensions
    // for (const extension of extensions) {
    //     const parser = tableExtensionSchemas[extension.name as keyof typeof tableExtensionSchemas]
    //     if (!parser) {
    //         throw new Error(`Table ${data.name} - Unknown extension: ${extension.name}`)
    //     }
    //     console.log('2 parsing extension', extension.name, 'for table', data.name)
    //     const parsed = zParseWithPath<any>(
    //         parser,
    //         extension,
    //         ['table', data.name, 'extension', extension.name]
    //     )
    // }

    const query = createTableQuery(data, _rnd)
    return {sql: query.sql + query.sql2, sqlRevert: query.sqlRevert, logs: [`✔ Table Created - ${data.name}`]}
}
