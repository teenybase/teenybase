import {AlterField, TableFieldData} from "./field";
import {SQLIndex, SQLTrigger} from './sql'

export interface TableData<TF extends TableFieldData=TableFieldData, TE extends TableExtensionData=TableExtensionData>{
    // id: string
    name: string
    /**
     * Base path to save the files in r2.
     * By default, the table id/name is used
     */
    r2Base?: string
    /**
     * Use record uid in r2 path key.
     * Can be used for direct access control but requires noUpdate to be set on id field and allowMultipleFileRef to be false.
     * Default is false.
     */
    idInR2?: boolean
    /**
     * Automatically delete files in r2 when reference is removed.
     * Disable this to keep the files and allow re-referencing files across rows(allowMultipleFileRef).
     * default is true
     */
    autoDeleteR2Files?: boolean // default is true
    /**
     * allow referencing files in a table by path across rows, default is false.
     * if this is true, then idInR2 must not be true and autoDeleteR2Files must be false.
     */
    allowMultipleFileRef?: boolean

    allowWildcard?: boolean // like `select *`

    /**
     * Columns in the table, see {@link TableFieldData}
     */
    fields: TF[]

    /**
     * Indexes
     */
    indexes?: SQLIndex[]

    /**
     * Triggers
     */
    triggers?: SQLTrigger[]

    /**
     * Foreign keys. Other than foreign keys specified in fields.
     */
    // foreignKeys?: todo

    /**
     * if true, record_uid will be set automatically to uuidv4(when using insert route). type must be text
     *
     * default - false
     */
    autoSetUid?: boolean

    extensions: TE[]

    fullTextSearch?: {
        enabled?: boolean // default true
        fields: string[]
        // https://sqlite.org/fts5.html#fts5_table_creation_and_initialization
        tokenize?: string // tokenizer
        prefix?: string

        /**
         * set content=table_name
         * default = true
         */
        contentless?: boolean
        // content?: string
        content_rowid?: string
        // contentless_delete?: string
        columnsize?: 0|1
        detail?: "full"|"column"|"none"
    }

    lastName?: string
}

// export interface TableExtensionData<T=ExtensionsKeys> {
export interface TableExtensionData<T=string> {
    name: T
    [key: string]: any
}

// [nextTable, lastTable, fieldChanges]
export type AlterTable = [TableData, TableData, {create: TableFieldData[], drop: TableFieldData[], alter: AlterField[], indexes: {create: SQLIndex[], drop: SQLIndex[]}, triggers: {create: SQLTrigger[], drop: SQLTrigger[]}, fts: boolean}]

