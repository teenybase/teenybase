import {TableFieldData} from '../../types/field'
import {AlterTable, TableData, tableDataSchema} from '../../types/table'
import {TableFieldUsageRecord} from '../../worker/usages'
import {randomString} from '../../security/random'
import {tableExtensionSchemas} from '../../types/tableExtensions'

export function createFieldQuery(opts: TableFieldData): string {
    if(opts.notNull && opts.default?.trim().toLowerCase() === 'null') throw new Error(`Field ${opts.name} cannot be notNull and default null`)
    let suffix = opts.sqlType.toUpperCase() ?? 'TEXT'
    if(opts.primary) suffix += ' PRIMARY KEY'
    if(opts.autoIncrement) suffix += ' AUTOINCREMENT'
    if(opts.unique) suffix += ' UNIQUE'
    if(opts.notNull) suffix += ' NOT NULL'
    if(opts.default) suffix += ` DEFAULT ${opts.default}`
    if(opts.check) suffix += ` CHECK(${opts.check})`
    if(opts.foreignKey) {
        const {table, column, onUpdate, onDelete} = opts.foreignKey
        suffix += ` REFERENCES ${table}(${column})` + (onUpdate ? ` ON UPDATE ${onUpdate}` : '') + (onDelete ? ` ON DELETE ${onDelete}` : '')
    }
    return `${opts.name} ${suffix}`
}

export function createFieldsQuery(Type: TableFieldData[]): string {
    return `(\n\t${Type.map(createFieldQuery).join(', \n\t')}\n)`
}

export function createTableQuery(data: TableData, _rnd?: string, tempTableName?: string) {

    const fields = data.fields
    let sql = `CREATE TABLE ${tempTableName ?? data.name} ${createFieldsQuery(fields)};`
    let sqlRevert = tempTableName ? '' : `DROP TABLE IF EXISTS ${data.name};`

    const createdField = fields.find(f => f.usage === TableFieldUsageRecord.record_created)
    const updatedField = fields.find(f => f.usage === TableFieldUsageRecord.record_updated)

    // for triggers, indexes etc
    let sql2 = ''
    if(createdField){
        const rnd = _rnd ?? randomString(4)
        sql2 += '\n' + `
CREATE TRIGGER _ddb_created_trigger_${data.name}_${rnd} BEFORE UPDATE OF created ON ${data.name}
BEGIN SELECT RAISE(FAIL, 'created cannot be changed') WHERE OLD.created != NEW.created; END;
`.trim()
    }
    if(updatedField){
        const rnd = _rnd ?? randomString(4)
        sql2 += '\n' + `
CREATE TRIGGER _ddb_updated_trigger_${data.name}_${rnd} AFTER UPDATE ON ${data.name}
BEGIN UPDATE ${data.name} SET updated = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
`.trim()
    }

    // todo indexes
    // todo triggers

    return {sql, sql2, sqlRevert}
}

export function migrateTable(table: TableData, existingFields: string) {
    // If foreign key constraints are enabled, disable them using PRAGMA foreign_keys=OFF.
    // Start a transaction.
    // Remember the format of all indexes, triggers, and views associated with table X. This information will be needed in step 8 below. One way to do this is to run a query like the following: SELECT type, sql FROM sqlite_schema WHERE tbl_name='X'.
    // Use CREATE TABLE to construct a new table "new_X" that is in the desired revised format of table X. Make sure that the name "new_X" does not collide with any existing table name, of course.
    // Transfer content from X into new_X using a statement like: INSERT INTO new_X SELECT ... FROM X.
    // Drop the old table X: DROP TABLE X.
    // Change the name of new_X to X using: ALTER TABLE new_X RENAME TO X.
    // Use CREATE INDEX, CREATE TRIGGER, and CREATE VIEW to reconstruct indexes, triggers, and views associated with table X. Perhaps use the old format of the triggers, indexes, and views saved from step 3 above as a guide, making changes as appropriate for the alteration.
    // If any views refer to table X in a way that is affected by the schema change, then drop those views using DROP VIEW and recreate them with whatever changes are necessary to accommodate the schema change using CREATE VIEW.
    // If foreign key constraints were originally enabled then run PRAGMA foreign_key_check to verify that the schema change did not break any foreign key constraints.
    // Commit the transaction started in step 2.
    // If foreign keys constraints were originally enabled, reenable them now.

    const tempName = table.name + '_' + randomString(5)
    const createTable = createTableQuery(table, undefined, tempName)
    return `
        PRAGMA foreign_keys=OFF;
        ${createTable.sql}
        INSERT INTO ${tempName} (${existingFields})
         SELECT ${existingFields} FROM ${table.name};
        DROP TABLE ${table.name};
        ALTER TABLE ${tempName} RENAME TO ${table.name};
        ${createTable.sql2}
        PRAGMA foreign_key_check;
        PRAGMA foreign_keys=ON;
    `.split('\n').map(s => s.trim()).join('\n')
}

