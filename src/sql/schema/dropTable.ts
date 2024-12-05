import {TableData} from "../../types/table";
import {TableFieldData} from "../../types/field";
import {createTableQuery} from "./tableQueries";

export function dropTable(data: TableData, others: TableData[]) {
    let field: TableFieldData | undefined = undefined;
    const fk = others.find(t => field = t.fields.find(f => f.foreignKey && f.foreignKey.table === data.name))
    if (fk) throw new Error(`Table ${data.name} is referenced by ${fk.name}.${field!.name}`)
    const query = createTableQuery(data)
    return {sql: query.sqlRevert, sqlRevert: query.sql + query.sql2, logs: [`⚠ Table Dropped - ${data.name}`]}
}
