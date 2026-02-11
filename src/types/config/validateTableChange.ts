import {DatabaseSettings} from '../config';
import {jsonStringify} from '../../utils/string';
import {TableFieldUsageRecord} from '../../worker/usages';
import {indexName} from '../../sql/schema/tableQueries';
import {AlterTable, TableData} from '../table';
import {validateFieldChange} from './validateFieldChange'
import {tableExtensionSchemas} from '../zod/tableExtensionsSchema'
import {zParseWithPath, zCustomError} from '../../utils/zod'

export function validateTableChange(nextTable: TableData | undefined, lastTable: TableData | undefined, nextSettings?: DatabaseSettings, path: (string | number)[] = ['table']) {
    if (!nextTable) {
        if (!lastTable) return {}
        // todo handle dropped table like deleting files from r2, taking backup etc
        // throw new Error('not implemented')
        return {drop: lastTable}
    }
    if (lastTable && jsonStringify(nextTable) === jsonStringify(lastTable)) return {}

    const tablePath = nextTable ? [...path, nextTable.name] : path

    // validations
    if (lastTable && nextTable.name !== lastTable?.name) {
        if (nextTable.lastName !== lastTable?.name) throw zCustomError(`Last table name must be set to ${lastTable.name} when changing table name`, ...tablePath, 'lastName')

        if (lastTable.r2Base && nextTable.r2Base !== lastTable.r2Base) {
            // todo check if there are files in the bucket under base, and throw error only then
            throw zCustomError(`r2Base cannot be changed - ${nextTable.r2Base} !== ${lastTable.r2Base}`, ...tablePath, 'r2Base')
        }
        if (!lastTable.r2Base && nextTable.r2Base !== lastTable.name) {
            // todo check if there are files in the bucket under base, and throw error only then
            throw zCustomError(`r2Base must be set to "${lastTable.name}" because changing table name`, ...tablePath, 'r2Base')
        }

    }
    if (lastTable && nextTable.r2Base !== lastTable.r2Base && nextTable.name !== lastTable.r2Base && nextTable.r2Base !== lastTable.name) {
        // todo check if there are files in the bucket under that base, and throw error only then
        throw zCustomError(`r2Base cannot be changed - ${nextTable.r2Base ?? nextTable.name} !== ${lastTable.r2Base}`, ...tablePath, 'r2Base')
    }
    if (lastTable && nextTable.idInR2 !== lastTable.idInR2) {
        // todo check if there are files in the bucket under that base, and throw error only then
        throw zCustomError(`idInR2 cannot be changed - ${nextTable.r2Base} !== ${lastTable.r2Base}`, ...tablePath, 'idInR2')
    }
    if (lastTable && nextTable.allowMultipleFileRef !== lastTable.allowMultipleFileRef) {
        // this is fine
    }
    if (lastTable && nextTable.autoDeleteR2Files !== lastTable.autoDeleteR2Files) {
        // this is fine
    }

    if (nextTable.idInR2) {
        // check if noUpdate field is set on id field
        const idField = nextTable.fields.find(f => f.usage === TableFieldUsageRecord.record_uid)
        if (!idField || !idField.noUpdate) throw zCustomError(`idInR2 requires an id field with 'usage' = 'record_uid' and 'noUpdate' = 'true'.`, ...tablePath, 'idInR2')

        if (nextTable.allowMultipleFileRef) {
            throw zCustomError(`allowMultipleFileRef cannot be true when idInR2 is true`, ...tablePath, 'allowMultipleFileRef')
        }
    }
    const autoDeleteR2Files = nextTable.autoDeleteR2Files ?? true // default is true

    if (nextTable.allowMultipleFileRef) {
        if (nextTable.idInR2) {
            throw zCustomError(`idInR2 cannot be true when allowMultipleFileRef is true`, ...tablePath, 'idInR2')
        }
        if (autoDeleteR2Files) {
            throw zCustomError(`autoDeleteR2Files must be false when allowMultipleFileRef is true`, ...tablePath, 'autoDeleteR2Files')
        }
    }

    if (nextTable.allowWildcard) {
        throw zCustomError(`allowWildcard is not supported yet`, ...tablePath, 'allowWildcard')
    }

    if (nextTable.autoSetUid) {
        const idField = nextTable.fields.find(f => f.usage === TableFieldUsageRecord.record_uid)
        if (!idField || idField.type !== 'text') throw zCustomError(`autoSetUid requires an id field with 'usage' = 'record_uid' and 'type' = 'text'.`, ...tablePath, 'autoSetUid')
    }

    const res: AlterTable[2] = {
        create: [],
        drop: [],
        alter: [],
        indexes: {create: [], drop: []},
        triggers: {create: [], drop: []},
        fts: false
    }

    // todo improve lastName logic using multiple passes?
    for (const field of nextTable.fields) {
        if (nextTable.fields.find(f => f.name === field.name) !== field) throw zCustomError(`Duplicate field name`, ...tablePath, 'fields', field.name)
        let lastField = lastTable?.fields?.filter((f) => f.name === field.name || f.name === field.lastName) ?? []
        // remove the last fields that are renamed now.
        lastField = lastField.filter(lf => {
            // find field in nextTable where lastName = lf.name
            const nextField = nextTable.fields.filter(f => f.lastName === lf.name && f !== field)
            if (nextField.length > 1) throw zCustomError(`Duplicate field name`, ...tablePath, 'fields', lf.name)
            if (!nextField.length) return true
            // check if nextField[0] is renamed to lf
            // for that check if nextField is not in last table with same name and lastName
            const lastField2 = lastTable?.fields?.filter((f) => f.name === nextField[0].name && f.name === nextField[0].lastName) ?? []
            const renamed = !lastField2.length
            return !renamed
        })
        if (lastField.length > 1) {
            let cont = false
            // case. find exact match name and lastName both same
            const exact = lastField.find(f => f.name === field.name && f.lastName === field.lastName)
            if (exact) {
                // const match = lastField.find(f => f !== exact && f.name === field.lastName)
                // if (match) {
                //     throw createValidationError(`Duplicate field name`, ...tablePath, 'fields', field.name)
                // }
                lastField = [exact]
                cont = true
            }
            // another case. when swapping 2 field names, this would be true, but this should be supported
            if (!cont && field.lastName && lastField.length === 2) {
                const match = lastField.filter(f => f.name === field.lastName)
                if (match.length === 1) {
                    cont = true
                    lastField = match
                }
            }
            if (!cont) throw zCustomError(`Duplicate field name`, ...tablePath, 'fields', field.name)
        }
        const res1 = validateFieldChange(field, lastField[0], nextTable.name, nextSettings, tablePath)
        if (res1.create) res.create.push(res1.create)
        if (res1.drop) res.drop.push(res1.drop)
        if (res1.alter) res.alter.push(res1.alter)
    }
    for (const field of lastTable?.fields || []) {
        let nextField = nextTable.fields.filter(f => f.name === field.name || f.lastName === field.name)
        if (nextField.length > 1) {
            // there is a case here we need to handle. when swapping 2 field names, this would be true, but this should be supported
            let cont = false
            if (nextField.length === 2) {
                nextField = nextField.filter(f => f.lastName === field.name)
                if (nextField.length === 1) {
                    // only if the field is new or changing...
                    if (res.create.includes(nextField[0]) || res.alter.find(a => a[0] === nextField[0]))
                        cont = true
                }
            }

            if (!cont) throw zCustomError(`Duplicate field name`, ...tablePath, 'fields', field.name)
        }
        if (!nextField.length) { // deleted field
            const res1 = validateFieldChange(undefined, field, nextTable.name, nextSettings, tablePath)
            if (res1.create) res.create.push(res1.create)
            if (res1.drop) res.drop.push(res1.drop)
            if (res1.alter) res.alter.push(res1.alter)
        }
    }

    if (nextTable.indexes) {
        for (const index of nextTable.indexes) {
            const last = lastTable?.indexes?.find(i => indexName(i).name === indexName(index).name)
            const changed = !last || jsonStringify(index) !== jsonStringify(last)
            if (changed) {
                res.indexes.create.push(index)
                if (last) res.indexes.drop.push(last)
            }
            // todo check if body only has columns and tables that are allowed
        }
    }
    if (lastTable?.indexes) {
        for (const index of lastTable?.indexes || []) {
            const next = nextTable.indexes?.find(i => indexName(i).name === indexName(index).name)
            if (!next) {
                res.indexes.drop.push(index)
            }
        }
    }

    if (nextTable.triggers) {
        for (const trigger of nextTable.triggers) {
            const last = lastTable?.triggers?.find(i => i.name === trigger.name)
            const changed = !last || jsonStringify(trigger) !== jsonStringify(last)
            if (changed) {
                res.triggers.create.push(trigger)
                if (last) res.triggers.drop.push(last)
            }
            // todo check if body only has columns and tables that are allowed
        }
    }
    if (lastTable?.triggers) {
        for (const trigger of lastTable?.triggers || []) {
            const next = nextTable.triggers?.find(i => i.name === trigger.name)
            if (!next) {
                res.triggers.drop.push(trigger)
            }
        }
    }

    // if(res.drop.length){
    //     if(res.create.length || res.alter.length){
    //         throw new Error(`Field ${nextTable.name}:${res.drop[0].name} - Field cannot be dropped - todo: right now it's not checked if the field is renamed or dropped.`)
    //     }
    // }

    if (jsonStringify(nextTable.fullTextSearch ?? {}) !== jsonStringify(lastTable?.fullTextSearch ?? {})) {
        res.fts = true
    }
    if (nextTable.fullTextSearch) {
        if (!nextTable.fullTextSearch.fields.length) throw zCustomError(`Full text search fields must be set`, ...tablePath, 'fullTextSearch', 'fields')
        const invalidFields = nextTable.fullTextSearch.fields.filter(f => !nextTable.fields.find(f2 => f2.name === f))
        if (invalidFields.length) throw zCustomError(`Invalid full text search fields - ${invalidFields.join(', ')}`, ...tablePath, 'fullTextSearch', 'fields')
        if (nextTable.fullTextSearch.tokenize && !['unicode61', 'ascii', 'porter', 'trigram'].includes(nextTable.fullTextSearch.tokenize)) {
            throw zCustomError(`Invalid tokenize value - ${nextTable.fullTextSearch.tokenize}`, ...tablePath, 'fullTextSearch', 'tokenize')
        }
        if (!nextTable.fullTextSearch.contentless && nextTable.fullTextSearch.content_rowid) {
            throw zCustomError(`content_rowid must not be set when contentless is false`, ...tablePath, 'fullTextSearch', 'content_rowid')
        }
        if (nextTable.fullTextSearch.content_rowid) {
            const field = nextTable.fields.find(f => f.name === nextTable.fullTextSearch!.content_rowid)
            if (!field) throw zCustomError(`content_rowid field not found - ${nextTable.fullTextSearch!.content_rowid}`, ...tablePath, 'fullTextSearch', 'content_rowid')
            if (field.sqlType !== 'integer') throw zCustomError(`content_rowid field must be integer`, ...tablePath, 'fullTextSearch', 'content_rowid')
            if (field.foreignKey) throw zCustomError(`content_rowid field cannot have foreign key`, ...tablePath, 'fullTextSearch', 'content_rowid')
            // todo should be primary?
        }
    }

    const extensions = nextTable.extensions
    for (const extension of extensions) {
        const parser = tableExtensionSchemas[extension.name as keyof typeof tableExtensionSchemas]
        if (!parser) {
            throw zCustomError(`Unknown extension: ${extension.name}`, ...tablePath, 'extension', extension.name)
        }
        zParseWithPath<any>(
            parser,
            extension,
            [...tablePath, 'extension', extension.name]
        )
        // todo parse rules and check if they are valid
    }

    if (!lastTable) return {create: nextTable}
    return {alter: [nextTable, lastTable, res] as AlterTable}
}
