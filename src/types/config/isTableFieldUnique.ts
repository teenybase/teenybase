import {TableFieldData} from '../field';
import {TableData} from '../table';

export function isTableFieldUnique(f: TableFieldData, t: TableData) {
    return f.unique || f.primary || !!t.indexes?.find(i => {
        if (!i.unique) return false
        const fields = Array.isArray(i.fields) ? i.fields : [i.fields]
        // split because it can have collate...
        return !!fields.find(f1 => f1.split(' ')[0] === f.name)
    })
}
