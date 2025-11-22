import {$Table} from './$Table'
import {TableExtensionData} from '../types/table'
import {JsepContext} from '../sql/parse/jsep'
import {InsertQuery} from '../sql/build/insert'
import {DeleteQuery} from '../sql/build/delete'
import {UpdateQuery} from '../sql/build/update'
import {SelectQuery} from '../sql/build/select'
import {HttpRoute} from '../types/route'

export class TableExtension<TData extends TableExtensionData = TableExtensionData> {
    get name(){
        return this.data.name
    }

    constructor(protected data: TData, protected table: $Table, protected jc: JsepContext) {
    }

    initialize?(): Promise<void>
    async onInsertParse?(query: InsertQuery): Promise<void>
    async onDeleteParse?(query: DeleteQuery, admin?: boolean): Promise<void>
    async onUpdateParse?(query: UpdateQuery): Promise<void>
    async onSelectParse?(query: SelectQuery): Promise<void>
    async onViewParse?(query: SelectQuery, id: string): Promise<void>

    routes: HttpRoute<any>[] = []

}
