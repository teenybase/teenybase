import {TableExtension} from '../tableExtension'
import {z} from 'zod'
import {
    $Table,
    tableDeleteSchema,
    tableInsertSchema,
    tableSelectSchema,
    tableUpdateSchema,
    tableViewSchema
} from '../$Table'
import {JsepContext} from '../../sql/parse/jsep'
import {HTTPException} from 'hono/http-exception'

interface TableCrudExtensionData {
    name: 'crud'
}
const tableCrudExtensionDataSchema = z.object({})

export class TableCrudExtension extends TableExtension<TableCrudExtensionData> {
    static readonly name = 'crud'

    constructor(data: TableCrudExtensionData, table: $Table, jc: JsepContext) {
        super(data, table, jc)
        if (data.name !== TableCrudExtension.name) throw new HTTPException(500, {message: 'Invalid Configuration'})

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
                request: {query: tableSelectSchema},
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
                    content: {'application/json': {schema: tableSelectSchema}},
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
                request: {query: tableSelectSchema},
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
                    content: {'application/json': {schema: tableSelectSchema}},
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
                    content: {'application/json': {schema: tableUpdateSchema}},
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
                    content: {'application/json': {schema: tableInsertSchema}},
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
                    content: {'application/json': {schema: tableDeleteSchema}},
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
                    request: {params: z.object({id: z.string().min(1).max(255)}), query: tableViewSchema},
                    responses: recordResponse(),
                }),
            })
        }

    }
}
