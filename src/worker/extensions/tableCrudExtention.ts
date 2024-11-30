import {TableExtension} from '../tableExtension'
import {z} from 'zod'
import {$Table} from '../$Table'
import {JsepContext} from '../../sql/parse/jsep'
import {HTTPException} from 'hono/http-exception'
import {selectSchema} from '../../sql/parse/select'
import {updateSchema} from '../../sql/parse/update'
import {insertSchema} from '../../sql/parse/insert'
import {deleteSchema} from '../../sql/parse/delete'

interface TableCrudExtensionData {
    name: 'crud'
}
const tableCrudExtensionDataSchema = z.object({})

export class TableCrudExtension extends TableExtension<TableCrudExtensionData> {
    static readonly name = 'crud'

    constructor(data: TableCrudExtensionData, table: $Table, jc: JsepContext) {
        super(data, table, jc)
        if (data.name !== TableCrudExtension.name) throw new HTTPException(500, {message: 'Invalid Configuration'})
        // Object.assign(this.routes, {
        //     'GET/select': async(body: any, p?: any)=>await this.table.select(body),
        //     'POST/select': async(body: any, p?: any)=>await this.table.select(body),
        //     'POST/update': async(body: any, p?: any)=>await this.table.update(body),
        //     'POST/insert': async(body: any, p?: any)=>await this.table.insert(body),
        //     'POST/delete': async(body: any, p?: any)=>await this.table.delete(body),
        //     'GET/view/:id': async(body: any, p?: any)=> this.table.fieldsUsage.record_uid ? await this.table.view(body, z.string().min(1).max(255).parse(p.id)) : undefined,
        // })
        const recordResponse = (schema?: z.ZodType)=>({
            '200': {
                description: 'Success',
                content: {'application/json': {
                    schema: schema ?? this.table.zodSchema.or(z.record(z.string(), z.unknown())),
                }},
            },
        })
        this.routes.push({
            handler: async(body: any, p?: any)=>await this.table.select(body),
            path: '/select',
            method: 'get',
            zod: ()=>({
                description: 'Select records',
                request: {query: selectSchema},
                responses: recordResponse(),
            }),
        })
        this.routes.push({
            handler: async(body: any, p?: any)=>await this.table.select(body),
            path: '/select',
            method: 'post',
            zod: ()=>({
                description: 'Select records',
                request: {body: {
                    required: true,
                    content: {'application/json': {schema: selectSchema}},
                }},
                responses: recordResponse(),
            }),
        })
        this.routes.push({
            handler: async(body: any, p?: any)=>await this.table.select(body),
            path: '/list',
            method: 'get',
            zod: ()=>({
                description: 'Select records with total count',
                request: {query: selectSchema},
                responses: recordResponse(z.object({
                    items: z.array(this.table.zodSchema.or(z.record(z.string(), z.unknown()))),
                    total: z.number().min(0).or(z.literal(-1)),
                })),
            }),
        })
        this.routes.push({
            handler: async(body: any, p?: any)=>await this.table.select(body),
            path: '/list',
            method: 'post',
            zod: ()=>({
                description: 'Select records with total count',
                request: {body: {
                    required: true,
                    content: {'application/json': {schema: selectSchema}},
                }},
                responses: recordResponse(z.object({
                    items: z.array(this.table.zodSchema.or(z.record(z.string(), z.unknown()))),
                    total: z.number().min(0).or(z.literal(-1)),
                })),
            }),
        })
        this.routes.push({
            handler: async(body: any, p?: any)=>await this.table.update(body),
            path: '/update',
            method: 'post',
            zod: ()=>({
                description: 'Update records',
                request: {body: {
                    required: true,
                    content: {'application/json': {schema: updateSchema}},
                }},
                responses: recordResponse(),
            }),
        })
        this.routes.push({
            handler: async(body: any, p?: any)=>await this.table.insert(body),
            path: '/insert',
            method: 'post',
            zod: ()=>({
                description: 'Update records',
                request: {body: {
                    required: true,
                    content: {'application/json': {schema: insertSchema}},
                }},
                responses: recordResponse(),
            }),
        })
        this.routes.push({
            handler: async(body: any, p?: any)=>await this.table.delete(body),
            path: '/delete',
            method: 'post',
            zod: ()=>({
                description: 'Update records',
                request: {body: {
                    required: true,
                    content: {'application/json': {schema: deleteSchema}},
                }},
                responses: recordResponse(),
            }),
        })
        if(this.table.fieldsUsage.record_uid) {
            this.routes.push({
                handler: async (body: any, p?: any) => await this.table.view(body, z.string().min(1).max(255).parse(p.id)),
                path: '/view/:id',
                method: 'get',
                zod: () => ({
                    description: 'View record',
                    request: {params: z.object({id: z.string().min(1).max(255)}), query: selectSchema.pick({select: true})},
                    responses: recordResponse(),
                }),
            })
        }
    }
}
