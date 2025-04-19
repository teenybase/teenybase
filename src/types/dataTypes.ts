export enum TableFieldDataType {
    text = 'text',
    number = 'number',
    bool = 'bool',
    email = 'email',
    url = 'url',
    editor = 'editor',
    date = 'date',
    select = 'select',
    json = 'json',
    file = 'file',
    relation = 'relation',
    password = 'password',
    // autodate = 'autodate',
    integer = 'integer',
    blob = 'blob',
}

export type TableFieldDataType0 = keyof typeof TableFieldDataType

export enum TableFieldSqlDataType0 {
    text = 'text',
    integer = 'integer',
    real = 'real',
    blob = 'blob',
    null = 'null'
}

export enum TableFieldSqlDataType1 {
    json = 'json',
    date = 'date',
    datetime = 'datetime',
    time = 'time',
    timestamp = 'timestamp',
    float = 'float',
    int = 'int',
    boolean = 'boolean',
    numeric = 'numeric'
}

export type TableFieldSqlDataType = keyof typeof TableFieldSqlDataType0 | keyof typeof TableFieldSqlDataType1


