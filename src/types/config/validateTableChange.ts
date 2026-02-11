import {z} from 'zod'
import {DatabaseSettings} from '../config';
import {jsonStringify} from '../../utils/string';
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
    const issues: z.core.$ZodIssue[] = []
    const addIssue = (message: string, ...extra: (string | number)[]) =>
        issues.push({code: "custom", message, path: [...tablePath, ...extra]})

    // Change-based validations (comparing next vs last)
    if (lastTable && nextTable.name !== lastTable?.name) {
        if (nextTable.lastName !== lastTable?.name) addIssue(`Last table name must be set to ${lastTable.name} when changing table name`, 'lastName')

        if (lastTable.r2Base && nextTable.r2Base !== lastTable.r2Base) {
            // todo check if there are files in the bucket under base, and throw error only then
            addIssue(`r2Base cannot be changed - ${nextTable.r2Base} !== ${lastTable.r2Base}`, 'r2Base')
        }
        if (!lastTable.r2Base && nextTable.r2Base !== lastTable.name) {
            // todo check if there are files in the bucket under base, and throw error only then
            addIssue(`r2Base must be set to "${lastTable.name}" because changing table name`, 'r2Base')
        }

    }
    if (lastTable && nextTable.r2Base !== lastTable.r2Base && nextTable.name !== lastTable.r2Base && nextTable.r2Base !== lastTable.name) {
        // todo check if there are files in the bucket under that base, and throw error only then
        addIssue(`r2Base cannot be changed - ${nextTable.r2Base ?? nextTable.name} !== ${lastTable.r2Base}`, 'r2Base')
    }
    if (lastTable && nextTable.idInR2 !== lastTable.idInR2) {
        // todo check if there are files in the bucket under that base, and throw error only then
        addIssue(`idInR2 cannot be changed - ${nextTable.r2Base} !== ${lastTable.r2Base}`, 'idInR2')
    }
    if (lastTable && nextTable.allowMultipleFileRef !== lastTable.allowMultipleFileRef) {
        // this is fine
    }
    if (lastTable && nextTable.autoDeleteR2Files !== lastTable.autoDeleteR2Files) {
        // this is fine
    }

    // Pure-config checks (idInR2, allowMultipleFileRef, autoDeleteR2Files, allowWildcard,
    // autoSetUid, FTS, duplicate field names) are handled by tableDataSchema.superRefine()

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
        if (nextTable.fields.find(f => f.name === field.name) !== field) addIssue(`Duplicate field name`, 'fields', field.name)
        let lastField = lastTable?.fields?.filter((f) => f.name === field.name || f.name === field.lastName) ?? []
        // remove the last fields that are renamed now.
        lastField = lastField.filter(lf => {
            // find field in nextTable where lastName = lf.name
            const nextField = nextTable.fields.filter(f => f.lastName === lf.name && f !== field)
            if (nextField.length > 1) addIssue(`Duplicate field name`, 'fields', lf.name)
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
                //     addIssue(`Duplicate field name`, 'fields', field.name)
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
            if (!cont) addIssue(`Duplicate field name`, 'fields', field.name)
        }
        try {
            const res1 = validateFieldChange(field, lastField[0], nextTable.name, nextSettings, tablePath)
            if (res1.create) res.create.push(res1.create)
            if (res1.drop) res.drop.push(res1.drop)
            if (res1.alter) res.alter.push(res1.alter)
        } catch (e) {
            if (e instanceof z.ZodError) issues.push(...e.issues)
            else throw e
        }
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

            if (!cont) addIssue(`Duplicate field name`, 'fields', field.name)
        }
        if (!nextField.length) { // deleted field
            try {
                const res1 = validateFieldChange(undefined, field, nextTable.name, nextSettings, tablePath)
                if (res1.create) res.create.push(res1.create)
                if (res1.drop) res.drop.push(res1.drop)
                if (res1.alter) res.alter.push(res1.alter)
            } catch (e) {
                if (e instanceof z.ZodError) issues.push(...e.issues)
                else throw e
            }
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
    // FTS pure-config checks are handled by tableDataSchema.superRefine()

    const extensions = nextTable.extensions
    for (const extension of extensions) {
        const parser = tableExtensionSchemas[extension.name as keyof typeof tableExtensionSchemas]
        if (!parser) {
            addIssue(`Unknown extension: ${extension.name}`, 'extension', extension.name)
        } else {
            try {
                zParseWithPath<any>(parser, extension, [...tablePath, 'extension', extension.name])
            } catch (e) {
                if (e instanceof z.ZodError) issues.push(...e.issues)
                else throw e
            }
        }
        // todo parse rules and check if they are valid
    }

    if (issues.length) throw new z.ZodError(issues)
    if (!lastTable) return {create: nextTable}
    return {alter: [nextTable, lastTable, res] as AlterTable}
}
