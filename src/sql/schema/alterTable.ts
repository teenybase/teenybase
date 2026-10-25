import {AlterTable, TableData} from "../../types/table";
import {randomString} from "../../security/random";
import {
    createFieldQuery, createFts5Query,
    createIndexQuery,
    createTriggerQuery, dropIndexQuery, dropTriggerQuery,
    migrateTableQuery,
    sqliteSupportedColumnAdd
} from "./tableQueries";
import {tableDataSchema} from '../../types/zod/tableDataSchema';
import { zParseWithPath } from '../../utils/zod';

export function alterTable([table, lastTable, changes]: AlterTable, others: TableData[]) {
    table = zParseWithPath(tableDataSchema, table, ['table', table.name])
    let statements = [] as [string, string | undefined][]
    const tableName = table.name // todo columnify?
    let clearTriggers = false
    let clearIndexes = false
    let resetFts = changes.fts

    let logs = [] as string[]
    // table rename
    if (table.name !== lastTable.name) {
        // check references to this table in other table foreign keys - done below in foreign key comparison

        // The RENAME TO syntax changes the name of table-name to new-table-name.
        // This command cannot be used to move a table between attached databases, only to rename a table within the same database.
        // If the table being renamed has triggers or indices, then these remain attached to the table after it has been renamed.

        statements.push([
            `ALTER TABLE ${lastTable.name} RENAME TO ${tableName};`,
            `ALTER TABLE ${tableName} RENAME TO ${lastTable.name};`
        ])
        clearTriggers = true
        clearIndexes = true
        resetFts = true

        logs.push(`⚠ Table Renamed - ${lastTable.name} -> ${tableName}`)
    }

    const toRename = {} as Record<string, string>;
    const renamedFieldNames = {} as any; // this is not used right now.
    let needsTableChange = false

    // deleted fields
    for (const field of changes.drop) {
        // is this required again?
        const fkCheck = others.find(t => t.fields.find(f => f.foreignKey && (f.foreignKey.table === tableName && f.foreignKey.column === field.name)))
        if (fkCheck) throw new Error(`Field ${tableName}:${field.name} - Field cannot be dropped - used in ${fkCheck.name}`)
        if (field.usage) throw new Error(`Field ${tableName}:${field.name} - Field cannot be dropped - ${field.usage} usage exists`)

        // The DROP COLUMN syntax is used to remove an existing column from a table. The DROP COLUMN command removes the named column from the table, and rewrites its content to purge the data associated with that column. The DROP COLUMN command only works if the column is not referenced by any other parts of the schema and is not a PRIMARY KEY and does not have a UNIQUE constraint. Possible reasons why the DROP COLUMN command can fail include:
        //
        // The column is a PRIMARY KEY or part of one.
        // The column has a UNIQUE constraint.
        // The column is indexed.
        // The column is named in the WHERE clause of a partial index.
        // The column is named in a table or column CHECK constraint not associated with the column being dropped.
        // The column is used in a foreign key constraint.
        // The column is used in the expression of a generated column.
        // The column appears in a trigger or view.

        if (!sqliteSupportedColumnAdd(field)) needsTableChange = true
        statements.push([
            `ALTER TABLE ${tableName} DROP COLUMN ${field.name};`,
            `ALTER TABLE ${tableName}
                ADD COLUMN ${createFieldQuery({...field, name: field.name})};`,
        ])
        logs.push(`⚠ Field Dropped - ${tableName}.${field.name}`)
    }

    // no point in deleting since we are recreating the whole table anyway without those columns
    if (needsTableChange) statements = []

    // Note: (from pocketbase)
    // We are using a temporary column name when adding or renaming columns
    // to ensure that there are no name collisions in case there is
    // names switch/reuse of existing columns (eg. name, title -> title, name).
    // This way we are always doing 1 more rename operation but it provides better dev experience.
    //
    // A temporary name is only safe for a column that carries no self-referencing constraint.
    // `createFieldQuery` substitutes the column *head* name; a `check:` is raw user SQL that names
    // the final column, so `ADD COLUMN flag_a1b2c ... CHECK(flag IN (0, 1))` asks SQLite to resolve
    // a column that does not exist yet and the whole migration aborts with `no such column: flag`.
    // So the temporary name is now taken only when the final name is genuinely still occupied, and
    // a column that needs both a temporary name and a CHECK goes through the table rebuild instead.

    // Column names still present by the time the ADD COLUMNs below run: whatever the previous table
    // had, less the columns dropped just above.
    const droppedNames = new Set(changes.drop.map(f => f.name))
    const occupiedAtAdd = new Set(lastTable.fields.map(f => f.name).filter(n => !droppedNames.has(n)))

    // Held back until `needsTableChange` is final. A table rebuild constructs the new table from
    // `table.fields` and copies only the pre-existing columns (see `existingFields` below), so it
    // already creates every added column — an incremental ADD COLUMN on top of it is redundant, and
    // for a CHECK-bearing column it is the unrunnable statement described above.
    const createStatements = [] as [string, string | undefined][]
    const createdTempNames = [] as string[]
    const createInsertAt = statements.length

    for (const field of changes.create) {
        if (!sqliteSupportedColumnAdd(field)) needsTableChange = true
        else {
            logs.push(`✔ Field Added - ${tableName}.${field.name}`)

            const needsTempName = occupiedAtAdd.has(field.name)
            if (needsTempName && field.check) {
                // Cannot be expressed incrementally: the name is taken, and a temporary name cannot
                // carry the check. Let the rebuild create the column with its final name.
                needsTableChange = true
                continue
            }

            const addedName = needsTempName ? field.name + '_' + randomString(5) : field.name
            if (needsTempName) {
                toRename[addedName] = field.name;
                createdTempNames.push(addedName)
            }

            createStatements.push([
                `ALTER TABLE ${tableName}
                    ADD COLUMN ${createFieldQuery({...field, name: addedName})};`,
                `ALTER TABLE ${tableName} DROP COLUMN ${addedName};`,
            ])
        }
    }

    for (const [field, lastField] of changes.alter) {
        if (field.name !== lastField.name) {
            if (field.usage) throw new Error(`Field ${tableName}:${field.name} - Field cannot be renamed - ${field.usage} usage exists`)

            // The RENAME COLUMN TO syntax changes the column-name of table table-name into new-column-name.
            // The column name is changed both within the table definition itself and also within all indexes, triggers, and views that reference the column.
            // If the column name change would result in a semantic ambiguity in a trigger or view, then the RENAME COLUMN fails with an error and no changes are applied.

            // is this required again?
            const fkCheck = others.find(t => t.fields.find(f => f.foreignKey && (f.foreignKey.table === tableName && f.foreignKey.column === lastField.name)))
            if (fkCheck) throw new Error(`Field ${tableName}:${lastField.name} - Field cannot be renamed - used in ${fkCheck.name}`)

            const tempName = field.name + '_' + randomString(5)
            toRename[tempName] = field.name;
            statements.push([
                `ALTER TABLE ${tableName} RENAME COLUMN ${lastField.name} TO ${tempName};`,
                `ALTER TABLE ${tableName} RENAME COLUMN ${tempName} TO ${lastField.name};`,
            ])
            renamedFieldNames[lastField.name] = field.name;

            logs.push(`⚠ Field Renamed - ${tableName}.${lastField.name} -> ${field.name}`)

        }

        // for other changes we need to create a new temp table, copy data, drop old table and rename back
        // see point 7 here - https://www.sqlite.org/lang_altertable.html
        const q1 = createFieldQuery({
            ...field,
            name: field.name,
        })
        const renamedTables = Object.fromEntries(others.map(o => {
            if (o.lastName) return [o.lastName, o.name]
            return [o.name, o.name]
        }))
        const q2 = createFieldQuery({
            ...lastField,
            name: field.name,
            foreignKey: lastField.foreignKey ? {
                ...lastField.foreignKey,
                table: renamedTables[lastField.foreignKey.table] ?? lastField.foreignKey.table
            } : undefined
        })
        if (q1 !== q2) {
            needsTableChange = true
        }
    }

    // `needsTableChange` is final here — the alter loop above is the last thing that can set it.
    // Emit the held-back ADD COLUMNs at their original position (right after the drops, before the
    // rename-to-temp statements), or discard them and let the rebuild create those columns.
    if (needsTableChange) {
        for (const tempName of createdTempNames) delete toRename[tempName]
    } else {
        statements.splice(createInsertAt, 0, ...createStatements)
    }

    for (const [tempName, actualName] of Object.entries(toRename)) {
        statements.push([
            `ALTER TABLE ${tableName} RENAME COLUMN ${tempName} TO ${actualName};`,
            `ALTER TABLE ${tableName} RENAME COLUMN ${actualName} TO ${tempName};`,
        ])
    }

    if (statements.length > 0) {
        clearIndexes = true
    }

    // todo add to logs for triggers

    if (needsTableChange) {
        // for revert
        const lastTable2 = {
            ...lastTable,
            name: tableName,
            fields: lastTable.fields.map(f => ({
                ...f, name: renamedFieldNames[f.name] ? renamedFieldNames[f.name] : f.name
            }))
        }

        // fields except the newly added ones
        const existingFields = table.fields.map(f => f.name).filter(f => !changes.create.find(f1 => f1.name === f))
        const fieldsStr = existingFields.join(', ')

        statements.push([migrateTableQuery(table, fieldsStr), migrateTableQuery(lastTable2, fieldsStr)])

        logs.push(`⚠ Recreate Table with new schema - ${tableName}`)
    }

    // if clear, then drop all
    let dropIndexes_ = clearIndexes ? lastTable.indexes : changes.indexes.drop
    let dropTriggers_ = clearTriggers ? lastTable.triggers : changes.triggers.drop
    // if clear, then create all
    // no need to create anything if we are recreating the table
    let createIndexes_ = needsTableChange ? [] : (clearIndexes ? table.indexes : changes.indexes.create)
    let createTriggers_ = needsTableChange ? [] : (clearTriggers ? table.triggers : changes.triggers.create)

    // todo add to logs for triggers, indexes
    const createIndexes = createIndexes_?.map(index => [
        createIndexQuery(table, index) + ';',
        dropIndexQuery(table, index) + ';',
    ] as [string, string])||[]
    const dropIndexes = dropIndexes_?.map(index => [
        dropIndexQuery(lastTable, index) + ';',
        createIndexQuery(lastTable, index) + ';',
    ] as [string, string])||[]
    let createTriggers = createTriggers_?.map(trigger => [
        createTriggerQuery(table, trigger) + ';',
        dropTriggerQuery(table, trigger) + ';',
    ] as [string, string])||[]
    let dropTriggers = dropTriggers_?.map(trigger => [
        dropTriggerQuery(lastTable, trigger) + ';',
        createTriggerQuery(lastTable, trigger) + ';',
    ] as [string, string])||[]

    let dropFts: [string, string][] = []
    let createFts: [string, string][] = []
    if(resetFts && !needsTableChange){ // fts and triggers are dropped and recreated on table change
        const lastFtsq = createFts5Query(lastTable)
        const ftsq = createFts5Query(table)
        if(lastFtsq) dropFts.push([lastFtsq.sqlRevert, lastFtsq.sql])
        if(ftsq) createFts.push([ftsq.sql, ftsq.sqlRevert])
    }

    statements = [...dropTriggers, ...dropIndexes, ...dropFts, ...statements]
    logs = [
        // todo better logs
        ...dropTriggers.map(t => `⚠ Trigger Dropped - ${t[0].split('TRIGGER')[1].split('ON')[0].trim()}`),
        ...dropIndexes.map(t => `⚠ Index Dropped - ${t[0].split('INDEX')[1].split('ON')[0].split('IF EXISTS').pop()!.trim()}`),
        ...dropFts.map(t => `⚠ FTS Dropped for ${lastTable.name}`),
        ...logs
    ]
    statements.push(...createIndexes, ...createTriggers, ...createFts)
    logs.push(
        // todo better logs
        ...createTriggers.map(t => `✔ Trigger Added - ${t[0].split('TRIGGER')[1].split('ON')[0].trim()}`),
        ...createIndexes.map(t => `✔ Index Added - ${t[0].split('INDEX')[1].split('ON')[0].trim()}`),
        ...createFts.map(t => `✔ FTS Added - ${t[0].split('VIRTUAL TABLE')[1].split(';')[0].trim()}`),
    )

    return {sql: statements.map(s => s[0]).join('\n'), sqlRevert: statements.map(s => s[1]).join('\n'), logs}
}