export function sqliteSupportedColumnAdd(field: TableFieldData) {
    // The ADD COLUMN syntax is used to add a new column to an existing table. The new column is always appended to the end of the list of existing columns. The column-def rule defines the characteristics of the new column. The new column may take any of the forms permissible in a CREATE TABLE statement, with the following restrictions:
    //
    // The column may not have a PRIMARY KEY or UNIQUE constraint.
    // The column may not have a default value of CURRENT_TIME, CURRENT_DATE, CURRENT_TIMESTAMP, or an expression in parentheses.
    // If a NOT NULL constraint is specified, then the column must have a default value other than NULL.
    // If foreign key constraints are enabled and a column with a REFERENCES clause is added, the column must have a default value of NULL.
    // The column may not be GENERATED ALWAYS ... STORED, though VIRTUAL columns are allowed.
    // When adding a column with a CHECK constraint, or a NOT NULL constraint on a generated column, the added constraints are tested against all preexisting rows in the table and the ADD COLUMN fails if any constraint fails. The testing of added constraints against preexisting rows is a new enhancement as of SQLite version 3.37.0 (2021-11-27).
    //
    // The ALTER TABLE command works by modifying the SQL text of the schema stored in the sqlite_schema table. No changes are made to table content for renames or column addition without constraints. Because of this, the execution time of such ALTER TABLE commands is independent of the amount of data in the table and such commands will run as quickly on a table with 10 million rows as on a table with 1 row. When adding new columns that have CHECK constraints, or adding generated columns with NOT NULL constraints, or when deleting columns, then all existing data in the table must be either read (to test new constraints against existing rows) or written (to remove deleted columns). In those cases, the ALTER TABLE command takes time that is proportional to the amount of content in the table being altered.
    //
    // After ADD COLUMN has been run on a database, that database will not be readable by SQLite version 3.1.3 (2005-02-20) and earlier.
    const unsupported = field.primary || field.unique ||
        field.default && (field.default.trim().startsWith('(') || field.default.trim().startsWith('CURRENT_')) ||
        // (field.notNull && field.default === 'NULL') ||
        (field.foreignKey && field.notNull) ||
        (field.foreignKey && field.default?.trim().toLowerCase() !== 'NULL')
    return !unsupported
}

export function createTable(data: TableData, others: TableData[], _rnd?: string) {
    data = tableDataSchema.parse(data)
    if(data.name !== data.name.toLowerCase()) throw new Error('Table name must be lowercase')
    // if(data.name !== data.id) throw new Error('Table name must be equal to id') // todo
    if(others.find(t => t.name === data.name)) throw new Error('Table already exists with this name ' + data.name)

    // todo this is done in validateSettingsChange also, required here?
    const extensions = data.extensions
    for (const extension of extensions) {
        const parser = tableExtensionSchemas[extension.name as keyof typeof tableExtensionSchemas]
        const parsed = parser.parse(extension)
    }

    const query = createTableQuery(data, _rnd)
    return {sql: query.sql+query.sql2, sqlRevert: query.sqlRevert, logs: [`✔ Table Created - ${data.name}`]}
}

export function dropTable(data: TableData, others: TableData[]) {
    let field: TableFieldData|undefined = undefined;
    const fk = others.find(t => field = t.fields.find(f => f.foreignKey && f.foreignKey.table === data.name))
    if(fk) throw new Error(`Table ${data.name} is referenced by ${fk.name}.${field!.name}`)
    const query = createTableQuery(data)
    return {sql: query.sqlRevert, sqlRevert: query.sql+query.sql2, logs: [`⚠ Table Dropped - ${data.name}`]}
}

