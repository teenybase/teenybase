import {TableRulesExtension} from './tableRulesExtension'
import {TableAuthExtension} from './tableAuthExtension'
import {TableCrudExtension} from './tableCrudExtention'
import {TableExtension} from '../tableExtension'

export const extensions = {
    [TableRulesExtension.name]: TableRulesExtension,
    [TableAuthExtension.name]: TableAuthExtension,
    [TableCrudExtension.name]: TableCrudExtension,
}

export interface TableExtensions {
    rules: TableRulesExtension
    auth: TableAuthExtension
    crud: TableCrudExtension
}

export type ExtensionsKeys = keyof typeof extensions

// export const testTableData: TableData = {
//     name: 'test',
//     extensions: [
//         {
//             name: 'rules',
//             list: 'true',
//             view: 'true',
//             create: 'true',
//             update: 'true',
//             delete: 'true',
//         } as TableRulesExtensionData
//     ]
// }
//