export function alterTable([table, lastTable, fieldChanges]: AlterTable, others: TableData[]) {
    let statements = [] as [string,string|undefined][]
    const tableName = table.name // todo columnify?
    let needTriggerRecreate = false
    let needIndexRecreate = false

    let logs = [] as string[]
    // table rename
    if(table.name !== lastTable.name){
        // check references to this table in other table foreign keys - done below in foreign key comparison

        // The RENAME TO syntax changes the name of table-name to new-table-name.
        // This command cannot be used to move a table between attached databases, only to rename a table within the same database.
        // If the table being renamed has triggers or indices, then these remain attached to the table after it has been renamed.

        statements.push([
            `ALTER TABLE ${lastTable.name} RENAME TO ${tableName};`,
            `ALTER TABLE ${tableName} RENAME TO ${lastTable.name};`
        ])
        needTriggerRecreate = true
        needIndexRecreate = true

        logs.push(`⚠ Table Renamed - ${lastTable.name} -> ${tableName}`)
    }

    const toRename = {} as Record<string, string>;
    const renamedFieldNames = {} as any; // this is not used right now.
    let needsTableChange = false

    // deleted fields
    for (const field of fieldChanges.drop) {
        // is this required again?
        const fkCheck = others.find(t=>t.fields.find(f=>f.foreignKey && (f.foreignKey.table === tableName && f.foreignKey.column === field.name)))
        if(fkCheck) throw new Error(`Field ${tableName}:${field.name} - Field cannot be dropped - used in ${fkCheck.name}`)
        if(field.usage) throw new Error(`Field ${tableName}:${field.name} - Field cannot be dropped - ${field.usage} usage exists`)

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

        if(!sqliteSupportedColumnAdd(field)) needsTableChange = true
        statements.push([
            `ALTER TABLE ${tableName} DROP COLUMN ${field.name};`,
            `ALTER TABLE ${tableName} ADD COLUMN ${createFieldQuery({...field, name: field.name})};`,
        ])
        logs.push(`⚠ Field Dropped - ${tableName}.${field.name}`)
    }

    // no point in deleting since we are recreating the whole table anyway without those columns
    if(needsTableChange) statements = []

    // Note: (from pocketbase)
    // We are using a temporary column name when adding or renaming columns
    // to ensure that there are no name collisions in case there is
    // names switch/reuse of existing columns (eg. name, title -> title, name).
    // This way we are always doing 1 more rename operation but it provides better dev experience.

    for (const field of fieldChanges.create) {
        if(!sqliteSupportedColumnAdd(field)) needsTableChange = true
        else {
            const tempName = field.name + '_' + randomString(5)
            toRename[tempName] = field.name;

            statements.push([
                `ALTER TABLE ${tableName} ADD COLUMN ${createFieldQuery({...field, name: tempName})};`,
                `ALTER TABLE ${tableName} DROP COLUMN ${tempName};`,
            ])
            logs.push(`✔ Field Added - ${tableName}.${field.name}`)
        }
    }

    for(const [field, lastField] of fieldChanges.alter){
        if(field.name !== lastField.name){
            if(field.usage) throw new Error(`Field ${tableName}:${field.name} - Field cannot be renamed - ${field.usage} usage exists`)

            // The RENAME COLUMN TO syntax changes the column-name of table table-name into new-column-name.
            // The column name is changed both within the table definition itself and also within all indexes, triggers, and views that reference the column.
            // If the column name change would result in a semantic ambiguity in a trigger or view, then the RENAME COLUMN fails with an error and no changes are applied.

            // is this required again?
            const fkCheck = others.find(t=>t.fields.find(f=>f.foreignKey && (f.foreignKey.table === tableName && f.foreignKey.column === lastField.name)))
            if(fkCheck) throw new Error(`Field ${tableName}:${lastField.name} - Field cannot be renamed - used in ${fkCheck.name}`)

            const tempName = field.name + '_' + randomString(5)
            toRename[tempName] = field.name;
            statements.push([
                `ALTER TABLE ${tableName} RENAME COLUMN ${lastField.name} TO ${tempName};`,
                `ALTER TABLE ${tableName} RENAME COLUMN ${tempName} TO ${lastField.name};`,
            ])
            renamedFieldNames[lastField.name] = field.name;

            logs.push(`⚠ Field Renamed - ${tableName}.${lastField.name} -> ${field.name}`)

            // todo rename the column in indexes, triggers, views
        }


        // for other changes we need to create a new temp table, copy data, drop old table and rename back
        // see point 7 here - https://www.sqlite.org/lang_altertable.html
        const q1 = createFieldQuery({
            ...field,
            name: field.name,
        })
        const renamedTables = Object.fromEntries(others.map(o=>{
            if(o.lastName) return [o.lastName, o.name]
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
        if(q1 !== q2){
            needsTableChange = true
        }
    }

    for (const [tempName, actualName] of Object.entries(toRename)) {
        statements.push([
            `ALTER TABLE ${tableName} RENAME COLUMN ${tempName} TO ${actualName};`,
            `ALTER TABLE ${tableName} RENAME COLUMN ${actualName} TO ${tempName};`,
        ])
    }

    if(statements.length > 0) {
        needIndexRecreate = true
    }

    if(needTriggerRecreate){
        // todo delete triggers
        // statements = delete_triggers + statements
    }
    if(needIndexRecreate){
        // todo delete indexes
        // statements = delete_indexes + statements
    }

    if(needsTableChange){
        // for revert
        const lastTable2 = {
            ...lastTable,
            name: tableName,
            fields: lastTable.fields.map(f=> ({
                ...f, name: renamedFieldNames[f.name] ? renamedFieldNames[f.name] : f.name
            }))
        }

        // fields except the newly added ones
        const existingFields =table.fields.map(f=>f.name).filter(f=>!fieldChanges.create.find(f1=>f1.name === f))
        const fieldsStr = existingFields.join(', ')

        statements.push([migrateTable(table, fieldsStr), migrateTable(lastTable2, fieldsStr)])

        logs.push(`⚠ Recreate Table with new schema - ${tableName}`)

        // we don't need to delete/add index if needsTableChange since they are added during new table creation
        needIndexRecreate = false
        needTriggerRecreate = false
    }

    if(needIndexRecreate) {
        // todo add indexes
        // statements.push(add_indexes)
    }
    if(needTriggerRecreate){
        // todo add triggers
        // statements.push(add_triggers)
    }

    return {sql: statements.map(s=>s[0]).join('\n'), sqlRevert: statements.map(s=>s[1]).join('\n'), logs}
}
